# context-mode

A standalone fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) focused on compact context retrieval and resilient MCP execution.

## Runtime

The server supports both transports from the same bundled artifact:

```bash
# Local MCP clients
context-mode --transport stdio

# Standalone Streamable HTTP server
context-mode --transport http --host 127.0.0.1 --port 3050
```

The HTTP endpoint is `/mcp`; liveness is exposed at `/healthz` and readiness at `/readyz`. HTTP mode is intentionally restricted to loopback and validates Host and Origin headers.

Context Mode serves MCP revision `2026-07-28` only, using stateless per-request server instances. 2025-era `initialize` traffic and MCP sessions are rejected.

## Tool surface

The fork exposes only:

- `ctx_execute`
- `ctx_execute_file`
- `ctx_index`
- `ctx_search`
- `ctx_fetch_and_index`
- `ctx_batch_execute`
- `ctx_doctor`
- `ctx_purge`

Execution supports JavaScript, Python, and shell. Calls to the same project may run concurrently; execution preserves request-scoped cwd and cancellation. `ctx_execute` accepts an optional caller-defined timeout; no deployment-wide foreground cap is applied. Child processes inherit MCP server OS permissions and are terminated when the request is cancelled or the server shuts down. Per-project SQLite/FTS5 indexing and generation fencing protect knowledge storage; output limits, fetch limits, SSRF defenses, and the optional memory admission check remain intact. `ctx_batch_execute` accepts at most eight commands with bounded output capture.

## Differences from upstream

- Removes `ctx_stats`, `ctx_upgrade`, `ctx_insight` and agent-harness integrations.
- Uses concise MCP metadata to reduce tool-list context cost.
- Supports standalone stdio and Streamable HTTP transports.
- Uses fresh MCP server instances for HTTP requests.
- Enforces the required 2026-07-28 standard request headers, including an SDK v2 missing-header guard.
- Keeps output, fetch-size, SSRF, path-boundary, concurrency, and SQLite safety guards.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

`server.bundle.mjs` is the committed runtime artifact.

## Upstream

Upstream project: <https://github.com/mksglu/context-mode>
