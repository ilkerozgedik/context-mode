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

  test("uses the configured project root for deny policies", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-mode-policy-"));
    try {
      mkdirSync(join(root, ".claude"));
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Bash(sudo *)"] } }),
      );
      const execute = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_execute");
      expect(execute).toBeDefined();
      const result = await withProjectDirOverride(root, () =>
        execute!.handler({ language: "shell", code: "sudo echo blocked" }),
      ) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("blocked by security policy");
    } finally {
      rmSync(root, { recursive: true, force: true });
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
