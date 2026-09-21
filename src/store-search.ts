import type { PreparedStatement } from "./db-base.js";
import { withRetry } from "./db-base.js";
import {
  STOPWORDS,
  countAdjacentPairs,
  findAllPositions,
  findMinSpan,
  levenshtein,
  maxEditDistance,
  sanitizeQuery,
  sanitizeTrigramQuery,
} from "./store-query.js";
import type { StoreStatements } from "./store-schema.js";
import type { SearchResult } from "./types.js";

type SourceMatchMode = "like" | "exact";

type SearchRow = {
  title: string;
  content: string;
  content_type: string;
  timestamp: string | null;
  label: string;
  rank: number;
  highlighted: string;
};

export class StoreSearchEngine {
  #fuzzyCache = new Map<string, string | null>();
  static readonly FUZZY_CACHE_SIZE = 256;

  readonly #statements: StoreStatements;
  readonly #refresh: () => void;

  constructor(statements: StoreStatements, refresh: () => void) {
    this.#statements = statements;
    this.#refresh = refresh;
  }

  clearFuzzyCache(): void {
    this.#fuzzyCache.clear();
  }

  mapSearchRows(rows: SearchRow[]): SearchResult[] {
    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: r.rank,
      contentType: r.content_type as "code" | "prose",
      highlighted: r.highlighted,
      timestamp: r.timestamp ?? undefined,
    }));
  }

  sourceFilterParam(source: string, sourceMatchMode: SourceMatchMode): string {
    if (sourceMatchMode === "exact") return source;
    // Escape SQLite LIKE metacharacters so user-supplied source labels
    // containing `_`, `%`, or `\` are matched literally rather than as
    // wildcards. Backslash must be replaced first (otherwise subsequent
    // escapes would themselves be re-escaped). Paired with `ESCAPE '\'`
    // in the four prepared LIKE statements (#stmtSearchPorter*,
    // #stmtSearchTrigram*). Regression: #646.
    const escaped = source
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    return `%${escaped}%`;
  }

  search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeQuery(query, mode);

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#statements.stmtSearchPorterExactContentType
        : this.#statements.stmtSearchPorterFilteredContentType;
      params = [sanitized, this.sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#statements.stmtSearchPorterExact
        : this.#statements.stmtSearchPorterFiltered;
      params = [sanitized, this.sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#statements.stmtSearchPorterContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#statements.stmtSearchPorter;
      params = [sanitized, limit];
    }

    return withRetry(() => this.mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Trigram Search (Layer 2) ──

  searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeTrigramQuery(query, mode);
    if (!sanitized) return [];

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#statements.stmtSearchTrigramExactContentType
        : this.#statements.stmtSearchTrigramFilteredContentType;
      params = [sanitized, this.sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#statements.stmtSearchTrigramExact
        : this.#statements.stmtSearchTrigramFiltered;
      params = [sanitized, this.sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#statements.stmtSearchTrigramContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#statements.stmtSearchTrigram;
      params = [sanitized, limit];
    }

    return withRetry(() => this.mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Fuzzy Correction (Layer 3) ──

  fuzzyCorrect(query: string): string | null {
    const word = query.toLowerCase().trim();
    if (word.length < 3) return null;

    // Cache hit: promote to tail (Map preserves insertion order → LRU).
    if (this.#fuzzyCache.has(word)) {
      const cached = this.#fuzzyCache.get(word) ?? null;
      this.#fuzzyCache.delete(word);
      this.#fuzzyCache.set(word, cached);
      return cached;
    }

    const maxDist = maxEditDistance(word.length);

    const candidates = this.#statements.stmtFuzzyVocab.all(
      word.length - maxDist,
      word.length + maxDist,
    ) as Array<{ word: string }>;

    let bestWord: string | null = null;
    let bestDist = maxDist + 1;
    let exactMatch = false;

    for (const { word: candidate } of candidates) {
      if (candidate === word) {
        exactMatch = true;
        break;
      }
      const dist = levenshtein(word, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    const result = exactMatch ? null : bestDist <= maxDist ? bestWord : null;

    // Evict the oldest entry before insert if we hit the size cap.
    if (this.#fuzzyCache.size >= StoreSearchEngine.FUZZY_CACHE_SIZE) {
      const oldestKey = this.#fuzzyCache.keys().next().value;
      if (oldestKey !== undefined) this.#fuzzyCache.delete(oldestKey);
    }
    this.#fuzzyCache.set(word, result);

    return result;
  }

  // ── Reciprocal Rank Fusion (Cormack et al. 2009) ──

  rrfSearch(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
    mode: "AND" | "OR" = "OR",
  ): SearchResult[] {
    const K = 60; // Standard RRF constant
    const fetchLimit = Math.max(limit * 2, 10);

    const porterResults = this.search(query, fetchLimit, source, mode, contentType, sourceMatchMode);
    const trigramResults = this.searchTrigram(query, fetchLimit, source, mode, contentType, sourceMatchMode);

    const scoreMap = new Map<string, { result: SearchResult; score: number }>();
    const key = (r: SearchResult) => `${r.source}::${r.title}`;

    for (const [i, r] of porterResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    for (const [i, r] of trigramResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ result, score }) => ({ ...result, rank: -score }));
  }

  // ── Proximity Reranking ──

  applyProximityReranking(
    results: SearchResult[],
    query: string,
  ): SearchResult[] {
    const allTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    // Exclude stopwords from proximity/title scoring — they match everywhere
    // and inflate boosts for irrelevant chunks. Keep all terms as fallback.
    const filtered = allTerms.filter((w) => !STOPWORDS.has(w));
    const terms = filtered.length > 0 ? filtered : allTerms;

    return results
      .map((r) => {
        // Title-match boost: query terms found in the chunk title get a boost.
        // Code chunks get a stronger title boost (function/class names are high
        // signal) while prose chunks get a moderate one (headings are useful but
        // body carries more weight).
        const titleLower = r.title.toLowerCase();
        const titleHits = terms.filter((t) => titleLower.includes(t)).length;
        const titleWeight = r.contentType === "code" ? 0.6 : 0.3;
        const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

        // Proximity boost for multi-term queries. minSpan picks the single
        // tightest window — frequency doesn't move it, so a long doc with one
        // tight occurrence outranks a short doc with several. Phrase-frequency
        // reward layers a saturating frequency signal on top: cap 0.5 (below
        // proximity max ≈1.0, in title-boost range), saturates at 4 hits.
        let proximityBoost = 0;
        let phraseBoost = 0;
        if (terms.length >= 2) {
          const content = r.content.toLowerCase();
          const positions = terms.map((t) => findAllPositions(content, t));

          if (!positions.some((p) => p.length === 0)) {
            const minSpan = findMinSpan(positions);
            proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));

            const adjacentPairs = countAdjacentPairs(positions, terms);
            phraseBoost = 0.5 * Math.min(1, adjacentPairs / 4);
          }
        }

        return { result: r, boost: titleBoost + proximityBoost + phraseBoost };
      })
      .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
      .map(({ result }) => result);
  }

  // ── Unified Fallback Search ──

  searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    this.#refresh();

    // Prefer precision: if any chunk matches all meaningful terms, do not
    // spend context on partial matches. Relax to OR only when strict retrieval
    // has no result, preserving recall for exploratory queries.
    for (const mode of ["AND", "OR"] as const) {
      const rrfResults = this.rrfSearch(query, limit, source, contentType, sourceMatchMode, mode);
      if (rrfResults.length > 0) {
        const reranked = this.applyProximityReranking(rrfResults, query);
        return reranked.map((r) => ({ ...r, matchLayer: "rrf" as const }));
      }
    }

    // Fuzzy correction is the final fallback; keep the same strict-then-relaxed
    // order so typo recovery does not reintroduce noisy partial matches first.
    const words = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const original = words.join(" ");
    const correctedWords = words.map((w) => this.fuzzyCorrect(w) ?? w);
    const correctedQuery = correctedWords.join(" ");

    if (correctedQuery !== original) {
      for (const mode of ["AND", "OR"] as const) {
        const fuzzyResults = this.rrfSearch(correctedQuery, limit, source, contentType, sourceMatchMode, mode);
        if (fuzzyResults.length > 0) {
          const reranked = this.applyProximityReranking(fuzzyResults, correctedQuery);
          return reranked.map((r) => ({ ...r, matchLayer: "rrf-fuzzy" as const }));
        }
      }
    }

    return [];
  }
}
