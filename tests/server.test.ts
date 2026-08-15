import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTERED_CTX_TOOLS, withProjectDirOverride } from "../src/server.js";

const EXPECTED_TOOLS = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_doctor",
  "ctx_purge",
];

describe("1MCP tool surface", () => {
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
    for (const name of ["ctx_execute", "ctx_execute_file", "ctx_batch_execute"]) {
      const tool = REGISTERED_CTX_TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.config.description).toContain("OS permissions");
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
  });
});
