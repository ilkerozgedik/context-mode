/**
 * db-base — Reusable SQLite infrastructure for context-mode packages.
 *
 * Provides lazy-loading of better-sqlite3, WAL pragma setup, prepared
 * statement caching interface, and DB file cleanup helpers. Both
 * ContentStore and SessionDB build on top of these primitives.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// v1.0.130 — `acquireDbLock` + `locking_mode = EXCLUSIVE` were REMOVED.
// See docs/adr/0001-sessiondb-multi-writer.md for the architectural
// rationale. The short version: SessionDB is multi-writer-safe and the
// process-identity invariants the lockfile tried to enforce belong in
// the process layer (sibling-mcp), not the DB layer. WAL + busy_timeout
// + withRetry handle the actual concurrency safely.

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/**
 * Explicit interface for cached prepared statements that accept varying
 * parameter counts. better-sqlite3's generic `Statement` collapses under
 * `ReturnType` to a single-param signature, so we define our own.
 */
export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

// ─────────────────────────────────────────────────────────
// SQLite driver
// ─────────────────────────────────────────────────────────

export function loadDatabase(): typeof Database {
  return Database;
}

// ─────────────────────────────────────────────────────────
// WAL setup
// ─────────────────────────────────────────────────────────

/**
 * Apply WAL mode and NORMAL synchronous pragma to a database instance.
 * Should be called immediately after opening a new database connection.
 *
 * WAL mode provides:
 * - Concurrent readers while a write is in progress
 * - Dramatically faster writes (no full-page sync on each commit)
 * NORMAL synchronous is safe under WAL and avoids an extra fsync per
 * transaction.
 */
export function applyWALPragmas(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Memory-map the DB file for read-heavy FTS5 search workloads.
  // Eliminates read() syscalls — the kernel serves pages directly from
  // the page cache. 256MB is a safe upper bound (SQLite only maps up to
  // the actual file size). Falls back gracefully on platforms where mmap
  // is unavailable or restricted.
  try { db.pragma("mmap_size = 268435456"); } catch { /* unsupported runtime */ }
  // NOTE: `locking_mode = EXCLUSIVE` is intentionally NOT applied here.
  // ALL DBs built on this helper — ContentStore (FTS5 shared knowledge
  // base) AND SessionDB (per-project events) — are multi-writer-safe by
  // contract. WAL + busy_timeout + the withRetry() wrapper below handle
  // SQLITE_BUSY natively. EXCLUSIVE locking is opt-out, never opt-in
  // from a base class shared by multi-writer consumers.
  // See docs/adr/0001-sessiondb-multi-writer.md for the v1.0.130 ADR.
}

// ─────────────────────────────────────────────────────────
// DB file helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove orphaned WAL/SHM files when the main DB file doesn't exist.
 * On Windows, stale -wal/-shm files from crashed processes cause
 * "file is not a database" errors when creating a fresh DB.
 */
export function cleanOrphanedWALFiles(dbPath: string): void {
  if (!existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  }
}

/**
 * Delete all three SQLite files for a given db path (main, WAL, SHM).
 * Silently ignores individual deletion errors so a partial cleanup
 * does not abort the rest.
 */
export function deleteDBFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // ignore — file may not exist
    }
  }
}

/**
 * Safely close a database connection. Swallows errors so callers can
 * always call this in a finally/cleanup path without try/catch.
 */
export function closeDB(db: DatabaseInstance): void {
  try {
    // Checkpoint WAL before close to prevent contention on restart (#103)
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch { /* WAL may not be active */ }
  try {
    db.close();
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────
// Default path helper
// ─────────────────────────────────────────────────────────

/**
 * Return the default per-process DB path for context-mode databases.
 * Uses the OS temp directory and embeds the current PID so multiple
 * server instances never share a file.
 */
export function defaultDBPath(prefix: string = "context-mode"): string {
  return join(tmpdir(), `${prefix}-${process.pid}.db`);
}

// ─────────────────────────────────────────────────────────
// Retry helper
// ─────────────────────────────────────────────────────────

/**
 * Retry a DB operation with exponential backoff on SQLITE_BUSY errors.
 * Catches errors containing "SQLITE_BUSY" or "database is locked" and
 * retries up to 3 times with delays: 100ms, 500ms, 2000ms.
 * If all retries fail, throws a descriptive error.
 * Pass custom delays for testing (e.g., [0, 0, 0] to skip waits).
 */
export function withRetry<T>(fn: () => T, delays: number[] = [100, 500, 2000]): T {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) {
        const delay = delays[attempt];
        const start = Date.now();
        while (Date.now() - start < delay) { /* busy-wait for sync retry */ }
      }
    }
  }
  throw new Error(
    `SQLITE_BUSY: database is locked after ${delays.length} retries. ` +
    `Original error: ${lastError?.message}`
  );
}

// ─────────────────────────────────────────────────────────
// Corrupt DB recovery (#244)
// ─────────────────────────────────────────────────────────

/**
 * Detect SQLite corruption errors that warrant a rename-and-recreate.
 * Matches SQLITE_CORRUPT, SQLITE_NOTADB, and their human-readable equivalents.
 */
export function isSQLiteCorruptionError(msg: string): boolean {
  return (
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database")
  );
}

/**
 * Rename a corrupt DB and its WAL/SHM files so a fresh DB can be created.
 * Best-effort — individual rename failures are silently ignored.
 */
export function renameCorruptDB(dbPath: string): void {
  const ts = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      renameSync(dbPath + suffix, `${dbPath}${suffix}.corrupt-${ts}`);
    } catch { /* file may not exist */ }
  }
}

// ─────────────────────────────────────────────────────────
// Base class
// ─────────────────────────────────────────────────────────

/**
 * SQLiteBase — minimal base class that handles open/close/cleanup lifecycle.
 *
 * Subclasses call `super(dbPath)` to open the database with WAL pragmas
 * applied, then implement `initSchema()` and `prepareStatements()`.
 *
 * The `db` getter exposes the raw `DatabaseInstance` to subclasses only.
 */
/**
 * Track all live DatabaseInstance objects so we can close them on process exit.
 * Prevents better-sqlite3 segfaults caused by V8 garbage-collecting Database
 * objects after the native addon context is already torn down.
 *
 * Uses a global symbol so the set and exit handler survive vitest's module
 * re-imports within the same fork process (ESM isolate mode clears
 * module-level state but globalThis persists).
 */
// v1.0.130 — symbol name bumped because the value type reverted from
// Map<DatabaseInstance, string> (v1.0.128 lockfile pairing) back to
// Set<DatabaseInstance>. A persistent global slot from a v1.0.128 or
// v1.0.129 module would deserialize as the wrong shape and crash the
// exit hook iteration.
const _kLiveDBs = Symbol.for("__context_mode_live_dbs_v3__");
const _liveDBs: Set<DatabaseInstance> = (() => {
  const g = globalThis as Record<symbol, Set<DatabaseInstance> | undefined>;
  if (!g[_kLiveDBs]) {
    g[_kLiveDBs] = new Set<DatabaseInstance>();
    process.on("exit", () => {
      for (const db of g[_kLiveDBs]!) {
        closeDB(db);
      }
      g[_kLiveDBs]!.clear();
    });
  }
  return g[_kLiveDBs]!;
})();

export abstract class SQLiteBase {
  readonly #dbPath: string;
  readonly #db: DatabaseInstance;

  /**
   * Open (or create) a SQLite DB at `dbPath`.
   *
   * v1.0.130 — multi-writer is the contract. ALL SQLiteBase consumers
   * (SessionDB, ContentStore) may open the same on-disk dbPath from
   * multiple processes simultaneously — that is the legitimate multi-
   * window UX shape and the WAL handles it natively. SQLITE_BUSY on
   * write contention is absorbed by `withRetry()` below (busy_timeout
   * = 30000ms inside `new Database(...)`).
   *
   * v1.0.128 introduced a single-writer guard here as a defense against
   * #560. That defense was an over-correction — the actual root causes
   * of #560 were #559 (zombie MCP child accumulation) and #561 (Pi
   * misdetection writing to the wrong DB path), both fixed in v1.0.128
   * + v1.0.129. The single-writer guard broke legitimate multi-window
   * users; v1.0.130 rolls it out. See
   * docs/adr/0001-sessiondb-multi-writer.md and the v1.0.130 INVARIANT
   * block in tests/util/db-base-platform-gate.test.ts for the
   * regression-proof anchor (source-pin + behavioural).
   */
  constructor(dbPath: string) {
    const Database = loadDatabase();
    this.#dbPath = dbPath;
    cleanOrphanedWALFiles(dbPath);
    let db: DatabaseInstance;
    try {
      db = new Database(dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        renameCorruptDB(dbPath);
        cleanOrphanedWALFiles(dbPath);
        try {
          db = new Database(dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after renaming corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    _liveDBs.add(this.#db);
    this.initSchema();
    this.prepareStatements();
  }

  /** Called once after WAL pragmas are applied. Subclasses run CREATE TABLE/VIRTUAL TABLE here. */
  protected abstract initSchema(): void;

  /** Called once after schema init. Subclasses compile and cache their prepared statements here. */
  protected abstract prepareStatements(): void;

  /** Raw database instance — available to subclasses only. */
  protected get db(): DatabaseInstance {
    return this.#db;
  }

  /** The path this database was opened from. */
  get dbPath(): string {
    return this.#dbPath;
  }

  /** Close the database connection without deleting files. */
  close(): void {
    _liveDBs.delete(this.#db);
    closeDB(this.#db);
  }

  protected withRetry<T>(fn: () => T): T {
    return withRetry(fn);
  }

  /**
   * Close the connection and delete all associated DB files (main, WAL, SHM).
   * Call on process exit or at end of session lifecycle.
   */
  cleanup(): void {
    _liveDBs.delete(this.#db);
    closeDB(this.#db);
    deleteDBFiles(this.#dbPath);
  }
}
