/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas, closeDB, cleanOrphanedWALFiles, withRetry, quarantineDBFiles, isSQLiteCorruptionError } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import { readFileSync, unlinkSync, existsSync, statSync, openSync, fstatSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkDirectoryDetailed, type WalkOptions } from "./store-directory.js";
import { initStoreSchema, prepareStoreStatements, type StoreStatements } from "./store-schema.js";
import { StoreSearchEngine } from "./store-search.js";
import {
  extractAndStoreVocabulary,
  getChunksBySource as readChunksBySource,
  getDistinctiveTerms as readDistinctiveTerms,
  getSourceMeta as readSourceMeta,
  isStoreEmpty,
  optimizeFTS,
} from "./store-read.js";
import {
  MAX_CHUNK_BYTES,
  byteCappedPrefix,
  chunkMarkdown,
  chunkPlainText,
  enforceChunkByteLimit,
  walkJSON,
  type Chunk,
} from "./store-chunking.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

import type { IndexResult, SearchResult } from "./types.js";
export type { IndexResult, SearchResult } from "./types.js";
export { sanitizeQuery, sanitizeTrigramQuery } from "./store-query.js";

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const MAX_INDEX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_VOCABULARY_BYTES = 1024 * 1024;

// When byte-splitting an oversized single line, prefer to break at a whitespace
// boundary for readability — but only if that boundary is past this fraction of
// the slice, otherwise we'd waste too much of the byte budget.

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

export class ContentStore {
  #db: DatabaseInstance;
  #dbPath: string;
  // Optional deny-policy callback. When set (by server.ts at startup),
  // #refreshStaleSources consults it before re-reading file_path during
  // auto-refresh. This catches policy edits between initial indexing and
  // a later search: a file that was allowed at index time may have been
  // added to the Read deny list afterwards. Without this hook, refresh
  // would re-read and re-expose the file. See #442 round-3.
  #denyChecker?: (filePath: string) => boolean;

  // ── Cached Prepared Statements ──
  // Prepared once at construction, reused on every call to avoid
  // re-compiling SQL on each invocation.

  // Write/delete path used directly by ContentStore. Search/read helpers own
  // the remaining prepared statements through #statements.
  #stmtInsertSourceEmpty!: PreparedStatement;
  #stmtInsertSource!: PreparedStatement;
  #stmtInsertChunk!: PreparedStatement;
  #stmtInsertChunkTrigram!: PreparedStatement;
  #stmtDeleteChunksByLabel!: PreparedStatement;
  #stmtDeleteChunksTrigramByLabel!: PreparedStatement;
  #stmtDeleteSourcesByLabel!: PreparedStatement;


  // FTS5 optimization: track inserts and optimize periodically to defragment
  // the index. FTS5 b-trees fragment over many insert/delete cycles, degrading
  // search performance. SQLite's built-in 'optimize' merges b-tree segments.
  #insertCount = 0;
  static readonly OPTIMIZE_EVERY = 50;

  #searchEngine!: StoreSearchEngine;
  #statements!: StoreStatements;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.#dbPath =
      dbPath ?? join(tmpdir(), `context-mode-${process.pid}.db`);
    cleanOrphanedWALFiles(this.#dbPath);
    let db: DatabaseInstance;
    try {
      db = new Database(this.#dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        const quarantinePath = quarantineDBFiles(this.#dbPath);
        cleanOrphanedWALFiles(this.#dbPath);
        try {
          db = new Database(this.#dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after quarantining corrupt file at ${quarantinePath}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    initStoreSchema(this.#db);
    const statements = prepareStoreStatements(this.#db);
    this.#statements = statements;
    this.#stmtInsertSourceEmpty = statements.stmtInsertSourceEmpty;
    this.#stmtInsertSource = statements.stmtInsertSource;
    this.#stmtInsertChunk = statements.stmtInsertChunk;
    this.#stmtInsertChunkTrigram = statements.stmtInsertChunkTrigram;
    this.#stmtDeleteChunksByLabel = statements.stmtDeleteChunksByLabel;
    this.#stmtDeleteChunksTrigramByLabel = statements.stmtDeleteChunksTrigramByLabel;
    this.#stmtDeleteSourcesByLabel = statements.stmtDeleteSourcesByLabel;
    this.#searchEngine = new StoreSearchEngine(statements, () => this.#refreshStaleSources());
  }

  /** Delete this session's DB files. Call on process exit. */
  cleanup(): void {
    try {
      this.#db.close();
    } catch { /* ignore */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(this.#dbPath + suffix); } catch { /* ignore */ }
    }
  }

  // ── Schema ──

  // ── Deny Policy Hook ──

  /**
   * Register a deny-policy checker. When set, #refreshStaleSources
   * calls it before re-reading any file_path during auto-refresh.
   * Returning `true` removes the persisted source before search results are read.
   */
  setDenyChecker(fn: ((filePath: string) => boolean) | undefined): void {
    this.#denyChecker = fn;
    this.#refreshCheckedThisTurn = false;
  }

  // ── Index ──

  index(options: {
    content?: string;
    path?: string;
    source?: string;
  }): IndexResult {
    const { content, path, source } = options;

    // Treat empty string as "no content" so an empty `content` paired with a
    // valid `path` falls back to reading the file. Some MCP clients
    // materialize optional string fields as `""` and the previous
    // `content ?? readFileSync(path)` kept the empty string, indexing 0
    // chunks. See issue #350.
    const hasContent = typeof content === "string" && content.length > 0;

    if (!hasContent && !path) {
      throw new Error("Either content or path must be provided");
    }

    // Read file via fd to close the TOCTOU window between the security
    // gate (security.ts evaluateFilePath calls realpathSync) and the read
    // here. Lexical re-read by path string allowed an attacker to swap a
    // symlink to a denied target (e.g. ~/.ssh/id_rsa) AFTER gate passed.
    // openSync + fstat + readFileSync(fd) binds the read to the inode
    // captured at gate-time. fstat also rejects non-regular files
    // (directories, character devices) which would otherwise read as ""
    // or throw inconsistently. See #442 round-3.
    const label = source ?? path ?? "untitled";
    let text: string;
    if (hasContent) {
      text = content!;
      if (Buffer.byteLength(text) > MAX_INDEX_INPUT_BYTES) {
        throw new Error(`input too large for ${label}: exceeds 8MB safety limit`);
      }
    } else {
      const fd = openSync(path!, "r");
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
          throw new Error(`refusing to index ${path}: not a regular file`);
        }
        if (st.size > MAX_INDEX_INPUT_BYTES) {
          throw new Error(`input too large for ${label}: exceeds 8MB safety limit`);
        }
        text = readFileSync(fd, "utf-8");
        if (Buffer.byteLength(text) > MAX_INDEX_INPUT_BYTES) {
          throw new Error(`input too large for ${label}: exceeds 8MB safety limit`);
        }
      } finally {
        closeSync(fd);
      }
    }
    const chunks = chunkMarkdown(text);

    // Stale detection: store file_path + SHA-256 for file-backed sources
    const filePath = path ?? undefined;
    const contentHash = filePath ? createHash("sha256").update(text).digest("hex") : undefined;

    return withRetry(() => this.#insertChunks(chunks, label, text, filePath, contentHash));
  }

  // ── Index Directory (#687) ──

  /**
   * Index every file under a directory by walking it with `walkDirectory` and
   * delegating each discovered file to `this.index({ path })`. The per-file
   * `openSync + fstatSync.isFile()` security gate at line ~845 stays active
   * for every file — directory support never bypasses the TOCTOU defense
   * from #442 round-3.
   *
   */
  indexDirectory(opts: {
    path: string;
    source?: string;
    /** Optional per-file deny check — runs INSIDE the walk loop so a denied
     *  file does not even open a fd. Returns true to deny. */
    perFileDeny?: (absPath: string) => boolean;
  } & WalkOptions): {
    filesIndexed: number;
    totalChunks: number;
    capped: boolean;
    totalSeen: number;
    denied: number;
    failed: number;
    label: string;
  } {
    const { path: rootPath, source, perFileDeny, ...walkOpts } = opts;
    const walked = walkDirectoryDetailed(rootPath, walkOpts);

    let filesIndexed = 0;
    let totalChunks = 0;
    let denied = 0;
    let failed = 0;

    for (const file of walked.files) {
      if (perFileDeny && perFileDeny(file)) {
        denied++;
        continue;
      }
      try {
        // Per-file source label so ctx_search(source: "<file>") still works.
        const fileSource = source ? `${source}:${file}` : file;
        const r = this.index({ path: file, source: fileSource });
        filesIndexed++;
        totalChunks += r.totalChunks;
      } catch {
        // Per-file failure (e.g. fd-bound fstat rejection of a non-regular
        // file that races between walk and read) — count + continue.
        failed++;
      }
    }

    return {
      filesIndexed,
      totalChunks,
      capped: walked.capped,
      totalSeen: walked.totalSeen,
      denied,
      failed,
      label: source ?? rootPath,
    };
  }

  // ── Index Plain Text ──

  /**
   * Index plain-text output (logs, build output, test results) by splitting
   * into fixed-size line groups. Unlike markdown indexing, this does not
   * look for headings — it chunks by line count with overlap.
   */
  indexPlainText(
    content: string,
    source: string,
    linesPerChunk: number = 20,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.#insertChunks([], source, "");
    }

    const chunks = chunkPlainText(content, linesPerChunk, maxChunkBytes);

    return withRetry(() => this.#insertChunks(
      chunks.map((c) => ({ ...c, hasCode: false })),
      source,
      content,
      undefined,
      undefined,
    ));
  }

  // ── Index JSON ──

  /**
   * Index JSON content by walking the object tree and using key paths
   * as chunk titles (analogous to heading hierarchy in markdown). Objects
   * recurse by key; arrays batch items by size.
   *
   * Falls back to `indexPlainText` if the content is not valid JSON.
   */
  indexJSON(
    content: string,
    source: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.indexPlainText("", source, undefined, maxChunkBytes);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.indexPlainText(content, source, undefined, maxChunkBytes);
    }

    const chunks: Chunk[] = [];
    walkJSON(parsed, [], chunks, maxChunkBytes);

    if (chunks.length === 0) {
      return this.indexPlainText(content, source, undefined, maxChunkBytes);
    }

    return withRetry(() => this.#insertChunks(chunks, source, content));
  }

  // ── Shared DB Insertion ──

  /**
   * Shared DB insertion logic for all index methods. Inserts chunks
   * into both FTS5 tables within a transaction and extracts vocabulary.
   * Uses cached prepared statements from #prepareStatements().
   */
  #insertChunks(
    chunks: Chunk[],
    label: string,
    text: string,
    filePath?: string,
    contentHash?: string,
  ): IndexResult {
    const boundedChunks = enforceChunkByteLimit(chunks);
    const codeChunks = boundedChunks.filter((c) => c.hasCode).length;

    // Atomic dedup + insert: delete previous source with same label,
    // then insert new content — all within a single transaction.
    // Prevents stale results in iterative workflows. (See: GitHub issue #67)
    const transaction = this.#db.transaction(() => {
      this.#deleteSourceRows(label);

      if (boundedChunks.length === 0) {
        const info = this.#stmtInsertSourceEmpty.run(label, filePath ?? null, contentHash ?? null);
        return Number(info.lastInsertRowid);
      }

      const info = this.#stmtInsertSource.run(label, boundedChunks.length, codeChunks, filePath ?? null, contentHash ?? null);
      const sourceId = Number(info.lastInsertRowid);

      const now = new Date().toISOString();
      for (const chunk of boundedChunks) {
        const ct = chunk.hasCode ? "code" : "prose";
        this.#stmtInsertChunk.run(chunk.title, chunk.content, sourceId, ct, null, now);
        this.#stmtInsertChunkTrigram.run(chunk.title, chunk.content, sourceId, ct, null, now);
      }

      return sourceId;
    });

    const sourceId = transaction();
    if (text) this.#extractAndStoreVocabulary(byteCappedPrefix(text, MAX_VOCABULARY_BYTES));

    // Periodically optimize FTS5 indexes to merge b-tree segments.
    // Fragmentation accumulates over insert/delete cycles (dedup re-indexes
    // every source on update). The 'optimize' command merges segments into
    // a single b-tree, improving search latency for long-running sessions.
    this.#insertCount++;
    if (this.#insertCount % ContentStore.OPTIMIZE_EVERY === 0) {
      optimizeFTS(this.#db);
    }

    return {
      sourceId,
      label,
      totalChunks: boundedChunks.length,
      codeChunks,
    };
  }

  // ── Search ──

  search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: "like" | "exact" = "like",
  ): SearchResult[] {
    return this.#searchEngine.search(query, limit, source, mode, contentType, sourceMatchMode);
  }

  searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: "like" | "exact" = "like",
  ): SearchResult[] {
    return this.#searchEngine.searchTrigram(query, limit, source, mode, contentType, sourceMatchMode);
  }

  fuzzyCorrect(query: string): string | null {
    return this.#searchEngine.fuzzyCorrect(query);
  }

  searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: "like" | "exact" = "like",
  ): SearchResult[] {
    return this.#searchEngine.searchWithFallback(query, limit, source, contentType, sourceMatchMode);
  }

  /** Number of sources auto-refreshed in the last searchWithFallback call. */
  lastRefreshCount = 0;
  #refreshCheckedThisTurn = false;

  #deleteSourceRows(label: string): void {
    this.#stmtDeleteChunksByLabel.run(label);
    this.#stmtDeleteChunksTrigramByLabel.run(label);
    this.#stmtDeleteSourcesByLabel.run(label);
  }

  /**
   * Check all file-backed sources for staleness and auto re-index changed files.
   * Uses mtime as a fast gate — only computes SHA-256 when mtime has advanced
   * past indexed_at. Gracefully skips deleted files and non-file sources.
   */
  #refreshStaleSources(): void {
    if (this.#refreshCheckedThisTurn) return;
    this.#refreshCheckedThisTurn = true;
    queueMicrotask(() => { this.#refreshCheckedThisTurn = false; });

    this.lastRefreshCount = 0;
    const sources = this.#db.prepare(
      "SELECT label, file_path, content_hash, indexed_at FROM sources WHERE file_path IS NOT NULL",
    ).all() as Array<{ label: string; file_path: string; content_hash: string; indexed_at: string }>;

    for (const src of sources) {
      try {
        // Re-check deny policy before any filesystem fast path. A previously
        // indexed file may have been deleted before the policy changed; its
        // persisted chunks must still be revoked when the path becomes denied.
        if (this.#denyChecker && this.#denyChecker(src.file_path)) {
          this.#db.transaction(() => this.#deleteSourceRows(src.label))();
          this.#searchEngine.clearFuzzyCache();
          continue;
        }
        if (!existsSync(src.file_path)) continue; // deleted but still allowed — keep cached results
        const mtime = statSync(src.file_path).mtime;
        const indexedAt = new Date(src.indexed_at + "Z");
        if (mtime <= indexedAt) continue; // file unchanged — fast path

        // mtime advanced — fd-bound read for hash + indexing in one go.
        // Open once, fstat, read from fd. Closes the swap-mid-flight
        // window between hash read and re-index. #442 round-3.
        const fd = openSync(src.file_path, "r");
        let newContent: string;
        try {
          const st = fstatSync(fd);
          if (!st.isFile()) continue; // skip non-regular targets
          if (st.size > MAX_INDEX_INPUT_BYTES) continue; // keep cached result; never read oversized refreshes
          newContent = readFileSync(fd, "utf-8");
        } finally {
          closeSync(fd);
        }
        const newHash = createHash("sha256").update(newContent).digest("hex");
        if (newHash === src.content_hash) continue; // content identical — skip

        // File genuinely changed — re-index using already-read content
        // (avoids a second open/read race) but preserve file_path/hash
        // by going through index() which stores them. Since we pass
        // content, index() does NOT re-read; the bytes hashed above
        // are exactly the bytes indexed.
        this.index({ content: newContent, path: src.file_path, source: src.label });
        this.lastRefreshCount++;
      } catch {
        // Graceful degradation — never break search for stale detection
      }
    }
  }

  // ── Sources / vocabulary ──

  getSourceMeta(label: string) {
    return readSourceMeta(this.#statements, label);
  }

  getChunksBySource(sourceId: number): SearchResult[] {
    return readChunksBySource(this.#statements, sourceId);
  }

  getDistinctiveTerms(sourceId: number, maxTerms: number = 40): string[] {
    return readDistinctiveTerms(this.#statements, sourceId, maxTerms);
  }

  isEmpty(): boolean {
    return isStoreEmpty(this.#db);
  }

  close(): void {
    optimizeFTS(this.#db);
    closeDB(this.#db);
  }

  #extractAndStoreVocabulary(content: string): void {
    if (extractAndStoreVocabulary(this.#db, this.#statements, content)) {
      this.#searchEngine.clearFuzzyCache();
    }
  }

}
