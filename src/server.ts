#!/usr/bin/env node
import { McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Server as NodeHttpServer } from "node:http";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredExecutionAdmissionError } from "./executor.js";
import { getRuntimeSummary } from "./runtime.js";
import { createLoopbackMcpHttpServer, createStrictMcpHttpHandler } from "./mcp/http.js";
import { closeHttpServer, isDirectExecution, parseServerArgs } from "./cli.js";
import { createToolRegistry, type RegisteredCtxTool } from "./tools/registry.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerIndexingTools } from "./tools/indexing.js";
import { registerFetchTools } from "./tools/fetch.js";
import { cleanupBatchInstrumentation, registerBatchTools } from "./tools/batch-execute.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { executor, jobManager, runtimes } from "./app-runtime.js";
import { closeStore } from "./project-context.js";
export { withProjectDirOverride } from "./project-context.js";
export { isDirectExecution } from "./cli.js";
export { buildFetchCode, classifyIp } from "./fetch.js";
export { buildBatchNodeOptionsPrefix, getBatchConcurrencyLimit, resolveConfiguredConcurrency, runBatchCommands } from "./batch.js";
export { positionsFromHighlight, extractSnippet, formatBatchQueryResults } from "./search-format.js";
export type { BatchQueryScope } from "./search-format.js";

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


const toolRegistry = createToolRegistry((projectDir) => jobManager.isActive(projectDir));
export const REGISTERED_CTX_TOOLS: RegisteredCtxTool[] = toolRegistry.tools;
const registerCtxTool = toolRegistry.register;
registerExecutionTools(registerCtxTool);
registerIndexingTools(registerCtxTool);
registerFetchTools(registerCtxTool);
registerBatchTools(registerCtxTool);
registerDiagnosticTools(registerCtxTool, VERSION);

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

export function createContextModeHttpHandler(): McpHttpHandler {
  return createStrictMcpHttpHandler(() => createContextModeServer());
}

export function createContextModeNodeHttpServer(
  handler: McpHttpHandler = createContextModeHttpHandler(),
): NodeHttpServer {
  return createLoopbackMcpHttpServer(handler, {
    version: VERSION,
    readinessError: configuredExecutionAdmissionError,
  });
}

function cleanupRuntime(): void {
  jobManager.cleanup();
  executor.cleanupProcesses();
  closeStore();
  cleanupBatchInstrumentation();
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
      legacy: "reject",
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

if (isDirectExecution(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    cleanupRuntime();
    process.exit(1);
  });
}
