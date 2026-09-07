import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStore, getStore } from "../src/project-context.js";

const tempDirs: string[] = [];
const previousDir = process.env.CONTEXT_MODE_DIR;
const previousMaxStores = process.env.CONTEXT_MODE_MAX_OPEN_STORES;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeStore();
  if (previousDir === undefined) delete process.env.CONTEXT_MODE_DIR;
  else process.env.CONTEXT_MODE_DIR = previousDir;
  if (previousMaxStores === undefined) delete process.env.CONTEXT_MODE_MAX_OPEN_STORES;
  else process.env.CONTEXT_MODE_MAX_OPEN_STORES = previousMaxStores;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bounded project store cache", () => {
  test("evicts the least recently used store when the configured cap is reached", () => {
    process.env.CONTEXT_MODE_DIR = tempDir("context-mode-store-cache-");
    process.env.CONTEXT_MODE_MAX_OPEN_STORES = "2";
    const rootA = tempDir("context-mode-project-a-");
    const rootB = tempDir("context-mode-project-b-");
    const rootC = tempDir("context-mode-project-c-");

    const storeA = getStore(rootA);
    const storeB = getStore(rootB);
    expect(getStore(rootA)).toBe(storeA); // promote A, making B least-recently-used

    getStore(rootC);

    expect(getStore(rootA)).toBe(storeA);
    expect(getStore(rootB)).not.toBe(storeB);
  });
});
