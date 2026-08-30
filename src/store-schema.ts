import type { Database as DatabaseInstance } from "better-sqlite3";
import type { PreparedStatement } from "./db-base.js";

export interface StoreStatements {
  stmtInsertSourceEmpty: PreparedStatement;
  stmtInsertSource: PreparedStatement;
  stmtInsertChunk: PreparedStatement;
  stmtInsertChunkTrigram: PreparedStatement;
  stmtInsertVocab: PreparedStatement;
  stmtDeleteChunksByLabel: PreparedStatement;
  stmtDeleteChunksTrigramByLabel: PreparedStatement;
  stmtDeleteSourcesByLabel: PreparedStatement;
  stmtSearchPorter: PreparedStatement;
  stmtSearchPorterFiltered: PreparedStatement;
  stmtSearchPorterExact: PreparedStatement;
  stmtSearchTrigram: PreparedStatement;
  stmtSearchTrigramFiltered: PreparedStatement;
  stmtSearchTrigramExact: PreparedStatement;
  stmtSearchPorterContentType: PreparedStatement;
  stmtSearchPorterFilteredContentType: PreparedStatement;
  stmtSearchPorterExactContentType: PreparedStatement;
  stmtSearchTrigramContentType: PreparedStatement;
  stmtSearchTrigramFilteredContentType: PreparedStatement;
  stmtSearchTrigramExactContentType: PreparedStatement;
  stmtFuzzyVocab: PreparedStatement;
  stmtChunksBySource: PreparedStatement;
  stmtSourceChunkCount: PreparedStatement;
  stmtChunkContent: PreparedStatement;
  stmtSourceMeta: PreparedStatement;
 }

export function initStoreSchema(db: DatabaseInstance): void {
    const existing = new Set((db.prepare(
      "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    const managedTables = ["sources", "chunks", "chunks_trigram"];
    if (managedTables.some((name) => existing.has(name))) {
      const required = new Map<string, string[]>([
        ["sources", ["id", "label", "chunk_count", "code_chunk_count", "indexed_at", "file_path", "content_hash"]],
        ["chunks", ["title", "content", "source_id", "content_type", "source_category", "timestamp"]],
        ["chunks_trigram", ["title", "content", "source_id", "content_type", "source_category", "timestamp"]],
      ]);
      for (const [table, columns] of required) {
        if (!existing.has(table)) {
          throw new Error(`Unsupported content store schema: missing ${table}; purge and reindex required`);
        }
        const actual = new Set((db.prepare(`PRAGMA table_xinfo('${table}')`).all() as Array<{ name: string }>).map((row) => row.name));
        if (columns.some((column) => !actual.has(column))) {
          throw new Error(`Unsupported content store schema in ${table}; purge and reindex required`);
        }
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_path TEXT,
        content_hash TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        timestamp UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        timestamp UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);
}

export function prepareStoreStatements(db: DatabaseInstance): StoreStatements {
    // Write path
    const stmtInsertSourceEmpty = db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, 0, 0, ?, ?)",
    );
    const stmtInsertSource = db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
    );
    const stmtInsertChunk = db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type, source_category, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const stmtInsertChunkTrigram = db.prepare(
      "INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const stmtInsertVocab = db.prepare(
      "INSERT OR IGNORE INTO vocabulary (word) VALUES (?)",
    );

    // Dedup path: delete previous source with same label before re-indexing
    // Prevents stale outputs from accumulating in iterative workflows (build-fix-build)
    const stmtDeleteChunksByLabel = db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    const stmtDeleteChunksTrigramByLabel = db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    const stmtDeleteSourcesByLabel = db.prepare(
      "DELETE FROM sources WHERE label = ?",
    );

    // Search path (hot)
    const stmtSearchPorter = db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchPorterFiltered = db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchPorterExact = db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchTrigram = db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchTrigramFiltered = db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchTrigramExact = db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Content-type filtered variants
    const stmtSearchPorterContentType = db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchPorterFilteredContentType = db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchPorterExactContentType = db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchTrigramContentType = db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchTrigramFilteredContentType = db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    const stmtSearchTrigramExactContentType = db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Fuzzy path
    const stmtFuzzyVocab = db.prepare(
      "SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?",
    );

    // Read path
    const stmtChunksBySource = db.prepare(
      `SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ?
       ORDER BY c.rowid`,
    );
    const stmtSourceChunkCount = db.prepare(
      "SELECT chunk_count FROM sources WHERE id = ?",
    );
    const stmtChunkContent = db.prepare(
      "SELECT content FROM chunks WHERE source_id = ?",
    );
    const stmtSourceMeta = db.prepare(
      "SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash FROM sources WHERE label = ?",
    );
  return {
    stmtInsertSourceEmpty,
    stmtInsertSource,
    stmtInsertChunk,
    stmtInsertChunkTrigram,
    stmtInsertVocab,
    stmtDeleteChunksByLabel,
    stmtDeleteChunksTrigramByLabel,
    stmtDeleteSourcesByLabel,
    stmtSearchPorter,
    stmtSearchPorterFiltered,
    stmtSearchPorterExact,
    stmtSearchTrigram,
    stmtSearchTrigramFiltered,
    stmtSearchTrigramExact,
    stmtSearchPorterContentType,
    stmtSearchPorterFilteredContentType,
    stmtSearchPorterExactContentType,
    stmtSearchTrigramContentType,
    stmtSearchTrigramFilteredContentType,
    stmtSearchTrigramExactContentType,
    stmtFuzzyVocab,
    stmtChunksBySource,
    stmtSourceChunkCount,
    stmtChunkContent,
    stmtSourceMeta
  };
}
