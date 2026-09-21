import { z } from "zod";
import { executor, jobManager } from "../app-runtime.js";
import { buildExecuteEcho } from "../batch.js";
import { configuredExecutionAdmissionError, configuredJobAdmissionError } from "../executor.js";
import { classifyNonZeroExit } from "../exit-classify.js";
import { resolveExecutionProjectDir } from "../project-context.js";
import {
  indexStdout,
  intentSearch,
  INTENT_SEARCH_THRESHOLD,
  LARGE_OUTPUT_THRESHOLD,
} from "../output-index.js";
import { checkFilePathDenyPolicy, checkProjectBoundary } from "./security.js";
import type { RegisterTool } from "./registry.js";

function formatProcessOutput(stdout: string | undefined, stderr: string | undefined, fallback = "(no output)"): string {
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return parts.join("\n\n") || fallback;
}

function formatCompletedExecution(
  result: { stdout?: string; stderr?: string; exitCode?: number | null },
  options: { language: string; source: string; echo: string; intent?: string; projectDir?: string },
) {
  const { language, source, echo, intent, projectDir } = options;
  const nonZero = result.exitCode !== 0;
  const classified = nonZero
    ? classifyNonZeroExit({
        language,
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      })
    : { isError: false, output: formatProcessOutput(result.stdout, result.stderr) };
  const { isError, output } = classified;
  const label = isError ? `${source}:error` : source;
  const prefix = nonZero ? echo : "";

  if (intent?.trim() && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
    return {
      content: [{ type: "text" as const, text: `${prefix}${intentSearch(output, intent, label, undefined, projectDir)}` }],
      ...(nonZero ? { isError } : {}),
    };
  }
  if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
    if (nonZero) {
      return {
        content: [{ type: "text" as const, text: `${prefix}${intentSearch(output, "errors failures exceptions", label, undefined, projectDir)}` }],
        isError,
      };
    }
    return indexStdout(output, source, projectDir);
  }
  return {
    content: [{ type: "text" as const, text: `${prefix}${output}` }],
    ...(nonZero ? { isError } : {}),
  };
}

export function registerExecutionTools(registerCtxTool: RegisterTool): void {
  // ─────────────────────────────────────────────────────────
  // Tool: execute
  // ─────────────────────────────────────────────────────────

  registerCtxTool(
    "ctx_execute",
    {
      // #852: surface code execution in the host approval prompt's title (the
      // only server-controlled field the MCP permission UI renders besides args).
      title: "Run code (uses MCP server OS permissions)",
      // Runs arbitrary code as a child process with the MCP server OS permissions.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: "Run code with MCP server OS permissions; print only useful output.",
      inputSchema: z.strictObject({
        language: z
  .enum(["javascript", "python", "shell"])
          .describe("Runtime."),
        code: z
          .string()
          .describe("Code to run."),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Timeout ms."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory."),
        intent: z
          .string()
          .optional()
          .describe("Large-output search terms."),
      }),
    },
    async ({ language, code, timeout, cwd, intent }, ctx) => {
      try {
        // Preserve top-level await ergonomics without monkey-patching user APIs.
        // Execution observability must not alter fetch/fs semantics.
        let executableCode = code;
        if (language === "javascript") {
          executableCode = `;(async () => {
${code}
})().catch(e=>{console.error(e);process.exitCode=1});`;
        }
        const result = await executor.execute({ language, code: executableCode, timeout, cwd, signal: ctx?.signal });

        // Echo the executed source code before stdout so users can audit
        // and host approval UIs can audit the exact payload (Issues #717 + #736).
        // Built from the user-supplied `code`, NOT the instrumented variant.
        const echo = buildExecuteEcho(language, code);

        if (result.timedOut) {
          const partialOutput = formatProcessOutput(result.stdout, result.stderr, "");
          return {
            content: [
              {
                type: "text" as const,
                text: partialOutput
                  ? `${echo}${partialOutput}\n\n_(timed out after ${result.timeoutMs ?? timeout ?? "unknown"}ms — partial output shown above)_`
                  : `${echo}Execution timed out after ${result.timeoutMs ?? timeout ?? "unknown"}ms`,
              },
            ],
            isError: true,
          };
        }

        return formatCompletedExecution(result, {
          language,
          source: `execute:${language}`,
          echo,
          intent,
          projectDir: resolveExecutionProjectDir(cwd),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Runtime error: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ─────────────────────────────────────────────────────────

  // Tool: async job execution for long-running builds
  registerCtxTool(
    "ctx_job_start",
    {
      title: "Start resource-limited async job (uses MCP server OS permissions)",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description: "Run a long shell job with MCP server OS permissions; returns a receipt.",
      inputSchema: z.object({
        command: z.string().min(1).describe("Shell command to run."),
        cwd: z.string().optional().describe("Working directory."),
        expected_artifacts: z.array(z.string().min(1)).max(16).optional().describe("Artifact paths under cwd."),
      }),
    },
    async ({ command, cwd, expected_artifacts }) => {
      try {
        const admissionError = configuredExecutionAdmissionError() ?? configuredJobAdmissionError();
        if (admissionError) throw new Error(admissionError);
        const projectDir = resolveExecutionProjectDir(cwd);
        const started = jobManager.start({ command, cwd: projectDir, expectedArtifacts: expected_artifacts });
        return { content: [{ type: "text", text: JSON.stringify(jobManager.status(started.jobId)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  );

  registerCtxTool(
    "ctx_job_status",
    {
      title: "Read async job status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Read async job receipt.",
      inputSchema: z.object({ job_id: z.string().min(1) }),
    },
    async ({ job_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(jobManager.status(job_id)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  );

  registerCtxTool(
    "ctx_job_cancel",
    {
      title: "Cancel async job",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: "Cancel async job; return final receipt.",
      inputSchema: z.object({ job_id: z.string().min(1) }),
    },
    async ({ job_id }) => {
      try {
        const receipt = await jobManager.cancel(job_id);
        return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  );

  // Tool: execute_file
  // ─────────────────────────────────────────────────────────

  registerCtxTool(
    "ctx_execute_file",
    {
      // #852: the host's MCP approval prompt renders only the tool name/title +
      // raw args — the title is the one server-controlled signal, so make it
      // unambiguously announce code execution + file read for the reviewer.
      title: "Run code over a file (uses MCP server OS permissions)",
      // Runs arbitrary code over the selected file with the MCP server OS permissions.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: "Run code over a file with MCP server OS permissions; FILE_CONTENT is available.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Project scope."),
        path: z
          .string()
          .describe("Project file path."),
        language: z
  .enum(["javascript", "python", "shell"])
          .describe("Runtime."),
        code: z
          .string()
          .describe("Code using FILE_CONTENT."),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Timeout ms."),
        intent: z
          .string()
          .optional()
          .describe("Large-output search terms."),
      }),
    },
    async ({ path, language, code, timeout, intent }, ctx) => {
      // Constrain the selected input path before applying optional Read deny rules.
      // The supplied code itself still runs with the MCP server OS permissions.
      const boundaryDenied = checkProjectBoundary(path, "ctx_execute_file");
      if (boundaryDenied) return boundaryDenied;

      // Security: check file path against Read deny patterns
      const pathDenied = checkFilePathDenyPolicy(path);
      if (pathDenied) return pathDenied;

      try {
        const result = await executor.executeFile({
          path,
          language,
          code,
          timeout,
          signal: ctx?.signal,
        });

        // Echo path + executed source code before stdout for audit/debug
        // (Issues #717 + #736).
        const echo = buildExecuteEcho(language, code, path);

        if (result.timedOut) {
          const partialOutput = formatProcessOutput(result.stdout, result.stderr, "");
          return {
            content: [
              {
                type: "text" as const,
                text: `${echo}${partialOutput ? `${partialOutput}\n\n` : ""}Timed out processing ${path} after ${result.timeoutMs ?? timeout ?? "unknown"}ms`,
              },
            ],
            isError: true,
          };
        }

        return formatCompletedExecution(result, {
          language,
          source: `file:${path}`,
          echo,
          intent,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Runtime error: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
