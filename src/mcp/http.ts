import { createMcpHandler, type McpHttpHandler, type McpServer } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;

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
  if (request.headers.get("mcp-protocol-version") !== MODERN_PROTOCOL_VERSION) {
    return headerMismatchResponse(id, `MCP-Protocol-Version must be ${MODERN_PROTOCOL_VERSION}`);
  }
  if (!method || request.headers.get("mcp-method") !== method) {
    return headerMismatchResponse(id, "Mcp-Method must match the JSON-RPC method");
  }
  const name = typeof params?.name === "string" ? params.name : undefined;
  if (name !== undefined && request.headers.get("mcp-name") !== name) {
    return headerMismatchResponse(id, "Mcp-Name must match params.name");
  }
  return null;
}

export function createStrictMcpHttpHandler(factory: () => McpServer): McpHttpHandler {
  const inner = createMcpHandler(factory, {
    legacy: "reject",
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

function writeJsonRpcHttpError(res: ServerResponse, status: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

export function createLoopbackMcpHttpServer(
  handler: McpHttpHandler,
  options: { version: string; readinessError: () => string | null | undefined },
): NodeHttpServer {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => process.stderr.write(`[context-mode] Node HTTP adapter error: ${error.message}\n`),
  });

  return createServer(async (req, res) => {
    if (!validateHost(req, res)) return;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/readyz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const reason = options.readinessError();
      const body = JSON.stringify(reason
        ? { status: "unavailable", reason }
        : { status: "ready", version: options.version });
      res.writeHead(reason ? 503 : 200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const body = JSON.stringify({ status: "ok", version: options.version });
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
          writeJsonRpcHttpError(res, 415, -32600, "Content-Type must be application/json");
          return;
        }
        const body = await readJsonBody(req);
        await nodeHandler(req, res, body);
        return;
      }
      await nodeHandler(req, res);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJsonRpcHttpError(res, 413, -32600, error.message);
        return;
      }
      if (error instanceof SyntaxError) {
        writeJsonRpcHttpError(res, 400, -32700, "Parse error");
        return;
      }
      process.stderr.write(`[context-mode] HTTP request failure: ${error instanceof Error ? error.message : String(error)}\n`);
      writeJsonRpcHttpError(res, 500, -32603, "Internal server error");
    }
  });
}
