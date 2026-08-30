import { resolveExecutionProjectDir, runWithProjectDir } from "../project-context.js";

export interface RegisteredCtxTool {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
}

const SERIALIZED_PROJECT_TOOLS = new Set([
  "ctx_execute",
  "ctx_job_start",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_purge",
]);
const FOREGROUND_EXECUTION_TOOLS = new Set(["ctx_execute", "ctx_execute_file", "ctx_batch_execute"]);

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request cancelled");
}

export function createToolRegistry(isAsyncJobActive: () => boolean): {
  tools: RegisteredCtxTool[];
  register: (
    name: string,
    config: Record<string, unknown>,
    handler: (toolArgs: any, ctx?: { signal?: AbortSignal }) => Promise<any> | any,
  ) => unknown;
} {
  const tools: RegisteredCtxTool[] = [];
  let projectToolLock: Promise<void> = Promise.resolve();

  async function withProjectToolLock<T>(
    projectDir: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const previous = projectToolLock;
    let release!: () => void;
    projectToolLock = new Promise<void>((resolve) => { release = resolve; });
    const run = (async () => {
      await previous;
      try {
        if (signal?.aborted) throw abortReason(signal);
        return await runWithProjectDir(projectDir, fn);
      } finally {
        release();
      }
    })();
    if (!signal) return run;
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      return await Promise.race([run, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  const register = (
    name: string,
    config: Record<string, unknown>,
    handler: (toolArgs: any, ctx?: { signal?: AbortSignal }) => Promise<any> | any,
  ): unknown => {
    const guardedHandler = SERIALIZED_PROJECT_TOOLS.has(name)
      ? (toolArgs: any, ctx?: { signal?: AbortSignal }) => withProjectToolLock(
          resolveExecutionProjectDir(typeof toolArgs?.cwd === "string" ? toolArgs.cwd : undefined),
          ctx?.signal,
          () => {
            if (FOREGROUND_EXECUTION_TOOLS.has(name) && isAsyncJobActive()) {
              return { isError: true, content: [{ type: "text", text: "busy: async job is running; foreground execution is temporarily disabled" }] };
            }
            return handler(toolArgs, ctx);
          },
        )
      : handler;
    tools.push({ name, config, handler: guardedHandler });
    return guardedHandler;
  };

  return { tools, register };
}
