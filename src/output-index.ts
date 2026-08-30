import { getProjectDir, getStore } from "./project-context.js";

export const INDEX_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
export const INTENT_SEARCH_THRESHOLD = 5_000;
export const LARGE_OUTPUT_THRESHOLD = 102_400;

function byteCappedPrefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return text.slice(0, end);
}

export function capIndexableOutput(text: string): { text: string; truncated: boolean } {
  const capped = byteCappedPrefix(text, INDEX_OUTPUT_CAP_BYTES);
  return { text: capped, truncated: capped.length !== text.length };
}

export function indexStdout(
  stdout: string,
  source: string,
  projectDir: string = getProjectDir(),
): { content: Array<{ type: "text"; text: string }> } {
  const indexable = capIndexableOutput(stdout);
  const indexed = getStore(projectDir).index({ content: indexable.text, source });
  return {
    content: [{
      type: "text",
      text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}${indexable.truncated ? `\nOutput capped at ${(INDEX_OUTPUT_CAP_BYTES / 1024 / 1024).toFixed(0)}MB before indexing.` : ""}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
    }],
  };
}

export function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
  projectDir: string = getProjectDir(),
): string {
  const indexable = capIndexableOutput(stdout);
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);
  const persistent = getStore(projectDir);
  const indexed = persistent.indexPlainText(indexable.text, source, undefined);
  const results = persistent.searchWithFallback(intent, maxResults, source);
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) lines.push("", `Searchable terms: ${distinctiveTerms.join(", ")}`);
    lines.push("", "Use ctx_search(queries: [...]) to explore the indexed content.");
    return lines.join("\n");
  }

  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];
  for (const result of results) {
    lines.push(`  - ${result.title}: ${result.content.split("\n")[0].slice(0, 120)}`);
  }
  if (distinctiveTerms.length > 0) lines.push("", `Searchable terms: ${distinctiveTerms.join(", ")}`);
  lines.push("", "Use ctx_search(queries: [...]) to retrieve full content of any section.");
  return lines.join("\n");
}
