import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { readPositiveEnv } from "../env.js";
import { getProjectDir, getStore, resolveProjectPath } from "../project-context.js";
import { extractSnippet } from "../search-format.js";
import { checkFilePathDenyPolicy, checkProjectBoundary, createPerFileReadDeny } from "./security.js";
import type { RegisterTool } from "./registry.js";

export function registerIndexingTools(registerCtxTool: RegisterTool): void {
  // ─────────────────────────────────────────────────────────
  // Tool: index
  // ─────────────────────────────────────────────────────────

  registerCtxTool(
    "ctx_index",
    {
      title: "Index Content",
      // #846: writes content into the local FTS5 store (additive, not destructive;
      // re-indexing the same content adds rows, so not idempotent). No network.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      description: "Index content for ctx_search.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Project scope."),
        content: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Inline content; exclusive with path.",
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe("File or directory; exclusive with content."),
        source: z
          .string()
          .optional()
          .describe(
            "Source label.",
          ),
        include: z.array(z.string()).optional().describe(
          "Directory include globs.",
        ),
        exclude: z.array(z.string()).optional().describe(
          "Directory exclude globs.",
        ),
        maxDepth: z.number().int().min(0).optional().describe(
          "Directory depth (default 5).",
        ),
        maxFiles: z.number().int().min(1).optional().describe(
          "Directory file cap (default 200).",
        ),
        extensions: z.array(z.string()).optional().describe(
          "Directory extensions.",
        ),
        respectGitignore: z.boolean().optional().describe(
          "Honor .gitignore (default true).",
        ),
        followSymlinks: z.boolean().optional().describe(
          "Directory-only: follow directory symlinks (default: false — cycle hazard + escape risk).",
        ),
      }),
    },
    async ({ content, path, source, include, exclude, maxDepth, maxFiles, extensions, respectGitignore, followSymlinks }) => {
      if ((content === undefined) === (path === undefined)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Provide exactly one of content or path.",
            },
          ],
          isError: true,
        };
      }

      if (path) {
        const boundaryDenied = checkProjectBoundary(path, "ctx_index");
        if (boundaryDenied) return boundaryDenied;
      }

      // Apply Read deny-policy to prevent indexing sensitive files into the
      // FTS5 store, which would otherwise be queryable via ctx_search and
      // exfiltrate content into the model's context (issue #442). Mirrors the
      // check ctx_execute_file already performs.
      if (path) {
        const pathDenied = checkFilePathDenyPolicy(path);
        if (pathDenied) return pathDenied;
      }

      try {
        const resolvedPath = path ? resolveProjectPath(path) : undefined;

        // Directory dispatch (#687, reported by @matiasduartee). When the
        // resolved path is a directory, walk it bounded and re-enter `index()`
        // per-file so the security gate at store.ts:845 (TOCTOU defense from
        // #442 round-3) keeps running for every file.
        //
        // Root-level symlink defense: the deny-glob check above ran on the
        // user-supplied `path`. If `path` is a symlink whose target lands in
        // a sensitive directory (e.g. `/tmp/link -> /etc`), statSync would
        // happily report directory and walkDirectoryDetailed would
        // realpathSync internally, walking /etc with the user's deny globs
        // bound to /tmp/link instead of the real target. Detect the symlink
        // with lstatSync, follow it once, and re-apply the deny check
        // against the realpath so the user's deny globs see the actual
        // walk root.
        if (resolvedPath && existsSync(resolvedPath)) {
          const lst = lstatSync(resolvedPath);
          if (lst.isSymbolicLink()) {
            let realTarget: string;
            try {
              realTarget = realpathSync(resolvedPath);
            } catch {
              return {
                content: [{ type: "text" as const, text: "Error: symlink target could not be resolved." }],
              };
            }
            if (realTarget !== resolvedPath) {
              const realDenied = checkFilePathDenyPolicy(realTarget);
              if (realDenied) return realDenied;
            }
          }
        }
        if (resolvedPath && existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
          const store = getStore();
          const projectDir = getProjectDir();
          const perFileDeny = createPerFileReadDeny(projectDir);
          const dirResult = store.indexDirectory({
            path: resolvedPath,
            source: source ?? resolvedPath,
            perFileDeny,
            include,
            exclude,
            maxDepth,
            maxFiles,
            extensions,
            respectGitignore,
            followSymlinks,
          });
          const capNote = dirResult.capped
            ? ` (cap reached — only first ${dirResult.filesIndexed} of ${dirResult.totalSeen}+ files; raise maxFiles to index more)`
            : "";
          const denyNote = dirResult.denied > 0
            ? ` (${dirResult.denied} file${dirResult.denied === 1 ? "" : "s"} blocked by Read deny policy)`
            : "";
          const failNote = dirResult.failed > 0
            ? ` (${dirResult.failed} file${dirResult.failed === 1 ? "" : "s"} failed to read)`
            : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `Indexed ${dirResult.filesIndexed} file${dirResult.filesIndexed === 1 ? "" : "s"} (${dirResult.totalChunks} sections) from directory: ${dirResult.label}${capNote}${denyNote}${failNote}\nUse ctx_search(queries: ["..."]) to query this content.`,
              },
            ],
          };
        }

        const store = getStore();
        const result = store.index({ content, path: resolvedPath, source: source ?? resolvedPath });

        return {
          content: [
            {
              type: "text" as const,
              text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Index error: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ─────────────────────────────────────────────────────────
  // Tool: search — progressive throttling
  // ─────────────────────────────────────────────────────────

  const SEARCH_WINDOW_MS = readPositiveEnv("CONTEXT_MODE_SEARCH_WINDOW_MS", 60_000);
  const SEARCH_MAX_RESULTS_AFTER = readPositiveEnv("CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER", 3);
  const SEARCH_BLOCK_AFTER = readPositiveEnv("CONTEXT_MODE_SEARCH_BLOCK_AFTER", 8);
  let searchWindowStart = 0;
  let searchCallCount = 0;

  function recordSearch(now: number): { count: number; windowStart: number; blocked: boolean; softCapped: boolean } {
    if (!searchWindowStart || now - searchWindowStart > SEARCH_WINDOW_MS) {
      searchWindowStart = now;
      searchCallCount = 0;
    }
    searchCallCount++;
    return {
      count: searchCallCount,
      windowStart: searchWindowStart,
      blocked: searchCallCount > SEARCH_BLOCK_AFTER,
      softCapped: searchCallCount > SEARCH_MAX_RESULTS_AFTER,
    };
  }

  registerCtxTool(
    "ctx_search",
    {
      title: "Search Indexed Content",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Search indexed content; batch related queries.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Project scope."),
        queries: z.array(z.string()).min(1).describe("Queries; batch related questions."),
        limit: z.coerce.number().int().min(1).optional().default(3).describe("Results/query (default 3)."),
        source: z.string().optional().describe("Source filter (partial match)."),
        contentType: z.enum(["code", "prose"]).optional().describe("Content type."),
      }),
    },
    async ({ queries, limit = 3, source, contentType }) => {
      try {
        const store = getStore();
        if (store.isEmpty()) {
          return {
            content: [{
              type: "text" as const,
              text: "Knowledge base is empty — index content first with ctx_batch_execute, ctx_fetch_and_index, or ctx_index.",
            }],
            isError: true,
          };
        }

        const now = Date.now();
        const flood = recordSearch(now);
        if (flood.blocked) {
          return {
            content: [{
              type: "text" as const,
              text: `BLOCKED: ${flood.count} search calls in ${Math.round((now - flood.windowStart) / 1000)}s. Batch queries or use ctx_batch_execute.`,
            }],
            isError: true,
          };
        }

        const effectiveLimit = flood.softCapped ? 1 : Math.min(limit, 2);
        const sections: string[] = [];
        let totalSize = 0;
        const MAX_TOTAL = 40 * 1024;

        for (const q of queries) {
          if (totalSize > MAX_TOTAL) {
            sections.push(`## ${q}\n(output cap reached)`);
            continue;
          }
          const results = store.searchWithFallback(q, effectiveLimit, source, contentType);
          if (results.length === 0) {
            sections.push(`## ${q}\nNo results found.`);
            continue;
          }
          const formatted = results.map((r) => {
            const ts = r.timestamp ? r.timestamp.slice(0, 16).replace("T", " ") : "";
            const header = `--- [${r.source}${ts ? " | " + ts : ""}] ---`;
            return `${header}\n### ${r.title}\n\n${extractSnippet(r.content, q, 1500, r.highlighted)}`;
          }).join("\n\n");
          sections.push(`## ${q}\n\n${formatted}`);
          totalSize += formatted.length;
        }

        let output = sections.join("\n\n---\n\n");
        if (store.lastRefreshCount > 0) {
          output = `> Auto-refreshed ${store.lastRefreshCount} stale source${store.lastRefreshCount > 1 ? "s" : ""}.\n\n${output}`;
        }
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Search error: ${message}` }], isError: true };
      }
    },
  );
}
