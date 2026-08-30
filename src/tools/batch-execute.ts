import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { executor, runtimes } from "../app-runtime.js";
import {
  buildBatchNodeOptionsPrefix,
  getBatchConcurrencyLimit,
  runBatchCommands,
  truncateCommandForEcho,
} from "../batch.js";
import { capIndexableOutput, INDEX_OUTPUT_CAP_BYTES } from "../output-index.js";
import { getStore, resolveExecutionProjectDir } from "../project-context.js";
import { formatBatchQueryResults } from "../search-format.js";

type RegisterTool = (
  name: string,
  config: Record<string, unknown>,
  handler: (toolArgs: any, ctx?: { signal?: AbortSignal }) => Promise<any> | any,
) => unknown;

// ─────────────────────────────────────────────────────────
// FS read tracking preload for ctx_batch_execute
// ─────────────────────────────────────────────────────────
// NODE_OPTIONS is denied by the executor's #buildSafeEnv (security).
// Instead, we inject it as an inline shell env prefix in each batch command.
// This temp file is loaded via --require when batch commands spawn Node processes.
const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);
writeFileSync(
  CM_FS_PRELOAD,
  `(function(){var __cm_fs=0;process.on('exit',function(){if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};}catch(e){}})();\n`,
);
// Best-effort cleanup in case the process exits before main() shutdown.
process.on("exit", () => { try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ } });

export function cleanupBatchInstrumentation(): void {
  try { unlinkSync(CM_FS_PRELOAD); } catch {}
}

export function registerBatchTools(registerCtxTool: RegisterTool): void {
  // ─────────────────────────────────────────────────────────
  // Tool: batch_execute
  // ─────────────────────────────────────────────────────────

  registerCtxTool(
    "ctx_batch_execute",
    {
      title: "Batch Execute & Search (uses MCP server OS permissions)",
      // Runs arbitrary shell commands with the MCP server OS permissions and indexes output.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: "Run related shell commands with the MCP server OS permissions, index their output, and return query matches. Use for related or large-output commands.",
      inputSchema: z.object({
        commands: z.array(
            z.object({
              label: z
                .string()
                .describe(
                  "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
                ),
              command: z
                .string()
                .describe("Shell command to execute"),
            }),
          )
          .min(1)
          .describe("Commands to run; labels become indexed section headers."),
        queries: z.array(z.string())
          .min(1)
          .describe("Queries to extract from indexed batch output."),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms per batch or command."),
        concurrency: z
          .coerce.number()
          .int()
          .min(1)
          .max(getBatchConcurrencyLimit())
          .optional()
          .default(1)
          .describe(`Parallel commands, 1-${getBatchConcurrencyLimit()}; use 1 for stateful or CPU-bound work.`),
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory for all shell commands in this batch."),
        query_scope: z
          .enum(["batch", "global"])
          .optional()
          .default("batch")
          .describe("'batch' searches this call; 'global' searches the full index."),
      }),
    },
    async ({ commands, queries, timeout, concurrency, cwd, query_scope }, ctx) => {
      try {
        // Inject NODE_OPTIONS for FS read tracking in spawned Node processes.
        // The executor denies NODE_OPTIONS in its env (security), so we set it
        // as an inline shell prefix. This only affects child `node` invocations.
        const nodeOptsPrefix = buildBatchNodeOptionsPrefix(runtimes.shell, CM_FS_PRELOAD);

        // Full stdout is preserved per-command and indexed into FTS5 (Issue #61, #197).
        // Concurrency>1 switches to a worker pool with per-command timeouts.
        const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(
          commands,
          {
            timeout: timeout,
            concurrency,
            nodeOptsPrefix,
            cwd,
            signal: ctx?.signal,
          },
          executor,
        );

        const stdout = perCommandOutputs.join("\n");
        const totalBytes = Buffer.byteLength(stdout);
        const totalLines = stdout.split("\n").length;
        const indexable = capIndexableOutput(stdout);
        const projectDir = resolveExecutionProjectDir(cwd);

        if (timedOut && perCommandOutputs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Batch timed out after ${timeout ?? "unknown"}ms. No output captured.`,
              },
            ],
            isError: true,
          };
        }

        // Track indexed bytes (raw data that stays in the persistent store)

        // Index into knowledge base — markdown heading chunking splits by # labels
        const store = getStore(projectDir);
        const source = `batch:${commands
          .map((c: { label: string; command: string }) => c.label)
          .join(",")
          .slice(0, 80)}`;
        const indexed = store.index({ content: indexable.text, source });

        // Commands inventory — list what the agent actually ran so the
        // response itself documents intent, not just per-section echoes.
        // Placed before "## Indexed Sections" so it scans top-down with
        // the human asking "what just happened" (Issues #717 + #736).
        const commandsInventory: string[] = ["## Commands", ""];
        for (const c of commands) {
          commandsInventory.push(`- ${c.label}: \`${truncateCommandForEcho(c.command)}\``);
        }

        // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
        const allSections = store.getChunksBySource(indexed.sourceId);
        const inventory: string[] = ["## Indexed Sections", ""];
        const sectionTitles: string[] = [];
        for (const s of allSections) {
          const bytes = Buffer.byteLength(s.content);
          inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
          sectionTitles.push(s.title);
        }

        // Run all search queries — default scope is batch-local.
        // When the caller passes query_scope: "global", searches reach the entire
        // persistent index in the same round trip. Cross-source search remains
        // available via explicit ctx_search() as well.
        const queryResults = formatBatchQueryResults(store, queries, source, undefined, query_scope);

        // Get searchable terms for edge cases where follow-up is needed
        const distinctiveTerms = store.getDistinctiveTerms
          ? store.getDistinctiveTerms(indexed.sourceId)
          : [];

        const output = [
          `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
            `Indexed ${indexed.totalChunks} sections${indexable.truncated ? ` (output capped at ${(INDEX_OUTPUT_CAP_BYTES / 1024 / 1024).toFixed(0)}MB before indexing)` : ""}. Searched ${queries.length} queries.`,
          "",
          ...commandsInventory,
          "",
          ...inventory,
          "",
          ...queryResults,
          distinctiveTerms.length > 0
            ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
            : "",
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Batch execution error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
