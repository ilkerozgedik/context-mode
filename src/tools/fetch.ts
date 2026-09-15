import { cpus } from "node:os";
import { z } from "zod";
import { executor } from "../app-runtime.js";
import { resolveConfiguredConcurrency } from "../batch.js";
import { fetchOneUrl, indexFetched, type FetchOneResult, type IndexedFetchResult } from "../fetch.js";
import { runPool, type PoolJob } from "../runPool.js";
import type { RegisterTool } from "./registry.js";

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request cancelled");
}

export function registerFetchTools(registerCtxTool: RegisterTool): void {
  registerCtxTool(
    "ctx_fetch_and_index",
    {
      title: "Fetch & Index URL(s)",
      // #846: fetches external URLs (open world) and writes them into the store.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: "Fetch and index URL content server-side so raw pages stay out of context. Use ctx_search for follow-up retrieval.",
      inputSchema: z.strictObject({
        cwd: z.string().optional().describe("Project directory used to scope the persistent index."),
        requests: z.array(
          z.object({
            url: z.string().describe("URL to fetch"),
            source: z.string().optional().describe("Label for this URL's indexed content"),
          }),
        ).min(1).describe("URLs to fetch and index."),
        concurrency: z
          .coerce.number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(1)
          .describe("Parallel URL fetches, 1-8; indexing remains serial."),
        force: z
          .boolean()
          .optional()
          .describe("Skip cache and re-fetch even if content was recently indexed"),
        ttl: z
          .coerce.number()
          .int()
          .min(0)
          .optional()
          .describe("Cache TTL in ms; 0 bypasses cache."),
      }),
    },
    async ({ requests, concurrency, force, ttl }, ctx) => {
      const batch: { url: string; source?: string }[] = requests;
      const requestedConcurrency = concurrency ?? 1;
      const configuredConcurrency = resolveConfiguredConcurrency(requestedConcurrency);
      const configuredCapped = configuredConcurrency < requestedConcurrency;

      // Parallel fetch via shared runPool primitive. capByCpuCount only for batch
      // — single-URL doesn't need the cap (only one job, executor is one subprocess).
      const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
        run: () => fetchOneUrl(executor, req.url, req.source, force, ttl, ctx?.signal),
      }));
      const pool = await runPool(jobs, {
        concurrency: configuredConcurrency,
        capByCpuCount: requestedConcurrency > 1,
      });
      const { settled, effectiveConcurrency } = pool;
      const capped = configuredCapped || pool.capped;

      // Serial index drain — workers race on fetch, but store.index* runs one at a time.
      type Finalized =
        | { kind: "cached"; label: string; chunkCount: number; ageStr: string; ttlStr: string }
        | { kind: "fetched"; indexed: IndexedFetchResult }
        | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" }
        | { kind: "job_error"; url: string; error: string };

      const finalized: Finalized[] = [];
      for (let i = 0; i < settled.length; i++) {
        if (ctx?.signal?.aborted) throw abortReason(ctx.signal);
        const r = settled[i];
        if (r.status === "rejected") {
          const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
          finalized.push({ kind: "job_error", url: batch[i].url, error: message });
          continue;
        }
        const v = r.value;
        if (v.kind === "cached") {
          finalized.push({ kind: "cached", label: v.label, chunkCount: v.chunkCount, ageStr: v.ageStr, ttlStr: v.ttlStr });
        } else if (v.kind === "fetch_error") {
          finalized.push({ kind: "fetch_error", url: v.url, error: v.error, reason: v.reason });
        } else {
          // Serial FTS5 write here — no parallel store.index calls.
          // Cache miss: fetch and index the content.
          finalized.push({ kind: "fetched", indexed: indexFetched(v) });
        }
      }

      // Batch response — aggregated summary; isError only when EVERY URL failed.
      // Per-URL preview capped tightly so a 8-URL batch doesn't undo the
      // context-savings the tool exists to deliver (PRD review finding G1).
      const FETCH_BATCH_PREVIEW_LIMIT = 384; // ~3KB total for 8-URL batches
      const lines: string[] = [];
      let totalSections = 0;
      let totalBytes = 0;
      let cachedCount = 0;
      let fetchedCount = 0;
      let errorCount = 0;
      const snippets: string[] = [];
      for (const r of finalized) {
        if (r.kind === "cached") {
          cachedCount++;
          lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr}, TTL: ${r.ttlStr})`);
        } else if (r.kind === "fetched") {
          fetchedCount++;
          totalSections += r.indexed.totalChunks;
          totalBytes += r.indexed.totalBytes;
          const kb = (r.indexed.totalBytes / 1024).toFixed(1);
          lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
          const snippet = r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
            ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
            : r.indexed.preview;
          snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
        } else {
          errorCount++;
          lines.push(`- [err]   ${r.url}: ${r.error}`);
        }
      }

      const totalKB = (totalBytes / 1024).toFixed(1);
      const cappedNote = capped
        ? ` cap=${effectiveConcurrency}/${cpus().length}cpu`
        : "";
      // Status line: counts + sections + size, with singular/plural agreement
      // (count=1 → "1 error" not "1 errors") so the line stays grammatical.
      const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
      const headerLine =
        `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
        `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
        `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

      const text = [
        headerLine,
        "",
        ...lines,
        "",
        `ctx_search(queries: [...], source: "<label>") for full content.`,
        ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        isError: errorCount === batch.length, // only mark error if every URL failed
      };
    },
  );
}
