import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { available, jobManager, runtimes } from "../app-runtime.js";
import { getBatchConcurrencyLimit } from "../batch.js";
import { loadDatabase } from "../db-base.js";
import { PolyglotExecutor, configuredExecutionAdmissionError } from "../executor.js";
import { closeProjectStore, getContentDir, getProjectDir, projectHash } from "../project-context.js";

type RegisterTool = (
  name: string,
  config: Record<string, unknown>,
  handler: (toolArgs: any, ctx?: { signal?: AbortSignal }) => Promise<any> | any,
) => unknown;

export function registerDiagnosticTools(registerCtxTool: RegisterTool, version: string): void {
  // ── ctx-doctor: diagnostics (server-side) ─────────────────────────────────
  registerCtxTool(
    "ctx_doctor",
    {
      title: "Run Diagnostics",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Diagnose context-mode and return a plain-text [OK]/[WARN]/[FAIL] status report.",
      inputSchema: z.object({}),
    },
    async () => {
      const lines: string[] = ["context-mode doctor", ""];
      lines.push(`[OK] Runtimes: ${available.length} — ${available.join(", ")}`);
      const admission = configuredExecutionAdmissionError();
      lines.push(admission ? `[WARN] Admission: ${admission}` : "[OK] Admission: ready");
      const jobLimits = jobManager.concurrencyLimits();
      lines.push(`[OK] Limits: min available ${process.env.CONTEXT_MODE_MIN_AVAILABLE_MB ?? "disabled"} MiB; job min available ${process.env.CONTEXT_MODE_JOB_MIN_AVAILABLE_MB ?? "disabled"} MiB; foreground ${process.env.CONTEXT_MODE_MAX_FOREGROUND_MS ?? "unlimited"} ms; batch concurrency ${getBatchConcurrencyLimit()}; job concurrency ${jobLimits.global} global / ${jobLimits.perProject} project`);
      lines.push(`[OK] Async jobs: ${jobManager.activeCount()}/${jobLimits.global} active`);

      try {
        lines.push(`[OK] Storage content: ${getContentDir()}`);
      } catch (err) {
        lines.push(`[FAIL] Storage content: ${err instanceof Error ? err.message : err}`);
      }

      const testExecutor = new PolyglotExecutor({ runtimes });
      try {
        const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
        lines.push(result.exitCode === 0 && result.stdout.trim() === "ok"
          ? "[OK] Executor: PASS"
          : `[FAIL] Executor: exit ${result.exitCode}`);
      } catch (err) {
        lines.push(`[FAIL] Executor: ${err instanceof Error ? err.message : err}`);
      } finally {
        testExecutor.cleanupProcesses();
      }

      let testDb: any;
      try {
        const Database = loadDatabase();
        testDb = new Database(":memory:");
        testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
        testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
        const row = testDb.prepare("SELECT content FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content?: string } | undefined;
        lines.push(row?.content === "hello world" ? "[OK] FTS5 / SQLite: PASS" : "[FAIL] FTS5 / SQLite: unexpected result");
      } catch (err) {
        lines.push(`[FAIL] FTS5 / SQLite: ${err instanceof Error ? err.message : err}`);
      } finally {
        try { testDb?.close(); } catch {}
      }

      lines.push(`[OK] Version: v${version}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── ctx-purge: explicit project knowledge-base wipe ────────────────────────
  function deleteDbFamily(path: string): boolean {
    let deleted = false;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
        deleted = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return deleted;
  }

  registerCtxTool(
    "ctx_purge",
    {
      title: "Purge Knowledge Base",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: "Permanently delete indexed content for the current project. Requires confirm:true.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Project directory whose knowledge base should be purged."),
        confirm: z.boolean().describe("MUST be true. Destructive operation; false returns 'purge cancelled'."),
      }),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return { content: [{ type: "text" as const, text: "Purge cancelled. Pass confirm: true to proceed." }] };
      }

      closeProjectStore();

      try {
        const projectDir = getProjectDir();
        const currentDir = getContentDir();
        const paths = new Set([
          join(currentDir, `${projectHash(projectDir)}.db`),
        ]);
        let deleted = 0;
        for (const path of paths) if (deleteDbFamily(path)) deleted++;
        return {
          content: [{ type: "text" as const, text: deleted ? `Purged ${deleted} knowledge-base file set(s).` : "Nothing to purge." }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Purge failed: ${err instanceof Error ? err.message : err}` }],
          isError: true,
        };
      }
    },
  );
}
