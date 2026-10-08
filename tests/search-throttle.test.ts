import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { closeProjectStore } from "../src/project-context.js";
import { REGISTERED_CTX_TOOLS, withProjectDirOverride } from "../src/server.js";

describe("ctx_search throttling", () => {
  test("limits requests per project, not across projects", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "context-mode-search-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "context-mode-search-b-"));
    const index = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_index")!;
    const search = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_search")!;
    const scoped = (root: string, fn: () => Promise<unknown>) => withProjectDirOverride(root, fn);
    try {
      await scoped(rootA, () => index.handler({ content: "project alpha", source: "alpha" }));
      await scoped(rootB, () => index.handler({ content: "project beta", source: "beta" }));
      for (let i = 0; i < 8; i++) {
        await scoped(rootA, () => search.handler({ queries: ["project"] }));
      }
      const blocked = await scoped(rootA, () => search.handler({ queries: ["project"] })) as { isError?: boolean };
      const independent = await scoped(rootB, () => search.handler({ queries: ["project"] })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(blocked.isError).toBe(true);
      expect(independent.isError).not.toBe(true);
      expect(independent.content[0]?.text).toContain("beta");
    } finally {
      closeProjectStore(rootA);
      closeProjectStore(rootB);
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
