import type { Database as DatabaseInstance } from "better-sqlite3";
import type { StoreStatements } from "./store-schema.js";
import { STOPWORDS } from "./store-query.js";
import type { SearchResult } from "./types.js";

export function getSourceMeta(
  statements: StoreStatements,
  label: string,
): { label: string; chunkCount: number; codeChunkCount: number; indexedAt: string; filePath: string | null; contentHash: string | null } | null {
  const row = statements.stmtSourceMeta.get(label) as {
    label: string;
    chunk_count: number;
    code_chunk_count: number;
    indexed_at: string;
    file_path: string | null;
    content_hash: string | null;
  } | undefined;
  if (!row) return null;
  return {
    label: row.label,
    chunkCount: row.chunk_count,
    codeChunkCount: row.code_chunk_count,
    indexedAt: row.indexed_at,
    filePath: row.file_path ?? null,
    contentHash: row.content_hash ?? null,
  };
}

export function getChunksBySource(statements: StoreStatements, sourceId: number): SearchResult[] {
  const rows = statements.stmtChunksBySource.all(sourceId) as Array<{
    title: string;
    content: string;
    content_type: string;
    label: string;
  }>;
  return rows.map((row) => ({
    title: row.title,
    content: row.content,
    source: row.label,
    rank: 0,
    contentType: row.content_type as "code" | "prose",
  }));
}

export function getDistinctiveTerms(
  statements: StoreStatements,
  sourceId: number,
  maxTerms: number = 40,
): string[] {
  const stats = statements.stmtSourceChunkCount.get(sourceId) as { chunk_count: number } | undefined;
  if (!stats || stats.chunk_count < 3) return [];

  const totalChunks = stats.chunk_count;
  const minAppearances = 2;
  const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));
  const docFreq = new Map<string, number>();

  for (const row of statements.stmtChunkContent.iterate(sourceId) as Iterable<{ content: string }>) {
    const words = new Set(
      row.content
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    );
    for (const word of words) docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
  }

  return Array.from(docFreq.entries())
    .filter(([, count]) => count >= minAppearances && count <= maxAppearances)
    .map(([word, count]) => {
      const idf = Math.log(totalChunks / count);
      const lenBonus = Math.min(word.length / 20, 0.5);
      const identifierBonus = /_/.test(word) ? 1.5 : word.length >= 12 ? 0.8 : 0;
      return { word, score: idf + lenBonus + identifierBonus };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTerms)
    .map(({ word }) => word);
}

export function isStoreEmpty(db: DatabaseInstance): boolean {
  return db.prepare("SELECT 1 FROM chunks LIMIT 1").get() === undefined;
}

export function optimizeFTS(db: DatabaseInstance): void {
  try {
    db.exec("INSERT INTO chunks(chunks) VALUES('optimize')");
    db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')");
  } catch { /* best effort */ }
}

export function extractAndStoreVocabulary(
  db: DatabaseInstance,
  statements: StoreStatements,
  content: string,
): boolean {
  const words = content
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  const unique = [...new Set(words)];
  let inserted = 0;
  db.transaction(() => {
    for (const word of unique) {
      const info = statements.stmtInsertVocab.run(word);
      inserted += info.changes;
    }
  })();
  return inserted > 0;
}
