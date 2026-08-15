import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyglotExecutor } from "../src/executor.js";
import { REGISTERED_CTX_TOOLS, withProjectDirOverride } from "../src/server.js";
import { ContentStore } from "../src/store.js";

describe("resource guards", () => {
  test("caps default child output before it can buffer unbounded data", async () => {
    const executor = new PolyglotExecutor({ projectRoot: process.cwd() });
    const result = await executor.execute({
      language: "javascript",
      code: 'process.stdout.write("x".repeat(9_000_000));',
    });

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.stderr).toContain("output capped at 8MB");
  });

  test("never persists a Markdown chunk larger than 4096 bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "context-mode-resource-"));
    const store = new ContentStore(join(dir, "content.db"));
    try {
      const result = store.index({
        content: `# Large paragraph\n\n${"x".repeat(12_000)}`,
        source: "large-markdown",
      });
      const chunks = store.getChunksBySource(result.sourceId);

      expect(chunks.length).toBeGreaterThan(1);
      expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk.content)))).toBeLessThanOrEqual(4096);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caps batch indexing independently from execution capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-batch-"));
    const storage = mkdtempSync(join(tmpdir(), "context-mode-batch-storage-"));
    const previousStorage = process.env.CONTEXT_MODE_DIR;
    process.env.CONTEXT_MODE_DIR = storage;

    const batch = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_batch_execute");
    const purge = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_purge");
    expect(batch).toBeDefined();
    expect(purge).toBeDefined();

    try {
      const result = await withProjectDirOverride(root, () =>
        batch!.handler({
          commands: [{ label: "large", command: "node -e \"process.stdout.write('batch_marker '.repeat(400000))\"" }],
          queries: ["batch_marker"],
          timeout: 30000,
          concurrency: 1,
          query_scope: "batch",
          cwd: root,
        }),
      ) as { isError?: boolean; content: Array<{ text: string }> };
      const text = result.content.map((part) => part.text).join("\\n");

      expect(result.isError).not.toBe(true);
      expect(text).toContain("output capped at 4MB before indexing");
      expect(text.toLowerCase()).not.toContain("heap out of memory");
    } finally {
      await withProjectDirOverride(root, () => purge!.handler({ confirm: true }));
      if (previousStorage === undefined) delete process.env.CONTEXT_MODE_DIR;
      else process.env.CONTEXT_MODE_DIR = previousStorage;
      rmSync(root, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  test("serializes project-scoped calls across concurrent projects", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "context-mode-concurrent-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "context-mode-concurrent-b-"));
    const storage = mkdtempSync(join(tmpdir(), "context-mode-concurrent-storage-"));
    const previousStorage = process.env.CONTEXT_MODE_DIR;
    process.env.CONTEXT_MODE_DIR = storage;

    const batch = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_batch_execute");
    const purge = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_purge");
    expect(batch).toBeDefined();
    expect(purge).toBeDefined();

    const run = (root: string, marker: string) => withProjectDirOverride(root, () =>
      batch!.handler({
        commands: [{ label: marker, command: `printf ${marker}` }],
        queries: [marker],
        timeout: 30000,
        concurrency: 1,
        query_scope: "batch",
        cwd: root,
      }),
    );

    try {
      const results = await Promise.all([run(rootA, "PROJECT_A_CONCURRENT"), run(rootB, "PROJECT_B_CONCURRENT")]) as Array<{ isError?: boolean }>;
      expect(results.every((result) => result.isError !== true)).toBe(true);
    } finally {
      await withProjectDirOverride(rootA, () => purge!.handler({ confirm: true }));
      await withProjectDirOverride(rootB, () => purge!.handler({ confirm: true }));
      if (previousStorage === undefined) delete process.env.CONTEXT_MODE_DIR;
      else process.env.CONTEXT_MODE_DIR = previousStorage;
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  test("switches the active content store when the project changes", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "context-mode-project-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "context-mode-project-b-"));
    const storage = mkdtempSync(join(tmpdir(), "context-mode-storage-"));
    const previousStorage = process.env.CONTEXT_MODE_DIR;
    process.env.CONTEXT_MODE_DIR = storage;

    const index = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_index");
    const search = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_search");
    const purge = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_purge");
    expect(index).toBeDefined();
    expect(search).toBeDefined();
    expect(purge).toBeDefined();

    try {
      await withProjectDirOverride(rootA, () =>
        index!.handler({ content: "PROJECT_A_ONLY", source: "project-a" }),
      );
      await withProjectDirOverride(rootB, () =>
        index!.handler({ content: "PROJECT_B_ONLY", source: "project-b" }),
      );

      const fromB = await withProjectDirOverride(rootB, () =>
        search!.handler({ queries: ["PROJECT_A_ONLY"] }),
      ) as { content: Array<{ text: string }> };
      const fromA = await withProjectDirOverride(rootA, () =>
        search!.handler({ queries: ["PROJECT_A_ONLY"] }),
      ) as { content: Array<{ text: string }> };

      expect(fromB.content[0]?.text).not.toContain("--- [project-a");
      expect(fromA.content[0]?.text).toContain("--- [project-a");
    } finally {
      await withProjectDirOverride(rootA, () => purge!.handler({ confirm: true }));
      await withProjectDirOverride(rootB, () => purge!.handler({ confirm: true }));
      if (previousStorage === undefined) delete process.env.CONTEXT_MODE_DIR;
      else process.env.CONTEXT_MODE_DIR = previousStorage;
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });
});
