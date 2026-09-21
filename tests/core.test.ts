import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes, getAvailableLanguages, isAllowlistedShell } from "../src/runtime.js";
import { evaluateFilePath, isPathInsideProject, readToolDenyPatterns } from "../src/security.js";
import { createPerFileReadDeny } from "../src/tools/security.js";
import { ContentStore } from "../src/store.js";
import { buildFetchCode, readResponseTextWithLimit } from "../src/fetch.js";

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

  test("fails closed when an existing permission settings file is malformed", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), "{");
    expect(() => readToolDenyPatterns("Read", root)).toThrow(/settings|json|parse/i);
  });

  test("Read deny matching remains case-insensitive on macOS callers", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(Secret.txt)"] } }));
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...original, value: "darwin" });
      const denied = createPerFileReadDeny(root);
      expect(denied(join(root, "secret.txt"))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
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

  test("prefers chunks matching all query terms before relaxed partial matches", () => {
    const dir = tempDir();
    const store = new ContentStore(join(dir, "precision.db"));
    try {
      store.index({ content: "# Exact\n\nalpha target together", source: "exact" });
      store.index({ content: "# Partial\n\nalpha only", source: "partial" });

      const exact = store.searchWithFallback("alpha target", 2);
      expect(exact).toHaveLength(1);
      expect(exact[0]?.source).toBe("exact");

      const relaxed = store.searchWithFallback("alpha missing", 2);
      expect(relaxed.length).toBeGreaterThan(0);
      expect(relaxed.some((result) => result.source === "partial")).toBe(true);
    } finally {
      store.close();
    }
  });


});



describe("file-backed store refresh", () => {
  test("removes previously indexed content when the Read deny policy changes", async () => {
    const dir = tempDir();
    const filePath = join(dir, "secret.txt");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(filePath, "policy_secret_94731");
    const store = new ContentStore(join(dir, "deny.db"));
    store.setDenyChecker((path) =>
      evaluateFilePath(path, readToolDenyPatterns("Read", dir), false, dir).denied,
    );
    try {
      store.index({ path: filePath, source: "secret-source" });
      expect(store.searchWithFallback("policy_secret_94731", 3)).toHaveLength(1);
      await Promise.resolve();

      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Read(secret.txt)"] } }),
      );
      expect(store.searchWithFallback("policy_secret_94731", 3)).toHaveLength(0);
      expect(store.getSourceMeta("secret-source")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("revokes persisted content after the indexed file is deleted and then denied", async () => {
    const dir = tempDir();
    const filePath = join(dir, "deleted-secret.txt");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(filePath, "deleted_policy_secret_58317");
    const store = new ContentStore(join(dir, "deleted-deny.db"));
    store.setDenyChecker((path) =>
      evaluateFilePath(path, readToolDenyPatterns("Read", dir), false, dir).denied,
    );
    try {
      store.index({ path: filePath, source: "deleted-secret-source" });
      expect(store.searchWithFallback("deleted_policy_secret_58317", 3)).toHaveLength(1);
      await Promise.resolve();

      rmSync(filePath);
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Read(deleted-secret.txt)"] } }),
      );
      expect(store.searchWithFallback("deleted_policy_secret_58317", 3)).toHaveLength(0);
      expect(store.getSourceMeta("deleted-secret-source")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("refreshes file metadata once per synchronous search batch", async () => {
    const dir = tempDir();
    const first = join(dir, "first.txt");
    const second = join(dir, "second.txt");
    writeFileSync(first, "alpha refresh marker");
    writeFileSync(second, "beta refresh marker");
    const store = new ContentStore(join(dir, "refresh.db"));
    try {
      store.index({ path: first, source: "first" });
      store.index({ path: second, source: "second" });
      let checks = 0;
      store.setDenyChecker(() => { checks += 1; return false; });

      store.searchWithFallback("alpha", 3);
      store.searchWithFallback("beta", 3);
      expect(checks).toBe(2);

      await Promise.resolve();
      store.searchWithFallback("alpha", 3);
      expect(checks).toBe(4);
    } finally {
      store.close();
    }
  });
});

describe("bounded fetch body reader", () => {
  test("rejects oversized declared content before reading the body", async () => {
    const response = new Response("abc", { headers: { "content-length": "10" } });
    await expect(readResponseTextWithLimit(response, 5)).rejects.toThrow(/Content-Length 10 exceeds 5/);
  });

  test("stops a chunked response as soon as the byte cap is crossed", async () => {
    let cancelled = false;
    const chunks = [new Uint8Array(4), new Uint8Array(4)];
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { cancelled = true; },
    }));

    await expect(readResponseTextWithLimit(response, 5)).rejects.toThrow(/8 bytes exceeds 5/);
    expect(cancelled).toBe(true);
  });

  test("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const bytes = new TextEncoder().encode("🙂");
    await expect(readResponseTextWithLimit(new Response(bytes), 3)).rejects.toThrow(/4 bytes exceeds 3/);
    await expect(readResponseTextWithLimit(new Response(bytes), 4)).resolves.toBe("🙂");
  });

  test("embeds the production byte limit explicitly in fetch subprocess code", () => {
    const code = buildFetchCode("https://example.com", "/tmp/context-mode-fetch-test");
    expect(code).toContain("resp, 52428800");
    expect(code).toContain("getReader()");
    expect(code).not.toContain("await resp.text()");
  });
});
