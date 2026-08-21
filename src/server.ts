#!/usr/bin/env node
import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, renameSync, unlinkSync, readFileSync, writeFileSync, writeSync, rmSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, tmpdir, cpus } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { runPool, type PoolJob } from "./runPool.js";
import { ContentStore, type IndexResult } from "./store.js";
import {
  readToolDenyPatterns,
  readToolPermissionPatterns,
  evaluateFilePath,
  evaluateProjectContainment,
} from "./security.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  getAvailableLanguages,
} from "./runtime.js";
import { classifyNonZeroExit } from "./exit-classify.js";
import { charSafePrefix } from "./truncate.js";
import { loadDatabase } from "./db-base.js";
const __pkg_dir = dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  for (const rel of ["../package.json", "./package.json"]) {
    const p = resolve(__pkg_dir, rel);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")).version; } catch {}
    }
  }
  return "unknown";
})();

const INDEX_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

function byteCappedPrefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return text.slice(0, end);
}

function capIndexableOutput(text: string): { text: string; truncated: boolean } {
  const capped = byteCappedPrefix(text, INDEX_OUTPUT_CAP_BYTES);
  return { text: capped, truncated: capped.length !== text.length };
}

process.on("unhandledRejection", (err) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  try {
    writeSync(2, `[context-mode] uncaughtException: ${err?.message ?? err}\n`);
  } finally {
    process.exit(1);
  }
});

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
export interface RegisteredCtxTool {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
}

export const REGISTERED_CTX_TOOLS: RegisteredCtxTool[] = [];

const SERIALIZED_PROJECT_TOOLS = new Set([
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_purge",
]);

// ponytail: global project-tool lock; use per-project locks only if throughput matters.
let projectToolLock: Promise<void> = Promise.resolve();

async function withProjectToolLock<T>(projectDir: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = projectToolLock;
  let release!: () => void;
  projectToolLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await projectDirOverride.run({ projectDir }, fn);
  } finally {
    release();
  }
}

function registerCtxTool(
  name: string,
  config: Record<string, unknown>,
  handler: (toolArgs: any, ctx?: { signal?: AbortSignal }) => Promise<any> | any,
): unknown {
  const guardedHandler = SERIALIZED_PROJECT_TOOLS.has(name)
    ? (toolArgs: any, ctx?: { signal?: AbortSignal }) => withProjectToolLock(
        resolveExecutionProjectDir(typeof toolArgs?.cwd === "string" ? toolArgs.cwd : undefined),
        () => handler(toolArgs, ctx),
      )
    : handler;
  REGISTERED_CTX_TOOLS.push({ name, config, handler: guardedHandler });
  return guardedHandler;
}

type ToolContextOverride = { projectDir: string };
const projectDirOverride = new AsyncLocalStorage<ToolContextOverride>();

export async function withProjectDirOverride<T>(
  projectDir: string | ToolContextOverride,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = typeof projectDir === "string" ? { projectDir } : projectDir;
  return projectDirOverride.run(ctx, fn);
}

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: () => getProjectDir(),
});

// ─────────────────────────────────────────────────────────
// FS read tracking preload for ctx_batch_execute
// ─────────────────────────────────────────────────────────
// NODE_OPTIONS is denied by the executor's #buildSafeEnv (security).
// Instead, we inject it as an inline shell env prefix in each batch command.
// This temp file is loaded via --require when batch commands spawn Node processes.
const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);
writeFileSync(
  CM_FS_PRELOAD,
  `(function(){var __cm_fs=0;process.on('exit',function(){if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};}catch(e){}})();\n`,
);
// Best-effort cleanup in case the process exits before main() shutdown.
process.on("exit", () => { try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ } });

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;
let _storeProjectDir: string | null = null;

const DEFAULT_CONTENT_DIR = join(homedir(), ".claude", "context-mode", "content");

export function getProjectDir(): string {
  const override = projectDirOverride.getStore();
  if (override) return override.projectDir;
  return resolve(process.env.CONTEXT_MODE_PROJECT_DIR?.trim() || process.env.PWD || process.cwd());
}

function resolveExecutionProjectDir(cwd?: string): string {
  if (!cwd) return getProjectDir();
  return isAbsolute(cwd) ? resolve(cwd) : resolve(getProjectDir(), cwd);
}

function resolveProjectPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(getProjectDir(), filePath);
}

function getContentDir(): string {
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

function projectHash(projectDir: string, canonical = true): string {
  const normalized = projectDir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const value = canonical ? normalizeProjectPath(projectDir) : normalized;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function getStorePath(projectDir: string = getProjectDir()): string {
  const dir = getContentDir();
  const canonicalPath = join(dir, `${projectHash(projectDir)}.db`);
  if (existsSync(canonicalPath)) return canonicalPath;

  const legacyPath = join(dir, `${projectHash(projectDir, false)}.db`);
  if (legacyPath !== canonicalPath && existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, canonicalPath);
      for (const suffix of ["-wal", "-shm"]) {
        try { renameSync(legacyPath + suffix, canonicalPath + suffix); } catch {}
      }
    } catch {}
  }
  return canonicalPath;
}

function getStore(projectDir: string = getProjectDir()): ContentStore {
  if (_store && _storeProjectDir !== projectDir) {
    try { _store.close(); } catch {}
    _store = null;
    _storeProjectDir = null;
  }

  if (!_store) {
    const dbPath = getStorePath(projectDir);
    _store = new ContentStore(dbPath);
    _storeProjectDir = projectDir;

    // Wire deny-policy hook: store re-checks the Read deny list before
    // re-reading any file_path during auto-refresh. Catches policy edits
    // made after a file was originally indexed. See #442 round-3.
    _store.setDenyChecker((filePath: string) => {
      try {
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const r = evaluateFilePath(
          filePath,
          denyGlobs,
          process.platform === "win32",
          projectDir,
        );
        return r.denied;
      } catch {
        // Fail-closed for refresh: skip on error rather than re-read.
        return true;
      }
    });

  }
  return _store;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function securityCheckFailed(): ToolResult {
  return {
    content: [{ type: "text", text: "Security policy check failed; request blocked." }],
    isError: true,
  };
}

// ==============================================================================
// Security: selected file-path controls
// ==============================================================================

/**
 * Constrain file-path arguments to the configured project root. Explicit
 * `Read(...)` allow rules remain the escape hatch for intentional external
 * paths. This protects the selected input path only; execution tools still run
 * user code with the MCP server process's OS permissions.
 */
function checkProjectBoundary(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const allowGlobs = readToolPermissionPatterns("Read", "allow", projectDir);
    const verdict = evaluateProjectContainment(filePath, projectDir, allowGlobs);
    if (verdict.allowed) return null;
    return {
      content: [{
        type: "text" as const,
        text:
          `File access blocked: "${filePath}" resolves outside the project root ` +
          `(${projectDir}). The ${toolName} path argument is workspace-scoped. ` +
          `To intentionally select a file outside the project, add a host allow rule, ` +
          `e.g. "permissions": { "allow": ["Read(${filePath})"] } in your settings.`,
      }],
      isError: true,
    };
  } catch {
    return securityCheckFailed();
  }
  return null;
}

/**
 * Check a file path against Read deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkFilePathDenyPolicy(
  filePath: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const denyGlobs = readToolDenyPatterns("Read", projectDir);
    const result = evaluateFilePath(
      filePath,
      denyGlobs,
      process.platform === "win32",
      projectDir,
    );
    if (result.denied) {
      return {
        content: [{
          type: "text" as const,
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      };
    }
  } catch {
    return securityCheckFailed();
  }
  return null;
}

// Build description dynamically based on detected runtimes
// ─────────────────────────────────────────────────────────
// Helper: smart snippet extraction — returns windows around
// matching query terms instead of dumb truncation
//
// When `highlighted` is provided (from FTS5 `highlight()` with
// STX/ETX markers), match positions are derived from the markers.
// This is the authoritative source — FTS5 uses the exact same
// tokenizer that produced the BM25 match, so stemmed variants
// like "configuration" matching query "configure" are found
// correctly. Falls back to indexOf on raw terms when highlighted
// is absent (non-FTS codepath).
// ─────────────────────────────────────────────────────────

const STX = "\x02";
const ETX = "\x03";

/**
 * Parse FTS5 highlight markers to find match positions in the
 * original (marker-free) text. Returns character offsets into the
 * stripped content where each matched token begins.
 */
export function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;

  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      // Record position of this match in the clean text
      positions.push(cleanOffset);
      i++; // skip STX
      // Advance through matched text until ETX
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++; // skip ETX
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

export function extractSnippet(
  content: string,
  query: string,
  maxLen = 1500,
  highlighted?: string,
): string {
  if (content.length <= maxLen) return content;

  // Derive match positions from FTS5 highlight markers when available
  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  // Fallback: indexOf on raw query terms (non-FTS codepath)
  if (positions.length === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const lower = content.toLowerCase();

    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  // No matches at all — return prefix
  if (positions.length === 0) {
    return content.slice(0, maxLen) + "\n…";
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  // Collect windows until maxLen
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + (maxLen - total)));
    parts.push(
      (start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""),
    );
    total += part.length;
  }

  return parts.join("\n\n");
}

export type BatchQueryScope = "batch" | "global";

export function formatBatchQueryResults(
  store: ContentStore,
  queries: string[],
  source: string,
  maxOutput = 80 * 1024,
  scope: BatchQueryScope = "batch",
): string[] {
  const sections: string[] = [];
  let outputSize = 0;

  // When scope is "global", searchWithFallback receives `undefined` for the
  // source filter, which makes it query the entire persistent index instead
  // of only the chunks just produced by this batch's commands. Default
  // remains "batch" to preserve the historical behavior.
  const searchSource = scope === "global" ? undefined : source;

  for (const query of queries) {
    if (outputSize > maxOutput) {
      sections.push(`## ${query}\n(output cap reached — use ctx_search(queries: ["${query}"]) for details)\n`);
      continue;
    }

    const results = store.searchWithFallback(query, 3, searchSource, undefined, "exact");
    sections.push(`## ${query}`);
    sections.push("");
    if (results.length > 0) {
      for (const result of results) {
        const snippet = extractSnippet(result.content, query, 3000, result.highlighted);
        sections.push(`### ${result.title}`);
        sections.push(snippet);
        sections.push("");
        outputSize += snippet.length + result.title.length;
      }
      continue;
    }

    sections.push("No matching sections found.");
    sections.push("");
  }

  if (scope === "global") {
    sections.push(`\n> **Scope:** Queries searched the entire persistent index (query_scope: "global").`);
  } else {
    sections.push(`\n> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use \`ctx_search(queries: [...])\` or call ctx_batch_execute with \`query_scope: "global"\`.`);
  }

  return sections;
}

// ─────────────────────────────────────────────────────────
// batch_execute runner — used by ctx_batch_execute handler
// ─────────────────────────────────────────────────────────

export interface BatchCommand { label: string; command: string; }

export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}

export interface BatchRunOptions {
  /**
   * Total budget (concurrency=1, shared) or per-command (concurrency>1).
   * When `undefined`, no server-side timer fires — the MCP host's RPC
   * timeout governs (Issue #406).
   */
  timeout: number | undefined;
  concurrency: number;
  nodeOptsPrefix: string;
  cwd?: string;
  onFsBytes?: (bytes: number) => void;
  signal?: AbortSignal;
}

interface BatchExecutor {
  execute(input: { language: "shell"; code: string; timeout: number | undefined; cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string; timedOut?: boolean }>;
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildBatchNodeOptionsPrefix(shellPath: string, preloadPath: string): string {
  const option = `--require ${preloadPath}`;
  const shell = shellPath.toLowerCase();
  const base = shell.split(/[\\/]/).pop() ?? shell;

  if (shell.includes("powershell") || shell.includes("pwsh")) {
    return `$env:NODE_OPTIONS=${quotePowerShellSingle(option)}; `;
  }

  if (base === "cmd" || base === "cmd.exe") {
    return `set "NODE_OPTIONS=${option.replace(/"/g, '""')}" && `;
  }

  return `NODE_OPTIONS=${quotePosixSingle(option)} `;
}

/**
 * Per-section budget for the echoed `$ <command>` line so a 50KB heredoc
 * payload cannot dominate the response body. The full command always reaches
 * the executor — only the echo is clipped (Issues #717 + #736).
 */
const COMMAND_ECHO_MAX = 500;

function truncateCommandForEcho(command: string): string {
  const cleaned = command.replace(/\s+/g, " ").trim();
  if (cleaned.length <= COMMAND_ECHO_MAX) return cleaned;
  return cleaned.slice(0, COMMAND_ECHO_MAX) + "…";
}

/**
 * Per-call budget for the source-code echo prepended by `ctx_execute` and
 * `ctx_execute_file` (Issues #717 + #736). The full code always reaches the
 * child process — only the echo is clipped so massive payloads don't dominate
 * the response. Multi-line preserved (unlike command echo) so the user
 * sees the actual program shape.
 */
const CODE_ECHO_MAX = 2000;

function truncateCodeForEcho(code: string): string {
  if (code.length <= CODE_ECHO_MAX) return code;
  return code.slice(0, CODE_ECHO_MAX) + "\n… (truncated)";
}

/**
 * Build the source-code preamble surfaced before tool stdout. Provenance
 * survives in indexed chunks (FTS5 sees the fenced block) so later
 * ctx_search hits remember what ran.
 */
function buildExecuteEcho(language: string, code: string, path?: string): string {
  const header = path ? `path=${path}\n` : "";
  const fenced = `\`\`\`${language}\n${truncateCodeForEcho(code)}\n\`\`\``;
  return `${header}${fenced}\n\n`;
}

function formatCommandOutput(label: string, command: string, raw: string, onFsBytes?: (bytes: number) => void): string {
  let output = raw || "(no output)";
  const fsMatches = output.matchAll(/__CM_FS__:(\d+)/g);
  let cmdFsBytes = 0;
  for (const m of fsMatches) cmdFsBytes += parseInt(m[1]);
  if (cmdFsBytes > 0) {
    onFsBytes?.(cmdFsBytes);
    output = output.replace(/__CM_FS__:\d+\n?/g, "");
  }
  // Echo the executed command below the section heading so per-chunk
  // indexed content retains provenance for later ctx_search hits
  // (Issues #717 + #736).
  const echoed = truncateCommandForEcho(command);
  return `# ${label}\n\n$ ${echoed}\n\n${output}\n`;
}

function combineExecOutput(result: { stdout?: string; stderr?: string }): string {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

/**
 * Execute batch commands. concurrency=1 preserves the legacy serial path
 * (shared timeout budget + cascading skip-on-timeout). concurrency>1 runs
 * commands concurrently with at most N in flight; each command receives the
 * full timeout, output is collated by input index, and per-command timeouts
 * record `(timed out)` blocks without skipping siblings.
 */
export async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, cwd, onFsBytes, signal } = opts;

  if (concurrency <= 1) {
    // Serial path — shared timeout budget, cascading skip on timeout.
    // When `timeout` is undefined, no shared budget is enforced; each
    // command runs to completion (Issue #406).
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout: perCmdTimeout,
        cwd,
        signal,
      });
      outputs.push(formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  // Parallel path — delegated to the shared runPool primitive.
  // Each job returns { output, timedOut }; runPool handles in-flight cap,
  // throw isolation (Promise.allSettled semantics), and order preservation.
  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout,
        cwd,
        signal,
      });
      // Always route partial output through formatCommandOutput so __CM_FS__
      // markers are stripped + counted, even when the command timed out.
      const formatted = formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes);
      const output = result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
    } else {
      // Isolated executor throw (spawn EAGAIN, ENOMEM, EMFILE, …) — siblings keep running.
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}

// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────

registerCtxTool(
  "ctx_execute",
  {
    // #852: surface code execution in the host approval prompt's title (the
    // only server-controlled field the MCP permission UI renders besides args).
    title: "Run code (uses MCP server OS permissions)",
    // Runs arbitrary code as a child process with the MCP server OS permissions.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Run code as a child process with the MCP server OS permissions. Print only findings that should enter context; use ctx_batch_execute for related commands.",
    inputSchema: z.object({
      language: z
.enum(["javascript", "python", "shell"])
        .describe("Runtime language"),
      code: z
        .string()
        .describe("Code to execute; print only the result that should enter context."),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms; omit to use the MCP host timeout."),
      background: z
        .boolean()
        .optional()
        .default(false)
        .describe("Keep the process running after timeout for servers or daemons."),
      cwd: z
        .string()
        .optional()
        .describe("Optional working directory for shell commands."),
      intent: z
        .string()
        .optional()
        .describe("Terms to match when large output is indexed."),
    }),
  },
  async ({ language, code, timeout, background, cwd, intent }, ctx) => {
    try {
      // For JavaScript: wrap in async IIFE with fetch + http/https interceptors to track network bytes
      let instrumentedCode = code;
      if (language === "javascript") {
        // Wrap user code in a closure that shadows CJS require with http/https interceptor.
        // globalThis.require does NOT work because CJS require is module-scoped, not global.
        // The closure approach (function(__cm_req){ var require=...; })(require) correctly
        // shadows the CJS require for all code inside, including __cm_main().
        instrumentedCode = `
// FS read instrumentation — count bytes read via fs.readFileSync/readFile
let __cm_fs=0;
process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
(function(){
  try{
    var f=typeof require!=='undefined'?require('fs'):null;
    if(!f)return;
    var ors=f.readFileSync;
    f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};
    var orf=f.readFile;
    if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d){if(Buffer.isBuffer(d))__cm_fs+=d.length;else if(typeof d==='string')__cm_fs+=Buffer.byteLength(d);}cb(e,d);}]));};
  }catch{}
})();
let __cm_net=0;
// Report network bytes on process exit — works with both promise and callback patterns.
// process.on('exit') fires after all I/O completes, unlike .finally() which fires
// when __cm_main() resolves (immediately for callback-based http.get without await).
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
// Intercept globalThis.fetch
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
return r};
// Shadow CJS require with http/https network tracking.
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    res.on('data',function(c){__cm_net+=c.length});oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      res.on('data',function(c){__cm_net+=c.length});cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
})(typeof require!=='undefined'?require:null);`;
      }
      const result = await executor.execute({ language, code: instrumentedCode, timeout: timeout, background, cwd, signal: ctx?.signal });

      // Echo the executed source code before stdout so users can audit
      // and host approval UIs can audit the exact payload (Issues #717 + #736).
      // Built from the user-supplied `code`, NOT the instrumented variant.
      const echo = buildExecuteEcho(language, code);

      // Parse sandbox network metrics from stderr
      const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
      if (netMatch) {
        // Clean the metric line from stderr
        result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
      }

      // Parse sandbox FS read metrics from stderr
      const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
      if (fsMatch) {
        result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
      }

      if (result.timedOut) {
        const partialOutput = result.stdout?.trim();
        if (result.backgrounded && partialOutput) {
          // Background mode: process is still running, return partial output as success
          return {
            content: [
              {
                type: "text" as const,
                text: `${echo}${partialOutput}\n\n_(process backgrounded after ${timeout}ms — still running)_`,
              },
            ],
          };
        }
        if (partialOutput) {
          // Timeout with partial output — return as success with note
          return {
            content: [
              {
                type: "text" as const,
                text: `${echo}${partialOutput}\n\n_(timed out after ${timeout}ms — partial output shown above)_`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `${echo}Execution timed out after ${timeout}ms\n\nstderr:\n${result.stderr}`,
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`, undefined, resolveExecutionProjectDir(cwd))}` },
            ],
            isError,
          };
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`)}` },
            ],
            isError,
          };
        }
        return {
          content: [
            { type: "text" as const, text: `${echo}${output}` },
          ],
          isError,
        };
      }

      const stdout = result.stdout || "(no output)";

      // Intent-driven search: if intent provided and output is large enough
      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        return {
          content: [
            { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `execute:${language}`, undefined, resolveExecutionProjectDir(cwd))}` },
          ],
        };
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        const indexed = indexStdout(stdout, `execute:${language}`, resolveExecutionProjectDir(cwd));
        // Prepend echo to the first text content so provenance still surfaces
        const echoed = {
          ...indexed,
          content: indexed.content.map((c, i) =>
            i === 0 && c.type === "text"
              ? { ...c, text: `${echo}${(c as { text: string }).text}` }
              : c,
          ),
        };
        return echoed;
      }

      return {
        content: [
          { type: "text" as const, text: `${echo}${stdout}` },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Helper: index stdout into FTS5 knowledge base
// ─────────────────────────────────────────────────────────

function indexStdout(
  stdout: string,
  source: string,
  projectDir: string = getProjectDir(),
): { content: Array<{ type: "text"; text: string }> } {
  const indexable = capIndexableOutput(stdout);
  const store = getStore(projectDir);
  const indexed = store.index({ content: indexable.text, source });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}${indexable.truncated ? `\nOutput capped at ${(INDEX_OUTPUT_CAP_BYTES / 1024 / 1024).toFixed(0)}MB before indexing.` : ""}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────
// Helper: intent-driven search on execution output
// ─────────────────────────────────────────────────────────

const INTENT_SEARCH_THRESHOLD = 5_000; // bytes — ~80-100 lines
const LARGE_OUTPUT_THRESHOLD = 102_400; // 100KB — auto-index into FTS5, return pointer

function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
  projectDir: string = getProjectDir(),
): string {
  const indexable = capIndexableOutput(stdout);
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  // Index into the PERSISTENT store so user can ctx_search() later
  const persistent = getStore(projectDir);
  const indexed = persistent.indexPlainText(indexable.text, source, undefined);

  // Search the persistent store directly (porter → trigram → fuzzy)
  let results = persistent.searchWithFallback(intent, maxResults, source);

  // Extract distinctive terms as vocabulary hints for the LLM
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }
    lines.push("");
    lines.push("Use ctx_search(queries: [...]) to explore the indexed content.");
    return lines.join("\n");
  }

  // Return ONLY titles + first-line previews — not full content
  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];

  for (const r of results) {
    const preview = r.content.split("\n")[0].slice(0, 120);
    lines.push(`  - ${r.title}: ${preview}`);
  }

  if (distinctiveTerms.length > 0) {
    lines.push("");
    lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
  }

  lines.push("");
  lines.push("Use ctx_search(queries: [...]) to retrieve full content of any section.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// Tool: execute_file
// ─────────────────────────────────────────────────────────

registerCtxTool(
  "ctx_execute_file",
  {
    // #852: the host's MCP approval prompt renders only the tool name/title +
    // raw args — the title is the one server-controlled signal, so make it
    // unambiguously announce code execution + file read for the reviewer.
    title: "Run code over a file (uses MCP server OS permissions)",
    // Runs arbitrary code over the selected file with the MCP server OS permissions.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Analyze a selected project file without loading it into context. Code receives FILE_CONTENT and runs with the MCP server OS permissions; only printed output is returned.",
    inputSchema: z.object({
      cwd: z.string().optional().describe("Project directory used to scope paths and the persistent index."),
      path: z
        .string()
        .describe("Absolute file path or relative to project root"),
      language: z
.enum(["javascript", "python", "shell"])
        .describe("Runtime language"),
      code: z
        .string()
        .describe("Code that reads FILE_CONTENT and prints the result to return."),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms; omit to use the MCP host timeout."),
      intent: z
        .string()
        .optional()
        .describe("Terms to match when large output is indexed."),
    }),
  },
  async ({ path, language, code, timeout, intent }, ctx) => {
    // Constrain the selected input path before applying optional Read deny rules.
    // The supplied code itself still runs with the MCP server OS permissions.
    const boundaryDenied = checkProjectBoundary(path, "ctx_execute_file");
    if (boundaryDenied) return boundaryDenied;

    // Security: check file path against Read deny patterns
    const pathDenied = checkFilePathDenyPolicy(path);
    if (pathDenied) return pathDenied;

    try {
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout: timeout,
      });

      // Echo path + executed source code before stdout for audit/debug
      // (Issues #717 + #736).
      const echo = buildExecuteEcho(language, code, path);

      if (result.timedOut) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${echo}Timed out processing ${path} after ${timeout}ms`,
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          };
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          };
        }
        return {
          content: [
            { type: "text" as const, text: `${echo}${output}` },
          ],
          isError,
        };
      }

      const stdout = result.stdout || "(no output)";

      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        return {
          content: [
            { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `file:${path}`)}` },
          ],
        };
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        const indexed = indexStdout(stdout, `file:${path}`);
        const echoed = {
          ...indexed,
          content: indexed.content.map((c, i) =>
            i === 0 && c.type === "text"
              ? { ...c, text: `${echo}${(c as { text: string }).text}` }
              : c,
          ),
        };
        return echoed;
      }

      return {
        content: [
          { type: "text" as const, text: `${echo}${stdout}` },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: index
// ─────────────────────────────────────────────────────────

registerCtxTool(
  "ctx_index",
  {
    title: "Index Content",
    // #846: writes content into the local FTS5 store (additive, not destructive;
    // re-indexing the same content adds rows, so not idempotent). No network.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: "Index text, files, or directories into the persistent knowledge base for later ctx_search retrieval.",
    inputSchema: z.object({
      cwd: z.string().optional().describe("Project directory used to scope paths and the persistent index."),
      content: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Small inline text/markdown to index. Use path for files, directories, or large content saved to disk; provide content OR path, not both.",
        ),
      path: z
        .string()
        .min(1)
        .optional()
        .describe("File or directory path to index; preferred for files, directories, or large content saved to disk. Provide path OR content, not both."),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')",
        ),
      include: z.array(z.string()).optional().describe(
        "Directory-only: glob patterns to include (default: all matching extensions).",
      ),
      exclude: z.array(z.string()).optional().describe(
        "Directory globs to exclude; common build and vendor directories are skipped by default.",
      ),
      maxDepth: z.number().int().min(0).optional().describe(
        "Directory-only: max recursion depth from root (default: 5).",
      ),
      maxFiles: z.number().int().min(1).optional().describe(
        "Directory-only: hard cap on files indexed (default: 200) — FTS5 blow-up guard.",
      ),
      extensions: z.array(z.string()).optional().describe(
        "Allowed file extensions when indexing a directory.",
      ),
      respectGitignore: z.boolean().optional().describe(
        "Directory-only: apply nearest .gitignore (default: true).",
      ),
      followSymlinks: z.boolean().optional().describe(
        "Directory-only: follow directory symlinks (default: false — cycle hazard + escape risk).",
      ),
    }),
  },
  async ({ content, path, source, include, exclude, maxDepth, maxFiles, extensions, respectGitignore, followSymlinks }) => {
    if ((content === undefined) === (path === undefined)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Provide exactly one of content or path.",
          },
        ],
        isError: true,
      };
    }

    if (path) {
      const boundaryDenied = checkProjectBoundary(path, "ctx_index");
      if (boundaryDenied) return boundaryDenied;
    }

    // Apply Read deny-policy to prevent indexing sensitive files into the
    // FTS5 store, which would otherwise be queryable via ctx_search and
    // exfiltrate content into the model's context (issue #442). Mirrors the
    // check ctx_execute_file already performs.
    if (path) {
      const pathDenied = checkFilePathDenyPolicy(path);
      if (pathDenied) return pathDenied;
    }

    try {
      const resolvedPath = path ? resolveProjectPath(path) : undefined;

      // Directory dispatch (#687, reported by @matiasduartee). When the
      // resolved path is a directory, walk it bounded and re-enter `index()`
      // per-file so the security gate at store.ts:845 (TOCTOU defense from
      // #442 round-3) keeps running for every file.
      //
      // Root-level symlink defense: the deny-glob check above ran on the
      // user-supplied `path`. If `path` is a symlink whose target lands in
      // a sensitive directory (e.g. `/tmp/link -> /etc`), statSync would
      // happily report directory and walkDirectoryDetailed would
      // realpathSync internally, walking /etc with the user's deny globs
      // bound to /tmp/link instead of the real target. Detect the symlink
      // with lstatSync, follow it once, and re-apply the deny check
      // against the realpath so the user's deny globs see the actual
      // walk root.
      if (resolvedPath && existsSync(resolvedPath)) {
        const lst = lstatSync(resolvedPath);
        if (lst.isSymbolicLink()) {
          let realTarget: string;
          try {
            realTarget = realpathSync(resolvedPath);
          } catch {
            return {
              content: [{ type: "text" as const, text: "Error: symlink target could not be resolved." }],
            };
          }
          if (realTarget !== resolvedPath) {
            const realDenied = checkFilePathDenyPolicy(realTarget);
            if (realDenied) return realDenied;
          }
        }
      }
      if (resolvedPath && existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        const store = getStore();
        const projectDir = getProjectDir();
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const isWin32 = process.platform === "win32";
        const perFileDeny = (absPath: string): boolean => {
          try {
            return evaluateFilePath(absPath, denyGlobs, isWin32, projectDir).denied;
          } catch {
            return false; // fail-open consistent with checkFilePathDenyPolicy
          }
        };
        const dirResult = store.indexDirectory({
          path: resolvedPath,
          source: source ?? resolvedPath,
          perFileDeny,
          include,
          exclude,
          maxDepth,
          maxFiles,
          extensions,
          respectGitignore,
          followSymlinks,
        });
        const capNote = dirResult.capped
          ? ` (cap reached — only first ${dirResult.filesIndexed} of ${dirResult.totalSeen}+ files; raise maxFiles to index more)`
          : "";
        const denyNote = dirResult.denied > 0
          ? ` (${dirResult.denied} file${dirResult.denied === 1 ? "" : "s"} blocked by Read deny policy)`
          : "";
        const failNote = dirResult.failed > 0
          ? ` (${dirResult.failed} file${dirResult.failed === 1 ? "" : "s"} failed to read)`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Indexed ${dirResult.filesIndexed} file${dirResult.filesIndexed === 1 ? "" : "s"} (${dirResult.totalChunks} sections) from directory: ${dirResult.label}${capNote}${denyNote}${failNote}\nUse ctx_search(queries: ["..."]) to query this content.`,
            },
          ],
        };
      }

      const store = getStore();
      const result = store.index({ content, path: resolvedPath, source: source ?? resolvedPath });

      return {
        content: [
          {
            type: "text" as const,
            text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Index error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: search — progressive throttling
// ─────────────────────────────────────────────────────────

function readPositiveEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const SEARCH_WINDOW_MS = readPositiveEnv("CONTEXT_MODE_SEARCH_WINDOW_MS", 60_000);
const SEARCH_MAX_RESULTS_AFTER = readPositiveEnv("CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER", 3);
const SEARCH_BLOCK_AFTER = readPositiveEnv("CONTEXT_MODE_SEARCH_BLOCK_AFTER", 8);
let searchWindowStart = 0;
let searchCallCount = 0;

function recordSearch(now: number): { count: number; windowStart: number; blocked: boolean; softCapped: boolean } {
  if (!searchWindowStart || now - searchWindowStart > SEARCH_WINDOW_MS) {
    searchWindowStart = now;
    searchCallCount = 0;
  }
  searchCallCount++;
  return {
    count: searchCallCount,
    windowStart: searchWindowStart,
    blocked: searchCallCount > SEARCH_BLOCK_AFTER,
    softCapped: searchCallCount > SEARCH_MAX_RESULTS_AFTER,
  };
}

registerCtxTool(
  "ctx_search",
  {
    title: "Search Indexed Content",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Search indexed content. Batch related questions in queries; use source to narrow retrieval.",
    inputSchema: z.object({
      cwd: z.string().optional().describe("Project directory used to scope the persistent index."),
      queries: z.array(z.string()).min(1).describe("Array of search queries. Batch ALL questions in one call."),
      limit: z.coerce.number().optional().default(3).describe("Results per query (default: 3)"),
      source: z.string().optional().describe("Filter to a specific indexed source (partial match)."),
      contentType: z.enum(["code", "prose"]).optional().describe("Filter results by content type: 'code' or 'prose'."),
    }),
  },
  async ({ queries, limit = 3, source, contentType }) => {
    try {
      const store = getStore();
      if (store.isEmpty()) {
        return {
          content: [{
            type: "text" as const,
            text: "Knowledge base is empty — index content first with ctx_batch_execute, ctx_fetch_and_index, or ctx_index.",
          }],
          isError: true,
        };
      }

      const now = Date.now();
      const flood = recordSearch(now);
      if (flood.blocked) {
        return {
          content: [{
            type: "text" as const,
            text: `BLOCKED: ${flood.count} search calls in ${Math.round((now - flood.windowStart) / 1000)}s. Batch queries or use ctx_batch_execute.`,
          }],
          isError: true,
        };
      }

      const effectiveLimit = flood.softCapped ? 1 : Math.min(limit, 2);
      const sections: string[] = [];
      let totalSize = 0;
      const MAX_TOTAL = 40 * 1024;

      for (const q of queries) {
        if (totalSize > MAX_TOTAL) {
          sections.push(`## ${q}\n(output cap reached)`);
          continue;
        }
        const results = store.searchWithFallback(q, effectiveLimit, source, contentType);
        if (results.length === 0) {
          sections.push(`## ${q}\nNo results found.`);
          continue;
        }
        const formatted = results.map((r) => {
          const ts = r.timestamp ? r.timestamp.slice(0, 16).replace("T", " ") : "";
          const header = `--- [${r.source}${ts ? " | " + ts : ""}] ---`;
          return `${header}\n### ${r.title}\n\n${extractSnippet(r.content, q, 1500, r.highlighted)}`;
        }).join("\n\n");
        sections.push(`## ${q}\n\n${formatted}`);
        totalSize += formatted.length;
      }

      let output = sections.join("\n\n---\n\n");
      if (store.lastRefreshCount > 0) {
        output = `> Auto-refreshed ${store.lastRefreshCount} stale source${store.lastRefreshCount > 1 ? "s" : ""}.\n\n${output}`;
      }
      return { content: [{ type: "text" as const, text: output }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Search error: ${message}` }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Turndown path resolution (external dep, like better-sqlite3)
// ─────────────────────────────────────────────────────────

let _turndownPath: string | null = null;
let _gfmPluginPath: string | null = null;

function resolveTurndownPath(): string {
  if (!_turndownPath) {
    const require = createRequire(import.meta.url);
    _turndownPath = require.resolve("turndown");
  }
  return _turndownPath;
}

function resolveGfmPluginPath(): string {
  if (!_gfmPluginPath) {
    const require = createRequire(import.meta.url);
    _gfmPluginPath = require.resolve("turndown-plugin-gfm");
  }
  return _gfmPluginPath;
}

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

// Subprocess code that fetches a URL, detects Content-Type, and outputs a
// __CM_CT__:<type> marker on the first line so the handler can route to the
// appropriate indexing strategy.  HTML is converted to markdown via Turndown.
export function buildFetchCode(url: string, outputPath: string): string {
  const turndownPath = JSON.stringify(resolveTurndownPath());
  const gfmPath = JSON.stringify(resolveGfmPluginPath());
  const escapedOutputPath = JSON.stringify(outputPath);
  // Embed classifyIp into the subprocess so the connect-time DNS lookup is
  // re-validated with the same policy as ssrfGuard. Without this, an attacker
  // can serve a public IP for the parent's pre-flight ssrfGuard lookup and
  // then a blocked IP (e.g. 169.254.169.254 IMDS) for the subprocess fetch's
  // own lookup — classic DNS rebinding across the parent/child boundary.
  //
  // CRITICAL: bundlers (esbuild) rename top-level identifiers — `classifyIp`
  // becomes e.g. `_h` in server.bundle.mjs. `classifyIp.toString()` returns
  // the renamed source `function _h(t){...}`, but the embedded subprocess
  // template references the literal name `classifyIp` (and the function's
  // own internal recursion is also `_h(...)`). Result: the subprocess sees
  // `function _h(t){...; return _h(...)}` injected, then references to
  // `classifyIp` blow up with `ReferenceError: classifyIp is not defined`.
  //
  // Fix: emit `var <fnName> = <fn-expr>; var classifyIp = <fnName>;`. The
  // named function expression preserves recursion under whatever name the
  // bundler chose, and the alias re-exposes the canonical `classifyIp`
  // identifier the rest of the embedded script depends on.
  const classifyIpInner = classifyIp.toString();
  const classifyIpFnName = classifyIp.name || "classifyIp";
  const classifyIpSrc =
    classifyIpFnName === "classifyIp"
      ? `var classifyIp = ${classifyIpInner};`
      : `var ${classifyIpFnName} = ${classifyIpInner};\nvar classifyIp = ${classifyIpFnName};`;
  const strictMode = process.env.CTX_FETCH_STRICT === "1";
  return `
const TurndownService = require(${turndownPath});
const { gfm } = require(${gfmPath});
const fs = require('fs');
const dns = require('no' + 'de:dns');
const dnsPromises = require('no' + 'de:dns/promises');
const url = ${JSON.stringify(url)};
const outputPath = ${escapedOutputPath};

// Strip proxy env vars from this subprocess only. A configured outbound
// proxy (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY) would route fetch through
// an arbitrary target — DNS resolution happens at the proxy and the
// in-subprocess DNS rebinding guard never sees the rebound IP. The
// sandbox fetch path has no legitimate need for an upstream proxy.
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.all_proxy;
delete process.env.npm_config_proxy;
delete process.env.npm_config_https_proxy;

${classifyIpSrc}

const STRICT = ${JSON.stringify(strictMode)};

// SSRF rebinding defense: every dns.lookup call inside this subprocess
// (including the one undici performs to connect the fetch socket) is
// re-validated against the same policy ssrfGuard runs in the parent.
// Even if a hostname rebinds between the parent's pre-flight check and
// the subprocess's actual connect, the connect-time lookup re-classifies
// every returned record and aborts before TCP if any verdict is "block".
const _origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') { options = { family: options }; }
  const wantAll = options && options.all;
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  _origLookup(hostname, opts, function(err, records) {
    if (err) return callback(err);
    if (!Array.isArray(records)) {
      records = [{ address: records, family: (options && options.family) || 4 }];
    }
    for (var i = 0; i < records.length; i++) {
      var verdict = classifyIp(records[i].address);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        return callback(new Error(
          'SSRF blocked at connect-time: ' + hostname +
          ' resolves to ' + records[i].address +
          ' (' + verdict + ')'
        ));
      }
    }
    if (wantAll) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  });
};

// dns/promises is a separate function reference. Patching dns.lookup does
// NOT affect dnsPromises.lookup. Today undici's connect path uses callback
// dns.lookup so default fetch is covered, but the invariant is fragile —
// any future undici switch (or user code calling dnsPromises.lookup
// directly) would bypass the guard. Patch both to keep the contract.
const _origPromisesLookup = dnsPromises.lookup;
dnsPromises.lookup = async function patchedPromisesLookup(hostname, options) {
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  const records = await _origPromisesLookup(hostname, opts);
  const list = Array.isArray(records) ? records : [records];
  for (var i = 0; i < list.length; i++) {
    var verdict = classifyIp(list[i].address);
    if (verdict === 'block' || (STRICT && verdict === 'private')) {
      throw new Error(
        'SSRF blocked at connect-time: ' + hostname +
        ' resolves to ' + list[i].address + ' (' + verdict + ')'
      );
    }
  }
  return options && options.all
    ? list
    : { address: list[0].address, family: list[0].family };
};

// dns.resolve4 / dns.resolve6 use a different code path (no getaddrinfo,
// no /etc/hosts) than dns.lookup — they must be patched separately or the
// guard is trivially bypassed by any caller using dns.resolve* directly.
['resolve4', 'resolve6'].forEach(function patchResolve(name) {
  const _origResolve = dns[name];
  dns[name] = function patchedResolve(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = undefined; }
    _origResolve.call(dns, hostname, options || {}, function(err, addrs) {
      if (err) return cb(err);
      var withTtl = options && options.ttl;
      for (var i = 0; i < addrs.length; i++) {
        var ip = withTtl ? addrs[i].address : addrs[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
      cb(null, addrs);
    });
  };
});

// Generic dns.resolve is a polymorphic dispatcher (rrtype-driven). Internally
// Node delegates to dns.resolve4/dns.resolve6 for A/AAAA, but the patches
// above hook the *exported* references — Node's internal dispatcher holds
// captured originals and bypasses our patch. Patch the wrapper explicitly:
// classify A/AAAA records the same way; pass through CNAME/MX/TXT/SRV/etc.
const _origResolveGeneric = dns.resolve;
dns.resolve = function patchedResolveGeneric(hostname, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
  _origResolveGeneric.call(dns, hostname, rrtype, function(err, records) {
    if (err) return cb(err);
    if ((rrtype === 'A' || rrtype === 'AAAA') && Array.isArray(records)) {
      for (var i = 0; i < records.length; i++) {
        var ip = records[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
    }
    cb(null, records);
  });
};

function emit(ct, content) {
  // Write content to file to bypass executor stdout truncation (100KB limit).
  // Only the content-type marker goes to stdout.
  fs.writeFileSync(outputPath, content);
  console.log('__CM_CT__:' + ct);
}

// Manual redirect handling: a 3xx Location header can rebind the subprocess
// fetch to an alternate host the parent's pre-flight ssrfGuard never saw.
// Even with the connect-time DNS patch, a redirect target that is a literal
// IP (e.g. http://169.254.169.254/) skips getaddrinfo entirely. Walk the
// chain manually so every hop runs through classifyIp before the next fetch.
const MAX_REDIRECTS = 5;
async function fetchWithManualRedirect(initialUrl) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const resp = await fetch(currentUrl, { redirect: 'manual' });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get('location') || resp.headers.get('Location');
    if (!location) return resp;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
    }
    let nextParsed;
    try { nextParsed = new URL(location, currentUrl); } catch (e) {
      throw new Error('SSRF blocked: invalid redirect Location: ' + location);
    }
    if (nextParsed.protocol !== 'http:' && nextParsed.protocol !== 'https:') {
      throw new Error('SSRF blocked: redirect to non-http(s) scheme ' + nextParsed.protocol);
    }
    // If the redirect target is a literal IP, classify it directly — no DNS
    // lookup will fire and the connect-time guard would never see it.
    const hostname = nextParsed.hostname.replace(/^\[|\]$/g, '');
    const isIpLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
    if (isIpLiteral) {
      const verdict = classifyIp(hostname);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        throw new Error('SSRF blocked: redirect to ' + hostname + ' (' + verdict + ')');
      }
    } else {
      // Hostname target: resolve and classify every record. The patched
      // dns.lookup also fires on the next fetch's connect, but checking
      // here gives a clearer error and short-circuits before TCP setup.
      const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
      for (const rec of records) {
        const verdict = classifyIp(rec.address);
        if (verdict === 'block' || (STRICT && verdict === 'private')) {
          throw new Error(
            'SSRF blocked: redirect target ' + hostname +
            ' resolves to ' + rec.address + ' (' + verdict + ')'
          );
        }
      }
    }
    currentUrl = nextParsed.toString();
  }
  throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
}

// Subprocess response-body size cap. A malicious or unexpectedly large
// endpoint reachable through ctx_fetch_and_index would otherwise stream
// gigabytes into resp.text(), then into outputPath, then into the parent
// MCP server's heap via readFileSync. 50 MB is far above typical web
// page / API response sizes (~1-5 MB) but bounded enough to keep parent
// heap survivable. Cap both early via Content-Length and after the read.
const MAX_FETCH_BYTES = 50 * 1024 * 1024;
async function safeText(resp) {
  const cl = parseInt(resp.headers.get('content-length') || '0', 10);
  if (cl > MAX_FETCH_BYTES) {
    throw new Error('Response too large: Content-Length ' + cl + ' exceeds ' + MAX_FETCH_BYTES);
  }
  const text = await resp.text();
  if (text.length > MAX_FETCH_BYTES) {
    throw new Error('Response too large: ' + text.length + ' bytes exceeds ' + MAX_FETCH_BYTES);
  }
  return text;
}

async function main() {
  const resp = await fetchWithManualRedirect(url);
  if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
  const contentType = resp.headers.get('content-type') || '';

  // --- JSON responses ---
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await safeText(resp);
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      emit('json', pretty);
    } catch {
      emit('text', text);
    }
    return;
  }

  // --- HTML responses (default for text/html, application/xhtml+xml) ---
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const html = await safeText(resp);
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    td.use(gfm);
    td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
    emit('html', td.turndown(html));
    return;
  }

  // --- Everything else: plain text, CSV, XML, etc. ---
  const text = await safeText(resp);
  emit('text', text);
}
main();
`;
}

// ─────────────────────────────────────────────────────────
// fetch_and_index helpers — split into parallel-safe fetch and serial-only index
// ─────────────────────────────────────────────────────────

const FETCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_PREVIEW_LIMIT = 3072;

function formatFetchTtl(ttlMs: number): string {
  if (ttlMs === 0) return "0ms";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (ttlMs % day === 0) return `${ttlMs / day}d`;
  if (ttlMs % hour === 0) return `${ttlMs / hour}h`;
  if (ttlMs % minute === 0) return `${ttlMs / minute}m`;
  return `${ttlMs}ms`;
}

type FetchOneResult =
  | { kind: "cached"; label: string; chunkCount: number; estimatedBytes: number; ageStr: string; ttlStr: string }
  | { kind: "fetched"; url: string; source?: string; markdown: string; header: string }
  | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" };

/**
 * Pure fetch step — TTL cache check + subprocess fetch. SAFE TO RUN IN PARALLEL.
 * Performs zero SQLite writes (only reads source meta). Caller must funnel
 * fetched results through `indexFetched` serially to avoid FTS5 WAL contention.
 */
/**
 * SSRF guard for ctx_fetch_and_index: validate URL scheme + resolve target IP +
 * block link-local / IMDS / multicast / reserved IP ranges. Returns null if
 * safe; returns a FetchOneResult fetch_error if blocked.
 *
 * Policy (PR #401 ops review, developer-friendly default):
 *
 * **HARD BLOCK** (no legitimate dev workflow):
 *   - file://, gopher://, javascript:, data: schemes (only http: and https:)
 *   - 169.254.0.0/16 link-local (INCLUDES 169.254.169.254 = AWS/GCP/Azure IMDS
 *     cloud credential endpoint — high-value target for indirect prompt injection)
 *   - IPv6 link-local fe80::/10
 *   - Multicast (224+ IPv4, ff00::/8 IPv6) and reserved (0.0.0.0/8) ranges
 *
 * **ALLOW by default** (legitimate developer use cases dominate):
 *   - localhost, 127.x.x.x, ::1 (local dev servers — Next.js, Vite, Postgres, …)
 *   - 10.x, 172.16-31.x, 192.168.x RFC1918 private (developer's internal network)
 *
 * **STRICT MODE** opt-in via env var: `CTX_FETCH_STRICT=1`
 *   - Blocks loopback + RFC1918 too
 *   - For hosted/CI environments where the runtime isn't the user's own machine
 *
 * DNS resolution is performed against the resolved IP (not just URL parse) so a
 * hostname like `evil.com` pointing to 169.254.169.254 is rejected — defends
 * against attacker-controlled DNS records and DNS rebinding.
 */
async function ssrfGuard(rawUrl: string): Promise<FetchOneResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "fetch_error", url: rawUrl, error: "invalid URL", reason: "exit" };
  }

  // 1. Scheme allowlist — http and https only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `URL scheme "${parsed.protocol}" not allowed (only http: and https:)`,
      reason: "exit",
    };
  }

  const strict = process.env.CTX_FETCH_STRICT === "1";

  // 2. DNS resolve + check IP ranges (hard-block + optional strict-mode block)
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    for (const rec of records) {
      const verdict = classifyIp(rec.address);
      if (verdict === "block") {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to ${rec.address} — blocked (link-local / IMDS / multicast / reserved)`,
          reason: "exit",
        };
      }
      if (verdict === "private" && strict) {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to private IP ${rec.address} — blocked under CTX_FETCH_STRICT=1`,
          reason: "exit",
        };
      }
    }
  } catch (err) {
    // libuv DNS error codes that typically indicate the resolver itself can't
    // reach a nameserver — common when the MCP host process is running under
    // a sandbox that blocks outbound network, OR a transient upstream DNS
    // hiccup. Append an imperative retry hint so the agent does not capitulate
    // to training data on the FIRST transient failure (PR #654 substitute —
    // Keep fetch error wording consistent across call sites.
    const errCode = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
    const isTransientDns = errCode === "ETIMEOUT" || errCode === "ETIMEDOUT" ||
      errCode === "EAI_AGAIN" || errCode === "ENETUNREACH" || errCode === "EPERM";
    const baseMsg = err instanceof Error ? err.message : String(err);
    const hint = isTransientDns
      ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
      : "";
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `DNS lookup failed for "${parsed.hostname}": ${baseMsg}${hint}`,
      reason: "exit",
    };
  }

  return null; // safe to fetch
}

/**
 * Classify an IP address.
 *   - "block":    always blocked (link-local/IMDS/multicast/reserved/malformed)
 *   - "private":  loopback or RFC1918 — allowed by default, blocked in strict mode
 *   - "public":   safe to fetch
 *
 * Exported (via the function name) so SSRF tests can exercise the matcher directly.
 */
export function classifyIp(rawIp: string): "block" | "private" | "public" {
  // RFC 6874 zone identifiers (`fe80::1%eth0`, URL-encoded `%25eth0`) must
  // be stripped BEFORE any prefix/equality classification. Without the strip,
  // a loopback `::1%eth0` no longer matches `lower === "::1"` and falls
  // through to "public" — silently bypassing the SSRF guard. Strip first,
  // classify second.
  const pctIdx = rawIp.indexOf("%");
  const ip = pctIdx === -1 ? rawIp : rawIp.slice(0, pctIdx);
  const lower = ip.toLowerCase();

  // IPv6 takes priority — check for `:` first so IPv4-mapped addresses
  // (`::ffff:127.0.0.1`) don't get incorrectly routed through the IPv4 parser.
  if (lower.includes(":")) {
    // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — recurse through IPv4 classifier
    const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
    if (v4MappedMatch) return classifyIp(v4MappedMatch[1]);
    // Hard-block
    if (lower === "::") return "block"; // unspecified
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return "block"; // fe80::/10 link-local
    if (lower.startsWith("ff")) return "block"; // ff00::/8 multicast
    // Private (loopback + ULA)
    if (lower === "::1") return "private";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7 ULA
    return "public";
  }

  // IPv4 (or non-IP string — malformed = block)
  if (!ip.includes(".")) return "block"; // not an IP at all
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return "block";
  const [a, b] = parts;
  // Hard-block (no legitimate use)
  if (a === 169 && b === 254) return "block"; // link-local incl. 169.254.169.254 (IMDS)
  if (a === 0) return "block";                 // 0.0.0.0/8 (current network)
  if (a >= 224) return "block";                // 224.0.0.0+ multicast/reserved
  // Private (loopback + RFC1918) — allow by default
  if (a === 127) return "private";                          // 127.0.0.0/8 loopback
  if (a === 10) return "private";                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private";    // 172.16.0.0/12
  if (a === 192 && b === 168) return "private";             // 192.168.0.0/16
  return "public";
}

async function fetchOneUrl(url: string, source: string | undefined, force: boolean | undefined, ttl: number | undefined): Promise<FetchOneResult> {
  // SSRF guard — reject file://, javascript:, loopback, RFC1918, IMDS, link-local
  // BEFORE any cache lookup or subprocess spawn. Even cached entries shouldn't
  // serve a previously-poisoned source label.
  const ssrfBlock = await ssrfGuard(url);
  if (ssrfBlock) return ssrfBlock;

  if (!force && ttl !== 0) {
    const store = getStore();
    // Cache key composes (source, url) so two distinct URLs sharing the same
    // `source` label do not collide — they each get their own cache slot
    // (commit 1f1243e regression test enforced).
    const cacheKey = source === undefined ? url : `${source}::${url}`;
    const meta = store.getSourceMeta(cacheKey);
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
      const ageMs = Date.now() - indexedAt.getTime();
      const cacheTtlMs = ttl ?? FETCH_TTL_MS;
      if (ageMs < cacheTtlMs) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        const estimatedBytes = meta.chunkCount * 1600; // ~1.6KB/chunk avg
        return { kind: "cached", label: meta.label, chunkCount: meta.chunkCount, estimatedBytes, ageStr, ttlStr: formatFetchTtl(cacheTtlMs) };
      }
      // Stale — fall through to re-fetch silently
    }
  }

  const outputPath = join(tmpdir(), `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
  try {
    const fetchCode = buildFetchCode(url, outputPath);
    const result = await executor.execute({
      language: "javascript",
      code: fetchCode,
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      // Subprocess fetch failure — undici / fetch can surface EAI_AGAIN /
      // ETIMEDOUT / ENETUNREACH in stderr when the resolver is overloaded
      // or the network is briefly unavailable. Append the same retry hint
      // ssrfGuard's pre-flight DNS path emits so the agent doesn't capitulate
      // to training data on the first transient failure (PR #654 substitute —
      // Keep fetch error wording consistent across call sites.
      const raw = result.stderr || result.stdout || "unknown error";
      const isTransientDns = /\b(EAI_AGAIN|ETIMEDOUT|ETIMEOUT|ENETUNREACH|EPERM|getaddrinfo)\b/.test(raw);
      const hint = isTransientDns
        ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
        : "";
      return { kind: "fetch_error", url, error: `${raw}${hint}`, reason: "exit" };
    }
    const header = (result.stdout || "").trim();
    let markdown: string;
    try {
      // Parent-side defense-in-depth on the subprocess output size. The
      // embedded safeText() in buildFetchCode already caps before writing,
      // but a torn write (subprocess killed mid-write, fs cache desync,
      // etc.) could still leave an oversized file. Bail before slurping
      // multiple gigabytes into the long-running MCP server's heap.
      const MAX_FETCH_OUTPUT_BYTES = 50 * 1024 * 1024;
      const fileSize = statSync(outputPath).size;
      if (fileSize > MAX_FETCH_OUTPUT_BYTES) {
        return { kind: "fetch_error", url, error: `subprocess output ${fileSize} bytes exceeds cap ${MAX_FETCH_OUTPUT_BYTES}`, reason: "read" };
      }
      markdown = readFileSync(outputPath, "utf-8").trim();
    } catch {
      return { kind: "fetch_error", url, error: "could not read subprocess output", reason: "read" };
    }
    if (markdown.length === 0) {
      return { kind: "fetch_error", url, error: "empty content", reason: "empty" };
    }
    return { kind: "fetched", url, source, markdown, header };
  } catch (err: unknown) {
    return {
      kind: "fetch_error",
      url,
      error: err instanceof Error ? err.message : String(err),
      reason: "throw",
    };
  } finally {
    try { rmSync(outputPath); } catch { /* already gone */ }
  }
}

interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
}

/**
 * Serial-only indexing step — single FTS5 write per call. Caller loops over
 * fetched results and calls this one-at-a-time to avoid SQLite WAL contention
 * (PRD finding E).
 */
function indexFetched(f: { url: string; source?: string; markdown: string; header: string }): IndexedFetchResult {
  const store = getStore();
  // Include the URL when a source label is supplied so distinct URLs do not collide.
  const storageLabel = f.source === undefined ? f.url : `${f.source}::${f.url}`;
  let indexed: IndexResult;
  if (f.header === "__CM_CT__:json") {
    indexed = store.indexJSON(f.markdown, storageLabel);
  } else if (f.header === "__CM_CT__:text") {
    indexed = store.indexPlainText(f.markdown, storageLabel);
  } else {
    indexed = store.index({ content: f.markdown, source: storageLabel });
  }
  // Track AFTER the FTS5 write succeeds — failed indexes shouldn't inflate the counter.
  const preview = f.markdown.length > FETCH_PREVIEW_LIMIT
    ? charSafePrefix(f.markdown, FETCH_PREVIEW_LIMIT) + "\n\n…[truncated — use ctx_search() for full content]"
    : f.markdown;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(f.markdown),
    preview,
  };
}

registerCtxTool(
  "ctx_fetch_and_index",
  {
    title: "Fetch & Index URL(s)",
    // #846: fetches external URLs (open world) and writes them into the store.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Fetch and index URL content server-side so raw pages stay out of context. Use ctx_search for follow-up retrieval.",
    inputSchema: z.object({
      cwd: z.string().optional().describe("Project directory used to scope the persistent index."),
      url: z.string().optional().describe("Single URL to fetch and index"),
      source: z
        .string()
        .optional()
        .describe("Label for a single URL; batch requests can set their own source."),
      requests: z.array(
        z.object({
          url: z.string().describe("URL to fetch"),
          source: z.string().optional().describe("Label for this URL's indexed content"),
        }),
      ).min(1).optional().describe("Batch of {url, source?} entries."),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe("Parallel URL fetches, 1-8; indexing remains serial."),
      force: z
        .boolean()
        .optional()
        .describe("Skip cache and re-fetch even if content was recently indexed"),
      ttl: z
        .coerce.number()
        .int()
        .min(0)
        .optional()
        .describe("Cache TTL in ms; 0 bypasses cache."),
    }),
  },
  async ({ url, source, requests, concurrency, force, ttl }) => {
    // Normalize input: legacy {url} or new {requests: [...]}.
    // requests wins when both are provided (explicit batch intent).
    const batch: { url: string; source?: string }[] = requests
      ? requests
      : url
        ? [{ url, source }]
        : [];

    if (batch.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "ctx_fetch_and_index requires either `url` (single) or `requests: [{url, source?}, ...]` (batch).",
        }],
        isError: true,
      };
    }

    const isLegacySingle = !requests && batch.length === 1;
    const requestedConcurrency = concurrency ?? 1;

    // Parallel fetch via shared runPool primitive. capByCpuCount only for batch
    // — single-URL doesn't need the cap (only one job, executor is one subprocess).
    const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
      run: () => fetchOneUrl(req.url, req.source, force, ttl),
    }));
    const { settled, effectiveConcurrency, capped } = await runPool(jobs, {
      concurrency: requestedConcurrency,
      capByCpuCount: !isLegacySingle && requestedConcurrency > 1,
    });

    // Serial index drain — workers race on fetch, but store.index* runs one at a time.
    type Finalized =
      | { kind: "cached"; label: string; chunkCount: number; ageStr: string; ttlStr: string }
      | { kind: "fetched"; indexed: IndexedFetchResult }
      | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" }
      | { kind: "job_error"; url: string; error: string };

    const finalized: Finalized[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === "rejected") {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        finalized.push({ kind: "job_error", url: batch[i].url, error: message });
        continue;
      }
      const v = r.value;
      if (v.kind === "cached") {
        finalized.push({ kind: "cached", label: v.label, chunkCount: v.chunkCount, ageStr: v.ageStr, ttlStr: v.ttlStr });
      } else if (v.kind === "fetch_error") {
        finalized.push({ kind: "fetch_error", url: v.url, error: v.error, reason: v.reason });
      } else {
        // Serial FTS5 write here — no parallel store.index calls.
        // Cache miss: fetch and index the content.
        finalized.push({ kind: "fetched", indexed: indexFetched(v) });
      }
    }

    // Backward-compat single-URL response shape — preserve the EXACT original wording.
    if (isLegacySingle) {
      const r = finalized[0];
      if (r.kind === "cached") {
        return {
          content: [{
            type: "text" as const,
            text: `Cached: **${r.label}** — ${r.chunkCount} sections, indexed ${r.ageStr} (fresh, TTL: ${r.ttlStr}).\nTo refresh: call ctx_fetch_and_index again with \`force: true\`.\n\nYou MUST call ctx_search() to answer questions about this content — this cached response contains no content.\nUse: ctx_search(queries: [...], source: "${r.label}")`,
          }],
        };
      }
      if (r.kind === "fetched") {
        const totalKB = (r.indexed.totalBytes / 1024).toFixed(1);
        const text = [
          `Fetched and indexed **${r.indexed.totalChunks} sections** (${totalKB}KB) from: ${r.indexed.label}`,
          `Full content indexed in the persistent store — use ctx_search(queries: [...], source: "${r.indexed.label}") for specific lookups.`,
          "",
          "---",
          "",
          r.indexed.preview,
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
        };
      }
      // fetch_error — preserve original error wording per reason
      if (r.kind === "fetch_error") {
        const text =
          r.reason === "empty" ? `Fetched ${r.url} but got empty content`
          : r.reason === "read" ? `Fetched ${r.url} but could not read subprocess output`
          : r.reason === "exit" ? `Failed to fetch ${r.url}: ${r.error}`
          : /* throw */         `Fetch error: ${r.error}`;
        return {
          content: [{ type: "text" as const, text }],
          isError: true,
        };
      }
      // job_error
      return {
        content: [{ type: "text" as const, text: `Fetch error: ${r.error}` }],
        isError: true,
      };
    }

    // Batch response — aggregated summary; isError only when EVERY URL failed.
    // Per-URL preview capped tightly so a 8-URL batch doesn't undo the
    // context-savings the tool exists to deliver (PRD review finding G1).
    const FETCH_BATCH_PREVIEW_LIMIT = 384; // ~3KB total for 8-URL batches
    const lines: string[] = [];
    let totalSections = 0;
    let totalBytes = 0;
    let cachedCount = 0;
    let fetchedCount = 0;
    let errorCount = 0;
    const snippets: string[] = [];
    for (const r of finalized) {
      if (r.kind === "cached") {
        cachedCount++;
        lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr}, TTL: ${r.ttlStr})`);
      } else if (r.kind === "fetched") {
        fetchedCount++;
        totalSections += r.indexed.totalChunks;
        totalBytes += r.indexed.totalBytes;
        const kb = (r.indexed.totalBytes / 1024).toFixed(1);
        lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
        const snippet = r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
          ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
          : r.indexed.preview;
        snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
      } else {
        errorCount++;
        lines.push(`- [err]   ${r.url}: ${r.error}`);
      }
    }

    const totalKB = (totalBytes / 1024).toFixed(1);
    const cappedNote = capped
      ? ` cap=${effectiveConcurrency}/${cpus().length}cpu`
      : "";
    // Status line: counts + sections + size, with singular/plural agreement
    // (count=1 → "1 error" not "1 errors") so the line stays grammatical.
    const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
    const headerLine =
      `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
      `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
      `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

    const text = [
      headerLine,
      "",
      ...lines,
      "",
      `ctx_search(queries: [...], source: "<label>") for full content.`,
      ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      isError: errorCount === batch.length, // only mark error if every URL failed
    };
  },
);

// ─────────────────────────────────────────────────────────
// Tool: batch_execute
// ─────────────────────────────────────────────────────────

registerCtxTool(
  "ctx_batch_execute",
  {
    title: "Batch Execute & Search (uses MCP server OS permissions)",
    // Runs arbitrary shell commands with the MCP server OS permissions and indexes output.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Run related shell commands with the MCP server OS permissions, index their output, and return query matches. Use for related or large-output commands.",
    inputSchema: z.object({
      commands: z.array(
          z.object({
            label: z
              .string()
              .describe(
                "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
              ),
            command: z
              .string()
              .describe("Shell command to execute"),
          }),
        )
        .min(1)
        .describe("Commands to run; labels become indexed section headers."),
      queries: z.array(z.string())
        .min(1)
        .describe("Queries to extract from indexed batch output."),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms per batch or command."),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe("Parallel commands, 1-8; use 1 for stateful or CPU-bound work."),
      cwd: z
        .string()
        .optional()
        .describe("Optional working directory for all shell commands in this batch."),
      query_scope: z
        .enum(["batch", "global"])
        .optional()
        .default("batch")
        .describe("'batch' searches this call; 'global' searches the full index."),
    }),
  },
  async ({ commands, queries, timeout, concurrency, cwd, query_scope }, ctx) => {
    try {
      // Inject NODE_OPTIONS for FS read tracking in spawned Node processes.
      // The executor denies NODE_OPTIONS in its env (security), so we set it
      // as an inline shell prefix. This only affects child `node` invocations.
      const nodeOptsPrefix = buildBatchNodeOptionsPrefix(runtimes.shell, CM_FS_PRELOAD);

      // Full stdout is preserved per-command and indexed into FTS5 (Issue #61, #197).
      // Concurrency>1 switches to a worker pool with per-command timeouts.
      const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(
        commands,
        {
          timeout: timeout,
          concurrency,
          nodeOptsPrefix,
          cwd,
          signal: ctx?.signal,
        },
        executor,
      );

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;
      const indexable = capIndexableOutput(stdout);
      const projectDir = resolveExecutionProjectDir(cwd);

      if (timedOut && perCommandOutputs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${timeout}ms. No output captured.`,
            },
          ],
          isError: true,
        };
      }

      // Track indexed bytes (raw data that stays in the persistent store)

      // Index into knowledge base — markdown heading chunking splits by # labels
      const store = getStore(projectDir);
      const source = `batch:${commands
        .map((c: { label: string; command: string }) => c.label)
        .join(",")
        .slice(0, 80)}`;
      const indexed = store.index({ content: indexable.text, source });

      // Commands inventory — list what the agent actually ran so the
      // response itself documents intent, not just per-section echoes.
      // Placed before "## Indexed Sections" so it scans top-down with
      // the human asking "what just happened" (Issues #717 + #736).
      const commandsInventory: string[] = ["## Commands", ""];
      for (const c of commands) {
        commandsInventory.push(`- ${c.label}: \`${truncateCommandForEcho(c.command)}\``);
      }

      // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory: string[] = ["## Indexed Sections", ""];
      const sectionTitles: string[] = [];
      for (const s of allSections) {
        const bytes = Buffer.byteLength(s.content);
        inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
        sectionTitles.push(s.title);
      }

      // Run all search queries — default scope is batch-local (legacy behavior).
      // When the caller passes query_scope: "global", searches reach the entire
      // persistent index in the same round trip. Cross-source search remains
      // available via explicit ctx_search() as well.
      const queryResults = formatBatchQueryResults(store, queries, source, undefined, query_scope);

      // Get searchable terms for edge cases where follow-up is needed
      const distinctiveTerms = store.getDistinctiveTerms
        ? store.getDistinctiveTerms(indexed.sourceId)
        : [];

      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
          `Indexed ${indexed.totalChunks} sections${indexable.truncated ? ` (output capped at ${(INDEX_OUTPUT_CAP_BYTES / 1024 / 1024).toFixed(0)}MB before indexing)` : ""}. Searched ${queries.length} queries.`,
        "",
        ...commandsInventory,
        "",
        ...inventory,
        "",
        ...queryResults,
        distinctiveTerms.length > 0
          ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
          : "",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Batch execution error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── ctx-doctor: diagnostics (server-side) ─────────────────────────────────
registerCtxTool(
  "ctx_doctor",
  {
    title: "Run Diagnostics",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Diagnose context-mode and return a plain-text [OK]/[WARN]/[FAIL] status report.",
    inputSchema: z.object({}),
  },
  async () => {
    const lines: string[] = ["context-mode doctor", ""];
    lines.push(`[OK] Runtimes: ${available.length} — ${available.join(", ")}`);

    try {
      lines.push(`[OK] Storage content: ${getContentDir()}`);
    } catch (err) {
      lines.push(`[FAIL] Storage content: ${err instanceof Error ? err.message : err}`);
    }

    const testExecutor = new PolyglotExecutor({ runtimes });
    try {
      const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
      lines.push(result.exitCode === 0 && result.stdout.trim() === "ok"
        ? "[OK] Executor: PASS"
        : `[FAIL] Executor: exit ${result.exitCode}`);
    } catch (err) {
      lines.push(`[FAIL] Executor: ${err instanceof Error ? err.message : err}`);
    } finally {
      testExecutor.cleanupBackgrounded();
    }

    let testDb: any;
    try {
      const Database = loadDatabase();
      testDb = new Database(":memory:");
      testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
      testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
      const row = testDb.prepare("SELECT content FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content?: string } | undefined;
      lines.push(row?.content === "hello world" ? "[OK] FTS5 / SQLite: PASS" : "[FAIL] FTS5 / SQLite: unexpected result");
    } catch (err) {
      lines.push(`[FAIL] FTS5 / SQLite: ${err instanceof Error ? err.message : err}`);
    } finally {
      try { testDb?.close(); } catch {}
    }

    lines.push(`[OK] Version: v${VERSION}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ── ctx-purge: explicit project knowledge-base wipe ────────────────────────
function deleteDbFamily(path: string): boolean {
  let deleted = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
      deleted = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return deleted;
}

registerCtxTool(
  "ctx_purge",
  {
    title: "Purge Knowledge Base",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Permanently delete indexed content for the current project. Requires confirm:true.",
    inputSchema: z.object({
      cwd: z.string().optional().describe("Project directory whose knowledge base should be purged."),
      confirm: z.boolean().describe("MUST be true. Destructive operation; false returns 'purge cancelled'."),
    }),
  },
  async ({ confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text" as const, text: "Purge cancelled. Pass confirm: true to proceed." }] };
    }

    if (_store) {
      try { _store.close(); } catch {}
      _store = null;
      _storeProjectDir = null;
    }

    try {
      const projectDir = getProjectDir();
      const currentDir = getContentDir();
      const paths = new Set([
        join(currentDir, `${projectHash(projectDir)}.db`),
        join(currentDir, `${projectHash(projectDir, false)}.db`),
        join(homedir(), ".context-mode", "content", `${projectHash(projectDir, false)}.db`),
      ]);
      let deleted = 0;
      for (const path of paths) if (deleteDbFamily(path)) deleted++;
      return {
        content: [{ type: "text" as const, text: deleted ? `Purged ${deleted} knowledge-base file set(s).` : "Nothing to purge." }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Purge failed: ${err instanceof Error ? err.message : err}` }],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────
// Server construction and startup
// ─────────────────────────────────────────────────────────

export function createContextModeServer(): McpServer {
  const instance = new McpServer(
    { name: "context-mode", version: VERSION },
    { capabilities: { tools: {} } },
  );
  for (const tool of REGISTERED_CTX_TOOLS) {
    (instance.registerTool as any)(tool.name, tool.config, tool.handler);
  }
  return instance;
}

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

function headerMismatchResponse(id: string | number | null, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32020, message },
  }, { status: 400 });
}

async function validateModernStandardHeaders(request: Request, parsedBody?: unknown): Promise<Response | null> {
  if (request.method !== "POST") return null;
  let body = parsedBody;
  if (body === undefined) {
    try { body = await request.clone().json(); } catch { return null; }
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const message = body as Record<string, unknown>;
  const method = typeof message.method === "string" ? message.method : undefined;
  const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params as Record<string, unknown>
    : undefined;
  const meta = params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
    ? params._meta as Record<string, unknown>
    : undefined;
  if (meta?.[PROTOCOL_VERSION_META_KEY] !== MODERN_PROTOCOL_VERSION) return null;

  const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
  const protocolHeader = request.headers.get("mcp-protocol-version");
  if (protocolHeader !== MODERN_PROTOCOL_VERSION) {
    return headerMismatchResponse(id, `MCP-Protocol-Version must be ${MODERN_PROTOCOL_VERSION}`);
  }
  const methodHeader = request.headers.get("mcp-method");
  if (!method || methodHeader !== method) {
    return headerMismatchResponse(id, "Mcp-Method must match the JSON-RPC method");
  }
  const name = typeof params?.name === "string" ? params.name : undefined;
  if (name !== undefined && request.headers.get("mcp-name") !== name) {
    return headerMismatchResponse(id, "Mcp-Name must match params.name");
  }
  return null;
}

export function createContextModeHttpHandler(): McpHttpHandler {
  const inner = createMcpHandler(() => createContextModeServer(), {
    legacy: "stateless",
    onerror: (error) => process.stderr.write(`[context-mode] MCP HTTP error: ${error.message}\n`),
  });
  return {
    fetch: async (request, options) => {
      const rejection = await validateModernStandardHeaders(request, options?.parsedBody);
      return rejection ?? inner.fetch(request, options);
    },
    close: () => inner.close(),
    notify: inner.notify,
    bus: inner.bus,
  };
}

const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BYTES) {
    throw new RequestBodyTooLargeError(`MCP request body exceeds ${MAX_MCP_REQUEST_BYTES} bytes`);
  }
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.byteLength;
    if (total > MAX_MCP_REQUEST_BYTES) {
      throw new RequestBodyTooLargeError(`MCP request body exceeds ${MAX_MCP_REQUEST_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function writeJsonRpcHttpError(res: ServerResponse, status: number, code: number, message: string): Promise<void> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function cleanupRuntime(): void {
  executor.cleanupBackgrounded();
  if (_store) {
    try { _store.close(); } catch {}
    _store = null;
    _storeProjectDir = null;
  }
  try { unlinkSync(CM_FS_PRELOAD); } catch {}
}

export function createContextModeNodeHttpServer(
  handler: McpHttpHandler = createContextModeHttpHandler(),
): NodeHttpServer {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => process.stderr.write(`[context-mode] Node HTTP adapter error: ${error.message}\n`),
  });

  return createServer(async (req, res) => {
    if (!validateHost(req, res)) return;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const body = JSON.stringify({ status: "ok", version: VERSION });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!validateOrigin(req, res)) return;

    try {
      if (req.method === "POST") {
        const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        if (mediaType !== "application/json") {
          await writeJsonRpcHttpError(res, 415, -32600, "Content-Type must be application/json");
          return;
        }
        const body = await readJsonBody(req);
        await nodeHandler(req, res, body);
        return;
      }
      await nodeHandler(req, res);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        await writeJsonRpcHttpError(res, 413, -32600, error.message);
        return;
      }
      if (error instanceof SyntaxError) {
        await writeJsonRpcHttpError(res, 400, -32700, "Parse error");
        return;
      }
      process.stderr.write(`[context-mode] HTTP request failure: ${error instanceof Error ? error.message : String(error)}\n`);
      await writeJsonRpcHttpError(res, 500, -32603, "Internal server error");
    }
  });
}

type ServerArgs = { transport: "stdio" | "http"; host: string; port: number };

function parseServerArgs(argv: string[]): ServerArgs {
  const result: ServerArgs = { transport: "stdio", host: "127.0.0.1", port: 3050 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--transport") {
      if (value !== "stdio" && value !== "http") throw new Error("--transport must be stdio or http");
      result.transport = value;
      i++;
    } else if (arg === "--host") {
      if (!value) throw new Error("--host requires a value");
      result.host = value;
      i++;
    } else if (arg === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
      result.port = port;
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (result.transport === "http" && !LOOPBACK_HOSTS.has(result.host)) {
    throw new Error("HTTP transport must bind to a loopback host");
  }
  return result;
}

async function closeHttpServer(server: NodeHttpServer, handler: McpHttpHandler): Promise<void> {
  await handler.close().catch(() => {});
  await new Promise<void>((resolveClose) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolveClose();
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolveClose();
    });
    server.closeIdleConnections();
  });
}

async function main() {
  const args = parseServerArgs(process.argv.slice(2));
  let closing = false;
  let stdioHandle: StdioServerHandle | undefined;
  let httpServer: NodeHttpServer | undefined;
  let httpHandler: McpHttpHandler | undefined;

  const gracefulShutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      if (httpServer && httpHandler) await closeHttpServer(httpServer, httpHandler);
      if (stdioHandle) await stdioHandle.close();
    } finally {
      cleanupRuntime();
    }
  };

  process.once("SIGINT", () => { void gracefulShutdown().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void gracefulShutdown().then(() => process.exit(0)); });
  process.once("exit", cleanupRuntime);

  if (args.transport === "stdio") {
    stdioHandle = serveStdio(() => createContextModeServer(), {
      legacy: "serve",
      onerror: (error) => process.stderr.write(`[context-mode] stdio error: ${error.message}\n`),
    });
    if (process.stdin.isTTY) {
      console.error(`Context Mode MCP server v${VERSION} running on stdio`);
      console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
    }
    return;
  }

  httpHandler = createContextModeHttpHandler();
  httpServer = createContextModeNodeHttpServer(httpHandler);
  httpServer.requestTimeout = 60_000;
  httpServer.headersTimeout = 30_000;
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer!.once("error", rejectListen);
    httpServer!.listen(args.port, args.host, () => {
      httpServer!.off("error", rejectListen);
      resolveListen();
    });
  });
  console.error(`Context Mode MCP server v${VERSION} listening on http://${args.host}:${args.port}/mcp`);
}

export function isDirectExecution(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl;
  }
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    cleanupRuntime();
    process.exit(1);
  });
}
