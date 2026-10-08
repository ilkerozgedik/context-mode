import { resolveExecutionProjectDir, resolveProjectScope, runWithProjectDir } from "../project-context.js";

export interface RegisteredCtxTool {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
}

export type RegisterTool = (
  name: string,
  config: Record<string, unknown>,
  handler: (toolArgs: any, ctx?: { signal?: AbortSignal }) => Promise<any> | any,
) => unknown;

// Only execution and purge require a project-wide queue. Store reads/writes
// are synchronous SQLite operations; async URL fetching must not hold this lock.
const SERIALIZED_PROJECT_TOOLS = new Set([
  "ctx_execute",
  "ctx_job_start",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_purge",
]);
const FOREGROUND_EXECUTION_TOOLS = new Set(["ctx_execute", "ctx_execute_file", "ctx_batch_execute"]);

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request cancelled");
}

export function createToolRegistry(isAsyncJobActive: (projectDir: string) => boolean): {
  tools: RegisteredCtxTool[];
  register: RegisterTool;
} {
  const tools: RegisteredCtxTool[] = [];
  const projectToolLocks = new Map<string, Promise<void>>();

  async function withProjectToolLock<T>(
    executionDir: string,
    signal: AbortSignal | undefined,
    fn: (projectScope: string) => Promise<T> | T,
  ): Promise<T> {
    const projectScope = resolveProjectScope(executionDir);
    const previous = projectToolLocks.get(projectScope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const tail = previous.then(() => current);
    projectToolLocks.set(projectScope, tail);
    void tail.finally(() => {
      if (projectToolLocks.get(projectScope) === tail) projectToolLocks.delete(projectScope);
    });
    try {
      if (signal?.aborted) throw abortReason(signal);
      if (signal) {
        let onAbort!: () => void;
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          await Promise.race([previous, aborted]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } else {
        await previous;
      }
      if (signal?.aborted) throw abortReason(signal);
      return await runWithProjectDir(executionDir, () => fn(projectScope));
    } finally {
      release();
    }
  }

  const register: RegisterTool = (name, config, handler) => {
    const guardedHandler = (toolArgs: any, ctx?: { signal?: AbortSignal }) => {
      const requestedCwd = typeof toolArgs?.cwd === "string" ? toolArgs.cwd : undefined;
      const executionDir = resolveExecutionProjectDir(requestedCwd);
      const normalizedArgs = requestedCwd === undefined ? toolArgs : { ...toolArgs, cwd: executionDir };
      const invoke = (projectScope: string) => {
        if (FOREGROUND_EXECUTION_TOOLS.has(name) && isAsyncJobActive(projectScope)) {
          return { isError: true, content: [{ type: "text", text: "busy: async job is running for this project; foreground execution is temporarily disabled" }] };
        }
        return handler(normalizedArgs, ctx);
      };
      if (SERIALIZED_PROJECT_TOOLS.has(name)) return withProjectToolLock(executionDir, ctx?.signal, invoke);
      // Preserve async-local cwd without waiting for unrelated commands or fetches.
      if (ctx?.signal?.aborted) throw abortReason(ctx.signal);
      return runWithProjectDir(executionDir, () => invoke(resolveProjectScope(executionDir)));
    };
    tools.push({ name, config, handler: guardedHandler });
    return guardedHandler;
  };

  return { tools, register };
}
