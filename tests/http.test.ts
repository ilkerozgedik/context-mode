import { describe, expect, test } from "vitest";
import {
  createContextModeHttpHandler,
  createContextModeServer,
} from "../src/server.js";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "context-mode-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernRequest(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3050/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: MODERN_META },
    }),
  });
}

describe("standalone MCP HTTP server", () => {
  test("creates a fresh MCP server for every request", () => {
    expect(createContextModeServer()).not.toBe(createContextModeServer());
  });

  test("serves 2026-07-28 server/discover without a session id", async () => {
    const handler = createContextModeHttpHandler();
    const response = await handler.fetch(modernRequest("server/discover"));
    const body = await response.json() as { result?: { supportedVersions?: string[]; resultType?: string; ttlMs?: number; cacheScope?: string; _meta?: Record<string, unknown> } };

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(body.result?.supportedVersions).toContain("2026-07-28");
    expect(body.result?.resultType).toBe("complete");
    expect(body.result?.ttlMs).toBeTypeOf("number");
    expect(body.result?.cacheScope).toBe("private");
    expect(body.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toBeDefined();
  });

  test("rejects modern requests missing mandatory protocol headers", async () => {
    const handler = createContextModeHttpHandler();
    const request = modernRequest("server/discover");
    request.headers.delete("mcp-protocol-version");
    const response = await handler.fetch(request);
    const body = await response.json() as { error?: { code?: number } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe(-32020);
  });
  test("rejects a modern request when Mcp-Method is missing", async () => {
    const handler = createContextModeHttpHandler();
    const request = modernRequest("server/discover");
    request.headers.delete("mcp-method");
    const response = await handler.fetch(request);
    const body = await response.json() as { error?: { code?: number } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe(-32020);
  });

  test("serves a modern tools/call with Mcp-Name", async () => {
    const handler = createContextModeHttpHandler();
    const response = await handler.fetch(modernRequest(
      "tools/call",
      { name: "ctx_doctor", arguments: {} },
      { "mcp-name": "ctx_doctor" },
    ));
    const body = await response.json() as { result?: { resultType?: string; content?: Array<{ text?: string }> } };

    expect(response.status).toBe(200);
    expect(body.result?.resultType).toBe("complete");
    expect(body.result?.content?.[0]?.text).toContain("context-mode doctor");
  });

  test("serves deterministic modern tools/list metadata", async () => {
    const handler = createContextModeHttpHandler();
    const response = await handler.fetch(modernRequest("tools/list"));
    const body = await response.json() as { result?: { resultType?: string; ttlMs?: number; cacheScope?: string; tools?: Array<{ name: string }> } };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];

    expect(response.status).toBe(200);
    expect(body.result?.resultType).toBe("complete");
    expect(body.result?.ttlMs).toBeTypeOf("number");
    expect(body.result?.cacheScope).toBe("private");
    expect(names).toEqual([
      "ctx_execute",
      "ctx_execute_file",
      "ctx_index",
      "ctx_search",
      "ctx_fetch_and_index",
      "ctx_batch_execute",
      "ctx_doctor",
      "ctx_purge",
    ]);
  });

});
