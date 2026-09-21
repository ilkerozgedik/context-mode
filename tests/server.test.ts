import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REGISTERED_CTX_TOOLS, isDirectExecution, withProjectDirOverride } from "../src/server.js";
import { resolveExecutionProjectDir, resolveProjectScope } from "../src/project-context.js";
import { createToolRegistry } from "../src/tools/registry.js";

const EXPECTED_TOOLS = [
  "ctx_execute",
  "ctx_job_start",
  "ctx_job_status",
  "ctx_job_cancel",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_doctor",
  "ctx_purge",
];

describe("context-mode startup", () => {
  test("recognizes execution through a package-manager symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-main-"));
    try {
      const target = join(root, "server.bundle.mjs");
      const link = join(root, "node_modules", "context-mode", "server.bundle.mjs");
      mkdirSync(join(root, "node_modules", "context-mode"), { recursive: true });
      writeFileSync(target, "// target");
      symlinkSync(target, link);
      expect(isDirectExecution(link, pathToFileURL(target).href)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("context-mode tool surface", () => {
  test("exposes exactly the supported tools", () => {
    expect(REGISTERED_CTX_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  });

  test("exposes only the three supported execution languages", () => {
    const execute = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_execute");
    const schema = execute?.config.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ language: "javascript", code: "" }).success).toBe(true);
    expect(schema.safeParse({ language: "python", code: "" }).success).toBe(true);
    expect(schema.safeParse({ language: "shell", code: "" }).success).toBe(true);
    expect(schema.safeParse({ language: "ruby", code: "" }).success).toBe(false);
  });

  test("ctx_index requires exactly one of content or path", async () => {
    const index = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_index");
    expect(index).toBeDefined();
    const schema = index!.config.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ content: "inline" }).success).toBe(true);
    expect(schema.safeParse({ path: "README.md" }).success).toBe(true);

    for (const args of [{}, { content: "inline", path: "README.md" }]) {
      const result = await index!.handler(args) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Provide exactly one of content or path");
    }
  });

  test("ctx_index blocks paths outside the configured project root", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-root-"));
    const outside = mkdtempSync(join(tmpdir(), "context-mode-outside-"));
    try {
      const outsidePath = join(outside, "outside.txt");
      writeFileSync(outsidePath, "outside marker");
      const index = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_index");
      expect(index).toBeDefined();
      const result = await withProjectDirOverride(root, () =>
        index!.handler({ path: outsidePath, source: "outside" }),
      ) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("outside the project root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("ctx_index honors project Read deny rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-deny-"));
    try {
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, "blocked.txt"), "blocked marker");
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Read(blocked.txt)"] } }),
      );
      const index = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_index");
      const result = await withProjectDirOverride(root, () =>
        index!.handler({ path: "blocked.txt", source: "blocked" }),
      ) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Read deny pattern");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("execution tools disclose that code uses the MCP server OS permissions", () => {
    for (const name of ["ctx_execute", "ctx_execute_file", "ctx_batch_execute", "ctx_job_start"]) {
      const tool = REGISTERED_CTX_TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.config.description).toContain("OS permissions");
    }
  });

  test("async job tools advertise correct MCP safety annotations", () => {
    const start = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_job_start");
    const status = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_job_status");
    const cancel = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_job_cancel");
    expect(start?.config.annotations).toEqual(expect.objectContaining({
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    }));
    expect(status?.config.annotations).toEqual(expect.objectContaining({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    }));
    expect(cancel?.config.annotations).toEqual(expect.objectContaining({
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
    }));
  });

  test("ctx_execute rejects the removed background compatibility argument", () => {
    const execute = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_execute")!;
    const schema = execute.config.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ language: "shell", code: "echo should-not-run", background: true }).success).toBe(false);
  });

  test("successful ctx_execute returns output without repeating submitted code", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-compact-execute-"));
    try {
      const execute = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_execute")!;
      const result = await withProjectDirOverride(root, () =>
        execute.handler({
          language: "shell",
          code: "printf compact-success-marker",
          cwd: root,
        }),
      ) as { isError?: boolean; content: Array<{ text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(result.isError).not.toBe(true);
      expect(text).toBe("compact-success-marker");
      expect(text).not.toContain("printf compact-success-marker");
      expect(text).not.toContain("```shell");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("large intent execution returns the matching snippet directly", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-intent-snippet-"));
    try {
      const execute = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_execute")!;
      const result = await withProjectDirOverride(root, () =>
        execute.handler({
          language: "python",
          code: "for i in range(1200): print(('INTENT_NEEDLE direct evidence ' if i == 777 else 'ordinary payload ') + str(i))",
          intent: "INTENT_NEEDLE direct evidence",
          cwd: root,
        }),
      ) as { isError?: boolean; content: Array<{ text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(result.isError).not.toBe(true);
      expect(text).toContain("INTENT_NEEDLE direct evidence 777");
      expect(text).not.toContain("Use ctx_search");
      expect(text).not.toContain("```python");
      expect(text.length).toBeLessThan(2000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("large shell soft-fail output keeps non-error intent-search semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-soft-fail-"));
    try {
      const execute = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_execute")!;
      const result = await withProjectDirOverride(root, () =>
        execute.handler({
          language: "shell",
          code: `node -e "process.stdout.write('softmarker '.repeat(12000))"; exit 1`,
        }),
      ) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toContain('No sections matched intent "errors failures exceptions"');
      expect(result.content[0]?.text).toContain('from "execute:shell"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ctx_search rejects non-positive and fractional result limits", () => {
    const search = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_search")!;
    const schema = search.config.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ queries: ["x"], limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ queries: ["x"], limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ queries: ["x"], limit: -1 }).success).toBe(false);
    expect(schema.safeParse({ queries: ["x"], limit: 1.5 }).success).toBe(false);
  });

  test("ctx_batch_execute caps a request at eight commands", () => {
    const batch = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_batch_execute")!;
    const schema = batch.config.inputSchema as { safeParse(value: unknown): { success: boolean } };
    const command = { label: "x", command: "true" };
    expect(schema.safeParse({ commands: Array.from({ length: 8 }, () => command), queries: ["x"] }).success).toBe(true);
    expect(schema.safeParse({ commands: Array.from({ length: 9 }, () => command), queries: ["x"] }).success).toBe(false);
  });

  test("ctx_fetch_and_index requires the canonical requests array", () => {
    const fetchTool = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_fetch_and_index")!;
    const schema = fetchTool.config.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ requests: [{ url: "https://example.com", source: "example" }] }).success).toBe(true);
    expect(schema.safeParse({ url: "https://example.com", source: "example" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  test("resolves relative cwd once while locking by canonical project scope", async () => {
    const base = mkdtempSync(join(tmpdir(), "context-mode-relative-base-"));
    const repo = join(base, "work", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const registry = createToolRegistry(() => false);
    const execute = registry.register("ctx_execute", {}, async (args: { cwd: string }) => ({
      content: [{ type: "text", text: JSON.stringify({ cwd: args.cwd, resolved: resolveExecutionProjectDir(args.cwd) }) }],
    })) as (args: { cwd: string }) => Promise<{ content: Array<{ text: string }> }>;
    try {
      await withProjectDirOverride(base, async () => {
        const result = await execute({ cwd: "work/repo" });
        const observed = JSON.parse(result.content[0].text);
        expect(observed.cwd).toBe(repo);
        expect(observed.resolved).toBe(repo);
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("foreground execution is blocked only for the project with an active async job", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "context-mode-active-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "context-mode-active-b-"));
    const activeScope = resolveProjectScope(rootA);
    const registry = createToolRegistry((projectDir) => projectDir === activeScope);
    const execute = registry.register("ctx_execute", {}, async () => ({
      content: [{ type: "text", text: "other-project-ok" }],
    })) as (args: { cwd: string }) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    try {
      const blocked = await execute({ cwd: rootA });
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0].text).toMatch(/this project/i);

      const allowed = await execute({ cwd: rootB });
      expect(allowed.isError).not.toBe(true);
      expect(allowed.content[0].text).toContain("other-project-ok");
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  test("doctor validates the standalone runtime", async () => {
    const doctor = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_doctor");
    expect(doctor).toBeDefined();
    const result = await doctor!.handler({}) as { content: Array<{ type: string; text: string }> };
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("context-mode doctor");
    expect(text).toContain("[OK] Executor: PASS");
    expect(text).toContain("[OK] FTS5 / SQLite: PASS");
    expect(text).toContain("job concurrency 2 global / 1 project");
    expect(text).toContain("[OK] Async jobs: 0/2 active");
  });
});
