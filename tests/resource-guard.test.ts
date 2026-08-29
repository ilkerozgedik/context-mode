import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PolyglotExecutor,
  memoryAdmissionError,
  resolveBackgroundDetachTimeout,
  resolveForegroundTimeout,
} from "../src/executor.js";
import { getBatchConcurrencyLimit, resolveConfiguredConcurrency, REGISTERED_CTX_TOOLS } from "../src/server.js";
import { runPool } from "../src/runPool.js";
import { ContentStore } from "../src/store.js";

describe("resource guards", () => {
  test("cancels the spawned process tree when the request aborts", async () => {
    const executor = new PolyglotExecutor({ projectRoot: process.cwd() });
    const marker = join(tmpdir(), `context-mode-abort-${process.pid}-${Date.now()}`);
    const controller = new AbortController();
    try {
      const run = executor.execute({
        language: "javascript",
        code: `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "late"), 250); setTimeout(() => {}, 1000);`,
        timeout: 5000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 30);
      await run;
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
      executor.cleanupBackgrounded();
    }
  });

  test("cleanup terminates an active foreground process tree", async () => {
    const executor = new PolyglotExecutor({ projectRoot: process.cwd() });
    const marker = join(tmpdir(), `context-mode-cleanup-${process.pid}-${Date.now()}`);
    try {
      const run = executor.execute({
        language: "javascript",
        code: `process.on("SIGTERM", () => {}); const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "late"), 250); setTimeout(() => {}, 1000);`,
        timeout: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      executor.cleanupBackgrounded();
      await run;
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
      executor.cleanupBackgrounded();
    }
  });

  test("does not execute an aborted request after it waits for the project lock", async () => {
    const execute = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_execute");
    expect(execute).toBeDefined();
    const marker = join(tmpdir(), `context-mode-queued-abort-${process.pid}-${Date.now()}`);
    const controller = new AbortController();
    try {
      const first = execute!.handler({
        language: "javascript",
        code: "await new Promise((resolve) => setTimeout(resolve, 200)); console.log('first done')",
        timeout: 1000,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const queued = execute!.handler({
        language: "javascript",
        code: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
        timeout: 1000,
      }, { signal: controller.signal });
      controller.abort(new Error("request cancelled"));
      await expect(queued).rejects.toThrow("request cancelled");
      await first;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  test("applies deployment memory and foreground timeout limits", () => {
    expect(memoryAdmissionError("MemTotal: 1024 kB\nMemAvailable: 524288 kB\n", 768))
      .toContain("512 MiB available");
    expect(memoryAdmissionError("MemAvailable: 1048576 kB\n", 768)).toBeUndefined();
    expect(memoryAdmissionError("MemAvailable: 1 kB\n", 0)).toBeUndefined();
    expect(resolveForegroundTimeout(undefined, false, 45_000)).toBe(45_000);
    expect(resolveForegroundTimeout(90_000, false, 45_000)).toBe(45_000);
    expect(resolveForegroundTimeout(10_000, false, 45_000)).toBe(10_000);
    expect(resolveForegroundTimeout(undefined, true, 45_000)).toBeUndefined();
    expect(resolveBackgroundDetachTimeout(undefined, 5_000)).toBe(5_000);
    expect(resolveBackgroundDetachTimeout(30_000, 5_000)).toBe(5_000);
    expect(resolveBackgroundDetachTimeout(2_000, 5_000)).toBe(2_000);
    const previousConcurrency = process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY;
    try {
      process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY = "2";
      expect(getBatchConcurrencyLimit()).toBe(2);
      expect(resolveConfiguredConcurrency(8)).toBe(2);
      expect(resolveConfiguredConcurrency(0)).toBe(1);
    } finally {
      if (previousConcurrency === undefined) delete process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY;
      else process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY = previousConcurrency;
    }
  });

  test("enforces the configured cap on a batch worker pool", async () => {
    const previousConcurrency = process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY;
    let inFlight = 0;
    let peak = 0;
    try {
      process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY = "1";
      const jobs = Array.from({ length: 3 }, () => ({
        run: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight -= 1;
        },
      }));
      const result = await runPool(jobs, { concurrency: resolveConfiguredConcurrency(3) });
      expect(result.settled.every((item) => item.status === "fulfilled")).toBe(true);
      expect(peak).toBe(1);
    } finally {
      if (previousConcurrency === undefined) delete process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY;
      else process.env.CONTEXT_MODE_MAX_BATCH_CONCURRENCY = previousConcurrency;
    }
  });

  test("caps captured child output without killing the process", async () => {
    const executor = new PolyglotExecutor({ projectRoot: process.cwd() });
    const marker = join(tmpdir(), `context-mode-output-cap-${process.pid}-${Date.now()}`);
    try {
      const result = await executor.execute({
        language: "javascript",
        code: `const fs = require("node:fs"); process.stdout.write("x".repeat(9_000_000)); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "done"), 50);`,
        timeout: 5000,
      });

      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(result.stderr).toContain("output capped at 8MB");
      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  test("quarantines a corrupt persistent database before recovering", () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-corrupt-"));
    const dbPath = join(root, "content.db");
    writeFileSync(dbPath, "definitely not sqlite");
    let store: ContentStore | undefined;
    try {
      store = new ContentStore(dbPath);
      store.index({ content: "database recovered", source: "recovery" });
      expect(store.searchWithFallback("recovered", 1, "recovery").length).toBeGreaterThan(0);
      expect(readdirSync(root).some((name) => name.startsWith("content.db.corrupt-"))).toBe(true);
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
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

  test("batch execution supports POSIX compound shell commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-batch-compound-"));
    const storage = mkdtempSync(join(tmpdir(), "context-mode-batch-compound-storage-"));
    const previousStorage = process.env.CONTEXT_MODE_DIR;
    process.env.CONTEXT_MODE_DIR = storage;
    const batch = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_batch_execute");
    const purge = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_purge");
    try {
      const result = await batch!.handler({
        commands: [{ label: "compound", command: "if true; then printf compound-ok; fi" }],
        queries: ["compound-ok"],
        timeout: 5000,
        concurrency: 1,
        query_scope: "batch",
        cwd: root,
      }) as { isError?: boolean; content: Array<{ text: string }> };
      const text = result.content.map((part) => part.text).join("\n");
      expect(result.isError).not.toBe(true);
      expect(text).toContain("compound-ok");
      expect(text).not.toContain("syntax error");
    } finally {
      await purge!.handler({ confirm: true, cwd: root });
      if (previousStorage === undefined) delete process.env.CONTEXT_MODE_DIR;
      else process.env.CONTEXT_MODE_DIR = previousStorage;
      rmSync(root, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
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
      const result = await batch!.handler({
        commands: [{ label: "large", command: "node -e \"process.stdout.write('batch_marker '.repeat(400000))\"" }],
        queries: ["batch_marker"],
        timeout: 30000,
        concurrency: 1,
        query_scope: "batch",
        cwd: root,
      }) as { isError?: boolean; content: Array<{ text: string }> };
      const text = result.content.map((part) => part.text).join("\\n");

      expect(result.isError).not.toBe(true);
      expect(text).toContain("output capped at 4MB before indexing");
      expect(text.toLowerCase()).not.toContain("heap out of memory");
    } finally {
      await purge!.handler({ confirm: true, cwd: root });
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

    const run = (root: string, marker: string) => batch!.handler({
      commands: [{ label: marker, command: `printf ${marker}` }],
      queries: [marker],
      timeout: 30000,
      concurrency: 1,
      query_scope: "batch",
      cwd: root,
    });

    try {
      const results = await Promise.all([run(rootA, "PROJECT_A_CONCURRENT"), run(rootB, "PROJECT_B_CONCURRENT")]) as Array<{ isError?: boolean }>;
      expect(results.every((result) => result.isError !== true)).toBe(true);
    } finally {
      await purge!.handler({ confirm: true, cwd: rootA });
      await purge!.handler({ confirm: true, cwd: rootB });
      if (previousStorage === undefined) delete process.env.CONTEXT_MODE_DIR;
      else process.env.CONTEXT_MODE_DIR = previousStorage;
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  test("preserves cwd in every project-scoped public tool schema", () => {
    const root = "/tmp/context-mode-schema-project";
    const cases: Record<string, Record<string, unknown>> = {
      ctx_execute_file: { path: "README.md", language: "javascript", code: "console.log(FILE_CONTENT.length)", cwd: root },
      ctx_index: { content: "schema marker", cwd: root },
      ctx_search: { queries: ["schema marker"], cwd: root },
      ctx_fetch_and_index: { url: "https://example.com", cwd: root },
      ctx_purge: { confirm: false, cwd: root },
    };

    for (const [name, args] of Object.entries(cases)) {
      const tool = REGISTERED_CTX_TOOLS.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      const schema = tool!.config.inputSchema as { parse(input: unknown): Record<string, unknown> };
      expect(schema.parse(args).cwd, name).toBe(root);
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
      await index!.handler({ content: "PROJECT_A_ONLY", source: "project-a", cwd: rootA });
      await index!.handler({ content: "PROJECT_B_ONLY", source: "project-b", cwd: rootB });

      const fromB = await search!.handler({ queries: ["PROJECT_A_ONLY"], cwd: rootB }) as { content: Array<{ text: string }> };
      const fromA = await search!.handler({ queries: ["PROJECT_A_ONLY"], cwd: rootA }) as { content: Array<{ text: string }> };

      expect(fromB.content[0]?.text).not.toContain("--- [project-a");
      expect(fromA.content[0]?.text).toContain("--- [project-a");
    } finally {
      await purge!.handler({ confirm: true, cwd: rootA });
      await purge!.handler({ confirm: true, cwd: rootB });
      if (previousStorage === undefined) delete process.env.CONTEXT_MODE_DIR;
      else process.env.CONTEXT_MODE_DIR = previousStorage;
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });
  test("rejects direct indexing inputs above the 8MB safety budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-index-cap-"));
    const storage = mkdtempSync(join(tmpdir(), "context-mode-index-cap-storage-"));
    const previousStorage = process.env.CONTEXT_MODE_DIR;
    process.env.CONTEXT_MODE_DIR = storage;

    const index = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_index");
    const purge = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_purge");
    expect(index).toBeDefined();
    expect(purge).toBeDefined();

    const largePath = join(root, "large.txt");
    writeFileSync(largePath, "x".repeat(8 * 1024 * 1024 + 1));

    try {
      const fileResult = await index!.handler({ path: largePath, source: "too-large-file", cwd: root }) as { isError?: boolean; content: Array<{ text: string }> };
      const inlineResult = await index!.handler({ content: "x".repeat(8 * 1024 * 1024 + 1), source: "too-large-inline", cwd: root }) as { isError?: boolean; content: Array<{ text: string }> };

      for (const result of [fileResult, inlineResult]) {
        const text = result.content.map((part) => part.text).join("\n");
        expect(result.isError).toBe(true);
        expect(text).toContain("8MB");
        expect(text).toContain("too large");
      }
    } finally {
      await purge!.handler({ confirm: true, cwd: root });
      if (previousStorage === undefined) delete process.env.CONTEXT_MODE_DIR;
      else process.env.CONTEXT_MODE_DIR = previousStorage;
      rmSync(root, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

});
