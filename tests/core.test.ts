import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes, getAvailableLanguages, isAllowlistedShell } from "../src/runtime.js";
import { isPathInsideProject } from "../src/security.js";
import { ContentStore } from "../src/store.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "context-mode-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runtime and executor", () => {
  test("detects a usable JavaScript runtime and shell", () => {
    const runtimes = detectRuntimes();
    expect(runtimes.javascript).toBeTruthy();
    expect(runtimes.shell).toBeTruthy();
    expect(getAvailableLanguages(runtimes)).toEqual(
      runtimes.python ? ["javascript", "shell", "python"] : ["javascript", "shell"],
    );
    expect(isAllowlistedShell(runtimes.shell)).toBe(true);
  });

  test("executes JavaScript in the project root", async () => {
    const executor = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    try {
      const result = await executor.execute({
        language: "javascript",
        code: 'console.log("core-smoke")',
        timeout: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("core-smoke");
    } finally {
      executor.cleanupProcesses();
    }
  });
});

describe("security", () => {
  test("project containment rejects parent traversal", () => {
    const root = tempDir();
    expect(isPathInsideProject("inside.txt", root)).toBe(true);
    expect(isPathInsideProject("../parent.txt", root)).toBe(false);
  });
});

describe("persistent core", () => {
  test("rejects unsupported legacy store schemas instead of mutating them", () => {
    const dir = tempDir();
    const dbPath = join(dir, "legacy.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE chunks USING fts5(
        title, content, source_id UNINDEXED, content_type UNINDEXED,
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE chunks_trigram USING fts5(
        title, content, source_id UNINDEXED, content_type UNINDEXED,
        tokenize='trigram'
      );
    `);
    db.close();

    expect(() => new ContentStore(dbPath)).toThrow(/unsupported.*schema|purge.*reindex/i);

    const verify = new Database(dbPath, { readonly: true });
    try {
      const chunkColumns = (verify.prepare("PRAGMA table_xinfo('chunks')").all() as Array<{ name: string }>).map((row) => row.name);
      const sourceColumns = (verify.prepare("PRAGMA table_info('sources')").all() as Array<{ name: string }>).map((row) => row.name);
      expect(chunkColumns).not.toContain("source_category");
      expect(sourceColumns).not.toContain("file_path");
    } finally {
      verify.close();
    }
  });

  test("indexes and searches content with FTS5", () => {
    const dir = tempDir();
    const store = new ContentStore(join(dir, "content.db"));
    try {
      const indexed = store.index({
        content: "# Alpha\n\nA unique context-mode needle.",
        source: "core-test",
      });
      expect(indexed.totalChunks).toBeGreaterThan(0);
      const results = store.searchWithFallback("unique needle", 3, "core-test");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.content).toContain("unique context-mode needle");
    } finally {
      store.cleanup();
    }
  });


});
