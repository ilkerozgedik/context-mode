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
- `ctx_job_start` / `ctx_job_status` / `ctx_job_cancel`
- `ctx_execute_file`
- `ctx_index`
- `ctx_search`
- `ctx_fetch_and_index`
- `ctx_batch_execute`
- `ctx_doctor`
- `ctx_purge`

Execution supports JavaScript, Python, and shell. `ctx_execute` is foreground-only; use `ctx_job_start` for long-running shell work. Project-scoped tools serialize within the same canonical project (nearest Git root when present) while different projects can run concurrently. `ctx_job_*` defaults to two concurrent async jobs globally and one per project (`CONTEXT_MODE_MAX_ASYNC_JOBS=2`, `CONTEXT_MODE_MAX_ASYNC_JOBS_PER_PROJECT=1`), run by the user systemd manager with bounded CPU/tasks/runtime, `NoNewPrivileges`, a private `0077` umask, deterministic non-login shell execution, restart-time stale-job reconciliation, live bounded log tails, cancellable polling receipts, systemd-aware termination reasons (`oom-kill`, `runtime-timeout`, `signal:N`, `exit:N`), and optional artifact metadata. Foreground execution is refused only for a project that already has an active async job; other projects remain available. Deployments can additionally set a heavy-job memory admission threshold with `CONTEXT_MODE_JOB_MIN_AVAILABLE_MB`. Child processes run with the MCP server OS permissions. Relative `cwd` values are resolved once for execution while locking remains keyed by the canonical project scope. `ctx_batch_execute` accepts at most eight commands and retains at most 4 MiB of output per command before the existing 4 MiB indexing cap. `ctx_fetch_and_index` enforces its 50 MiB response limit while streaming, including chunked responses without `Content-Length`. Each project uses its own persistent SQLite/FTS5 store until explicit purge; live SQLite connections use an LRU cache capped at 8 projects by default (`CONTEXT_MODE_MAX_OPEN_STORES`).

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
