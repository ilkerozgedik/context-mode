import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes, getAvailableLanguages, isAllowlistedShell } from "../src/runtime.js";
import { evaluateCommandDenyOnly } from "../src/security.js";
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
    const executor = new PolyglotExecutor({ projectRoot: process.cwd() });
    try {
      const result = await executor.execute({
        language: "javascript",
        code: 'console.log("core-smoke")',
        timeout: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("core-smoke");
    } finally {
      executor.cleanupBackgrounded();
    }
  });
});

describe("security", () => {
  test("deny rules apply inside chained commands", () => {
    const result = evaluateCommandDenyOnly("echo ok && sudo echo blocked", [
      { allow: [], ask: [], deny: ["Bash(sudo *)"] },
    ]);
    expect(result.decision).toBe("deny");
  });
});

describe("persistent core", () => {
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
