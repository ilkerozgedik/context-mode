import { resolveExecutionProjectDir, runWithProjectDir } from "../project-context.js";

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

export function createToolRegistry(): { tools: RegisteredCtxTool[]; register: RegisterTool } {
  const tools: RegisteredCtxTool[] = [];
  const register: RegisterTool = (name, config, handler) => {
    const guardedHandler = (toolArgs: any, ctx?: { signal?: AbortSignal }) => {
      if (ctx?.signal?.aborted) throw ctx.signal.reason ?? new Error("Request cancelled");
      const requestedCwd = typeof toolArgs?.cwd === "string" ? toolArgs.cwd : undefined;
      const executionDir = resolveExecutionProjectDir(requestedCwd);
      const normalizedArgs = requestedCwd === undefined ? toolArgs : { ...toolArgs, cwd: executionDir };
      return runWithProjectDir(executionDir, () => handler(normalizedArgs, ctx));
    };
    tools.push({ name, config, handler: guardedHandler });
    return guardedHandler;
  };
  return { tools, register };
}
