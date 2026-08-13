# context-mode — 1MCP fork

A public fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) optimized for use as a single stdio upstream behind **1MCP**.

## Differences from upstream

- Exposes only: `ctx_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_batch_execute`, `ctx_doctor`, `ctx_purge`.
- Disables: `ctx_stats`, `ctx_upgrade`, `ctx_insight`.
- Uses concise MCP tool metadata to reduce `tools/list` context cost.
- Packages only the stdio server bundle; agent harness skills, hooks, plugins, statusline, and CLI helpers are not shipped.
- Keeps upstream source compatibility code in the repository so future `main` updates remain easy to review and merge.

## 1MCP configuration

Install this fork into 1MCP's package prefix, then point the upstream directly at the `context-mode` binary:

```json
{
  "type": "stdio",
  "disabled": false,
  "command": "/home/user/.local/share/1mcp/node_modules/.bin/context-mode",
  "cwd": "/home/user",
  "restartOnExit": true,
  "maxRestarts": 3,
  "restartDelay": 1000,
  "tags": ["context", "compression", "execution", "context-mode"]
}
```

No agent-harness platform variable is required.

## Development

```bash
npm install
npm run typecheck
npm run bundle
npx vitest run tests/core/server.test.ts
```

The committed `server.bundle.mjs` is the runtime artifact used by 1MCP.

## Upstream

Upstream project: <https://github.com/mksglu/context-mode>

This fork intentionally diverges in MCP surface and packaging only; core execution, indexing, search, fetch, purge, and diagnostics behavior should stay as close to upstream `main` as possible.
