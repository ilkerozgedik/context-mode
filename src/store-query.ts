export const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  // Common in code/changelogs
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove case-insensitive duplicate tokens while preserving the first
 * occurrence's original casing. FTS5's unicode61 tokenizer lowercases on
 * both sides, so `"Error" OR "error"` produces no extra recall — just
 * redundant index lookups. Dedup keeps the compiled query minimal.
 */
function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export function sanitizeQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const words = dedupeTokens(
    query
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 0 &&
          !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
      ),
  );

  if (words.length === 0) return '""';

  // Filter stopwords to improve BM25 ranking — common terms like "update",
  // "test", "fix" appear everywhere and dilute relevance scoring.
  // Fall back to unfiltered words if ALL terms are stopwords.
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function sanitizeTrigramQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = dedupeTokens(
    cleaned.split(/\s+/).filter((w) => w.length >= 3),
  );
  if (words.length === 0) return "";

  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

export function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// ── Proximity helpers (pure functions) ──

/** Find all positions of a term in text. */
export function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/**
 * Count matched adjacent pairs across consecutive query terms.
 * For each pair (term[i], term[i+1]), pairs each left position with at most one
 * right position whose offset falls within `gap` chars of `p + len(term[i])`.
 * `positionLists` must be sorted ascending (output of `findAllPositions` is).
 * Each right position is consumed by at most one left, so `"foo foo bar"`
 * counts 1 pair, not 2 — matches IR phrase-occurrence intent and avoids
 * inflating boosts for repeated-token queries.
 * Used by reranker to layer a frequency signal on top of minSpan proximity:
 * 30-char gap covers natural prose without rewarding distant matches.
 */
export function countAdjacentPairs(
  positionLists: number[][],
  terms: string[],
  gap: number = 30,
): number {
  if (positionLists.length < 2 || terms.length < 2) return 0;
  let total = 0;
  const pairs = Math.min(positionLists.length, terms.length) - 1;
  for (let i = 0; i < pairs; i++) {
    const left = positionLists[i];
    const right = positionLists[i + 1];
    const leftLen = terms[i].length;
    let j = 0;
    for (const p of left) {
      const minStart = p + leftLen;
      const maxStart = minStart + gap;
      while (j < right.length && right[j] < minStart) j++;
      if (j < right.length && right[j] <= maxStart) {
        total++;
        j++;
      }
    }
  }
  return total;
}

/**
 * Find minimum span (window) covering at least one position from each list.
 * Uses a sweep-line approach: advance the pointer at the current minimum.
 */
export function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists;
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) {
        curMin = val;
        minIdx = i;
      }
      if (val > curMax) {
        curMax = val;
      }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}
