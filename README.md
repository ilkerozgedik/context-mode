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

The HTTP endpoint is `/mcp`; readiness is exposed at `/healthz`. HTTP mode is intentionally restricted to loopback and validates Host and Origin headers.

Modern clients are served natively using MCP revision `2026-07-28` with stateless per-request server instances. A stateless legacy compatibility path remains enabled for 2025-era clients during migration; modern requests never use `Mcp-Session-Id`.

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

Execution supports JavaScript, Python, and shell. Child processes run with the MCP server OS permissions, are resource-capped, and are terminated when the owning MCP request is cancelled. Indexed content is stored in a persistent SQLite/FTS5 database until explicit purge.

## Differences from upstream

- Removes `ctx_stats`, `ctx_upgrade`, `ctx_insight` and agent-harness integrations.
- Uses concise MCP metadata to reduce tool-list context cost.
- Supports standalone stdio and Streamable HTTP transports.
- Uses fresh MCP server instances for HTTP requests.
- Enforces the required 2026-07-28 standard request headers, including the SDK v2 missing-header compatibility guard.
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
