import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export function loadDatabase(): typeof Database {
  return Database;
}

export function applyWALPragmas(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  try { db.pragma("mmap_size = 268435456"); } catch {}
}

export function cleanOrphanedWALFiles(dbPath: string): void {
  if (existsSync(dbPath)) return;
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch {}
  }
}

export function deleteDBFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch {}
  }
}

export function closeDB(db: DatabaseInstance): void {
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.close(); } catch {}
}

export function withRetry<T>(fn: () => T, delays: number[] = [100, 500, 2000]): T {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw err;
      lastError = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) {
        const start = Date.now();
        while (Date.now() - start < delays[attempt]) {}
      }
    }
  }
  throw new Error(`SQLITE_BUSY: database is locked after ${delays.length} retries. Original error: ${lastError?.message}`);
}

export function isSQLiteCorruptionError(msg: string): boolean {
  return msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database");
}
