import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "../src/executor.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("foreground process cleanup", () => {
  test.skipIf(process.platform === "win32")(
    "kills descendants accidentally backgrounded by a foreground shell call",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "context-mode-orphan-test-"));
      const marker = join(root, "escaped-child.marker");
      try {
        const executor = new PolyglotExecutor({ projectRoot: root });
        const result = await executor.execute({
          language: "shell",
          code: `(sleep 0.2; printf escaped > ${shellQuote(marker)}) &`,
        });

        expect(result.exitCode).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
