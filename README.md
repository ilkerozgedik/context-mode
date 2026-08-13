# context-mode — 1MCP fork

A public fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) optimized for use as a single stdio upstream behind **1MCP**.

## Differences from upstream

- Exposes only: `ctx_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_batch_execute`, `ctx_doctor`, `ctx_purge`.
- Removes: `ctx_stats`, `ctx_upgrade`, `ctx_insight`.
- Uses concise MCP tool metadata to reduce `tools/list` context cost.
- Keeps only the stdio server and core execution/index/search/fetch/purge/diagnostics source.
- `ctx_execute` and `ctx_execute_file` support only JavaScript, Python, and shell.
- Session-memory/timeline plumbing is removed; `ctx_search` queries only the persistent FTS5 content store.
- Indexed content remains persistent until explicit `ctx_purge`; there is no age-based automatic deletion.
- Execution tools run child processes with the MCP server OS permissions; host approval and the OS account are the execution boundary.
- Agent adapters, hooks, plugins, statusline, CLI helpers, and Insight assets are removed from the fork.

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
npm test
```

The committed `server.bundle.mjs` is the runtime artifact used by 1MCP.

## Upstream

Upstream project: <https://github.com/mksglu/context-mode>

This fork intentionally removes upstream agent-harness code; the remaining execution, indexing, search, fetch, purge, and diagnostics core stays close to upstream where relevant to 1MCP.
