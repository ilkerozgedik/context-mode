import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ContentStore } from "./store.js";
import { evaluateFilePath, readToolDenyPatterns } from "./security.js";

type ToolContextOverride = { projectDir: string };

const projectDirOverride = new AsyncLocalStorage<ToolContextOverride>();
let store: ContentStore | null = null;
let storeProjectDir: string | null = null;
const DEFAULT_CONTENT_DIR = join(homedir(), ".claude", "context-mode", "content");

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

export function projectHash(projectDir: string): string {
  return createHash("sha256").update(normalizeProjectPath(projectDir)).digest("hex").slice(0, 16);
}

export function getStorePath(projectDir: string = getProjectDir()): string {
  return join(getContentDir(), `${projectHash(projectDir)}.db`);
}

export function getStore(projectDir: string = getProjectDir()): ContentStore {
  if (store && storeProjectDir !== projectDir) closeStore();
  if (!store) {
    store = new ContentStore(getStorePath(projectDir));
    storeProjectDir = projectDir;
    store.setDenyChecker((filePath: string) => {
      try {
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        return evaluateFilePath(filePath, denyGlobs, process.platform === "win32", projectDir).denied;
      } catch {
        return true;
      }
    });
  }
  return store;
}

export function closeStore(): void {
  if (!store) return;
  try { store.close(); } catch {}
  store = null;
  storeProjectDir = null;
}
