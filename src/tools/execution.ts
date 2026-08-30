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

type RegisterTool = (
  name: string,
  config: Record<string, unknown>,
  handler: (toolArgs: any, ctx?: { signal?: AbortSignal }) => Promise<any> | any,
) => unknown;

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
      description: "Run code as a child process with the MCP server OS permissions. Print only findings that should enter context; use ctx_batch_execute for related commands.",
      inputSchema: z.strictObject({
        language: z
  .enum(["javascript", "python", "shell"])
          .describe("Runtime language"),
        code: z
          .string()
          .describe("Code to execute; print only the result that should enter context."),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms; omit to use the MCP host timeout."),
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory for shell commands."),
        intent: z
          .string()
          .optional()
          .describe("Terms to match when large output is indexed."),
      }),
    },
    async ({ language, code, timeout, cwd, intent }, ctx) => {
      try {
        // For JavaScript: wrap in async IIFE with fetch + http/https interceptors to track network bytes
        let instrumentedCode = code;
        if (language === "javascript") {
          // Wrap user code in a closure that shadows CJS require with http/https interceptor.
          // globalThis.require does NOT work because CJS require is module-scoped, not global.
          // The closure approach (function(__cm_req){ var require=...; })(require) correctly
          // shadows the CJS require for all code inside, including __cm_main().
          instrumentedCode = `
  // FS read instrumentation — count bytes read via fs.readFileSync/readFile
  let __cm_fs=0;
  process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
  (function(){
    try{
      var f=typeof require!=='undefined'?require('fs'):null;
      if(!f)return;
      var ors=f.readFileSync;
      f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};
      var orf=f.readFile;
      if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d){if(Buffer.isBuffer(d))__cm_fs+=d.length;else if(typeof d==='string')__cm_fs+=Buffer.byteLength(d);}cb(e,d);}]));};
    }catch{}
  })();
  let __cm_net=0;
  // Report network bytes on process exit — works with both promise and callback patterns.
  // process.on('exit') fires after all I/O completes, unlike .finally() which fires
  // when __cm_main() resolves (immediately for callback-based http.get without await).
  process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
  ;(function(__cm_req){
  // Intercept globalThis.fetch
  const __cm_f=globalThis.fetch;
  globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
  try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
  return r};
  // Shadow CJS require with http/https network tracking.
  const __cm_hc=new Map();
  const __cm_hm=new Set(['http','https','node:http','node:https']);
  function __cm_wf(m,origFn){return function(...a){
    const li=a.length-1;
    if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
      res.on('data',function(c){__cm_net+=c.length});oc(res);};}
    const req=origFn.apply(m,a);
    const oOn=req.on.bind(req);
    req.on=function(ev,cb,...r){
      if(ev==='response'){return oOn(ev,function(res){
        res.on('data',function(c){__cm_net+=c.length});cb(res);
      },...r);}
      return oOn(ev,cb,...r);
    };
    return req;
  }}
  var require=__cm_req?function(id){
    const m=__cm_req(id);
    if(!__cm_hm.has(id))return m;
    const k=id.replace('node:','');
    if(__cm_hc.has(k))return __cm_hc.get(k);
    const w=Object.create(m);
    if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
    if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
    __cm_hc.set(k,w);return w;
  }:__cm_req;
  if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
  if(__cm_req.cache)require.cache=__cm_req.cache;}
  async function __cm_main(){
  ${code}
  }
  __cm_main().catch(e=>{console.error(e);process.exitCode=1});
  })(typeof require!=='undefined'?require:null);`;
        }
        const result = await executor.execute({ language, code: instrumentedCode, timeout, cwd, signal: ctx?.signal });

        // Echo the executed source code before stdout so users can audit
        // and host approval UIs can audit the exact payload (Issues #717 + #736).
        // Built from the user-supplied `code`, NOT the instrumented variant.
        const echo = buildExecuteEcho(language, code);

        // Parse sandbox network metrics from stderr
        const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
        if (netMatch) {
          // Clean the metric line from stderr
          result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
        }

        // Parse sandbox FS read metrics from stderr
        const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
        if (fsMatch) {
          result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
        }

        if (result.timedOut) {
          const partialOutput = result.stdout?.trim();
          if (partialOutput) {
            // Timeout with partial output — return as success with note
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${echo}${partialOutput}\n\n_(timed out after ${result.timeoutMs ?? timeout ?? "unknown"}ms — partial output shown above)_`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `${echo}Execution timed out after ${result.timeoutMs ?? timeout ?? "unknown"}ms\n\nstderr:\n${result.stderr}`,
              },
            ],
            isError: true,
          };
        }

        if (result.exitCode !== 0) {
          const { isError, output } = classifyNonZeroExit({
            language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          });
          if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
            return {
              content: [
                { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`, undefined, resolveExecutionProjectDir(cwd))}` },
              ],
              isError,
            };
          }
          // Auto-index large error output into FTS5 — no data loss
          if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
            return {
              content: [
                { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`)}` },
              ],
              isError,
            };
          }
          return {
            content: [
              { type: "text" as const, text: `${echo}${output}` },
            ],
            isError,
          };
        }

        const stdout = result.stdout || "(no output)";

        // Intent-driven search: if intent provided and output is large enough
        if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `execute:${language}`, undefined, resolveExecutionProjectDir(cwd))}` },
            ],
          };
        }

        // Auto-index large stdout into FTS5 — return pointer, not raw content
        if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
          const indexed = indexStdout(stdout, `execute:${language}`, resolveExecutionProjectDir(cwd));
          // Prepend echo to the first text content so provenance still surfaces
          const echoed = {
            ...indexed,
            content: indexed.content.map((c, i) =>
              i === 0 && c.type === "text"
                ? { ...c, text: `${echo}${(c as { text: string }).text}` }
                : c,
            ),
          };
          return echoed;
        }

        return {
          content: [
            { type: "text" as const, text: `${echo}${stdout}` },
          ],
        };
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
      description: "Start one long-running shell job under a resource-limited systemd user service. Returns immediately with a job receipt; runs with the MCP server OS permissions.",
      inputSchema: z.object({
        command: z.string().min(1).describe("Shell command to run."),
        cwd: z.string().optional().describe("Working directory; defaults to the configured project directory."),
        expected_artifacts: z.array(z.string().min(1)).max(16).optional().describe("Optional artifact paths inside cwd to report when present."),
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
      description: "Read the current receipt for a previously started async job.",
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
      description: "Cancel the active async job and return its final receipt.",
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
      description: "Analyze a selected project file without loading it into context. Code receives FILE_CONTENT and runs with the MCP server OS permissions; only printed output is returned.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Project directory used to scope paths and the persistent index."),
        path: z
          .string()
          .describe("Absolute file path or relative to project root"),
        language: z
  .enum(["javascript", "python", "shell"])
          .describe("Runtime language"),
        code: z
          .string()
          .describe("Code that reads FILE_CONTENT and prints the result to return."),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms; omit to use the MCP host timeout."),
        intent: z
          .string()
          .optional()
          .describe("Terms to match when large output is indexed."),
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
          timeout: timeout,
        });

        // Echo path + executed source code before stdout for audit/debug
        // (Issues #717 + #736).
        const echo = buildExecuteEcho(language, code, path);

        if (result.timedOut) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${echo}Timed out processing ${path} after ${result.timeoutMs ?? timeout ?? "unknown"}ms`,
              },
            ],
            isError: true,
          };
        }

        if (result.exitCode !== 0) {
          const { isError, output } = classifyNonZeroExit({
            language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          });
          if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
            return {
              content: [
                { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`)}` },
              ],
              isError,
            };
          }
          // Auto-index large error output into FTS5 — no data loss
          if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
            return {
              content: [
                { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`)}` },
              ],
              isError,
            };
          }
          return {
            content: [
              { type: "text" as const, text: `${echo}${output}` },
            ],
            isError,
          };
        }

        const stdout = result.stdout || "(no output)";

        if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `file:${path}`)}` },
            ],
          };
        }

        // Auto-index large stdout into FTS5 — return pointer, not raw content
        if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
          const indexed = indexStdout(stdout, `file:${path}`);
          const echoed = {
            ...indexed,
            content: indexed.content.map((c, i) =>
              i === 0 && c.type === "text"
                ? { ...c, text: `${echo}${(c as { text: string }).text}` }
                : c,
            ),
          };
          return echoed;
        }

        return {
          content: [
            { type: "text" as const, text: `${echo}${stdout}` },
          ],
        };
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
