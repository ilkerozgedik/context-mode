import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { Server as NodeHttpServer } from "node:http";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SHUTDOWN_GRACE_MS = 10_000;

export type ServerArgs = { transport: "stdio" | "http"; host: string; port: number };

export function parseServerArgs(argv: string[]): ServerArgs {
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

export async function closeHttpServer(server: NodeHttpServer, handler: McpHttpHandler): Promise<void> {
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

export function isDirectExecution(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl;
  }
}
