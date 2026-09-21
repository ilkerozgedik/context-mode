import { z } from "zod";
import { executor } from "../app-runtime.js";
import {
  getBatchConcurrencyLimit,
  runBatchCommands,
} from "../batch.js";
import { capIndexableOutput, INDEX_OUTPUT_CAP_BYTES } from "../output-index.js";
import { getStore, resolveExecutionProjectDir } from "../project-context.js";
import { formatBatchQueryResults } from "../search-format.js";
import type { RegisterTool } from "./registry.js";

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
      description: "Run shell commands with MCP server OS permissions; index output and return query matches.",
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
          .max(8)
          .describe("1-8 commands."),
        queries: z.array(z.string())
          .min(1)
          .describe("Queries over output."),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Timeout ms."),
        concurrency: z
          .coerce.number()
          .int()
          .min(1)
          .max(getBatchConcurrencyLimit())
          .optional()
          .default(1)
          .describe(`Parallelism 1-${getBatchConcurrencyLimit()}.`),
        cwd: z
          .string()
          .optional()
          .describe("Working directory."),
        query_scope: z
          .enum(["batch", "global"])
          .optional()
          .default("batch")
          .describe("batch=this output; global=all indexed."),
      }),
    },
    async ({ commands, queries, timeout, concurrency, cwd, query_scope }, ctx) => {
      try {
        // Full stdout is preserved per-command and indexed into FTS5 (Issue #61, #197).
        // Concurrency>1 switches to a worker pool with per-command timeouts.
        const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(
          commands,
          {
            timeout,
            concurrency,
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

        // Run all search queries — default scope is batch-local.
        // When the caller passes query_scope: "global", searches reach the entire
        // persistent index in the same round trip. Cross-source search remains
        // available via explicit ctx_search() as well.
        const queryResults = formatBatchQueryResults(store, queries, source, undefined, query_scope);

        const output = [
          `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
            `Indexed ${indexed.totalChunks} sections${indexable.truncated ? ` (output capped at ${(INDEX_OUTPUT_CAP_BYTES / 1024 / 1024).toFixed(0)}MB before indexing)` : ""}. Searched ${queries.length} queries.`,
          "",
          ...queryResults,
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
