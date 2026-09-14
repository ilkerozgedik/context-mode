import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ContentStore } from "./store.js";
import { evaluateFilePath, readToolDenyPatterns } from "./security.js";

type ToolContextOverride = { projectDir: string };

const projectDirOverride = new AsyncLocalStorage<ToolContextOverride>();
const stores = new Map<string, ContentStore>();
const DEFAULT_CONTENT_DIR = join(homedir(), ".claude", "context-mode", "content");
const DEFAULT_MAX_OPEN_STORES = 8;

function getMaxOpenStores(): number {
  const raw = process.env.CONTEXT_MODE_MAX_OPEN_STORES?.trim();
  if (!raw) return DEFAULT_MAX_OPEN_STORES;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_OPEN_STORES;
}

function trimStoreCache(): void {
  const maxOpenStores = getMaxOpenStores();
  while (stores.size > maxOpenStores) {
    const oldest = stores.entries().next().value as [string, ContentStore] | undefined;
    if (!oldest) return;
    const [scope, store] = oldest;
    try { store.close(); } catch {}
    stores.delete(scope);
  }
}

export async function withProjectDirOverride<T>(
  projectDir: string | ToolContextOverride,
  fn: () => Promise<T> | T,
): Promise<T> {
  const context = typeof projectDir === "string" ? { projectDir } : projectDir;
  return projectDirOverride.run(context, fn);
}

export function runWithProjectDir<T>(projectDir: string, fn: () => Promise<T> | T): Promise<T> | T {
  return projectDirOverride.run({ projectDir }, fn);
}

export function getProjectDir(): string {
  const override = projectDirOverride.getStore();
  if (override) return override.projectDir;
  return resolve(process.env.CONTEXT_MODE_PROJECT_DIR?.trim() || process.env.PWD || process.cwd());
}

export function resolveExecutionProjectDir(cwd?: string): string {
  if (!cwd) return getProjectDir();
  return isAbsolute(cwd) ? resolve(cwd) : resolve(getProjectDir(), cwd);
}

export function resolveProjectPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(getProjectDir(), filePath);
}

export function getContentDir(): string {
  const root = process.env.CONTEXT_MODE_DIR?.trim();
  if (root && !isAbsolute(root)) throw new Error("CONTEXT_MODE_DIR must be an absolute path.");
  const dir = root ? join(resolve(root), "content") : DEFAULT_CONTENT_DIR;
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
  return dir;
}

function normalizeProjectPath(projectDir: string): string {
  const normalized = projectDir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function canonicalPath(projectDir: string): string {
  const resolved = resolve(projectDir);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveProjectScope(projectDir: string): string {
  const canonical = canonicalPath(projectDir);
  let current = canonical;
  while (true) {
    if (existsSync(join(current, ".git"))) return normalizeProjectPath(current);
    const parent = dirname(current);
    if (parent === current) return normalizeProjectPath(canonical);
    current = parent;
  }
}

export function projectHash(projectDir: string): string {
  return createHash("sha256").update(resolveProjectScope(projectDir)).digest("hex").slice(0, 16);
}

export function getStorePath(projectDir: string = getProjectDir()): string {
  return join(getContentDir(), `${projectHash(projectDir)}.db`);
}

export function getStore(projectDir: string = getProjectDir()): ContentStore {
  const scope = resolveProjectScope(projectDir);
  let store = stores.get(scope);
  if (store) {
    // Map insertion order is the LRU order. Current callers use stores synchronously,
    // so evicting an older entry here cannot close a store mid-operation.
    stores.delete(scope);
    stores.set(scope, store);
    trimStoreCache();
    return store;
  }

  store = new ContentStore(getStorePath(scope));
  let cachedDenyGlobs: string[][] | undefined;
  let denyCacheResetScheduled = false;
  store.setDenyChecker((filePath: string) => {
    try {
      if (cachedDenyGlobs === undefined) {
        cachedDenyGlobs = readToolDenyPatterns("Read", scope);
        if (!denyCacheResetScheduled) {
          denyCacheResetScheduled = true;
          queueMicrotask(() => {
            cachedDenyGlobs = undefined;
            denyCacheResetScheduled = false;
          });
        }
      }
      return evaluateFilePath(filePath, cachedDenyGlobs, process.platform === "win32" || process.platform === "darwin", scope).denied;
    } catch {
      return true;
    }
  });
  stores.set(scope, store);
  trimStoreCache();
  return store;
}

export function closeProjectStore(projectDir: string = getProjectDir()): void {
  const scope = resolveProjectScope(projectDir);
  const store = stores.get(scope);
  if (!store) return;
  try { store.close(); } catch {}
  stores.delete(scope);
}

export function closeStore(): void {
  for (const store of stores.values()) {
    try { store.close(); } catch {}
  }
  stores.clear();
}
