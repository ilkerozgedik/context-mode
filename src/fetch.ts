import { createRequire } from "node:module";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolyglotExecutor } from "./executor.js";
import { getStore } from "./project-context.js";
import type { IndexResult } from "./store.js";
import { charSafePrefix } from "./truncate.js";

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request cancelled");
}

// ─────────────────────────────────────────────────────────
// Turndown path resolution (external dep, like better-sqlite3)
// ─────────────────────────────────────────────────────────

let _turndownPath: string | null = null;
let _gfmPluginPath: string | null = null;

function resolveTurndownPath(): string {
  if (!_turndownPath) {
    const require = createRequire(import.meta.url);
    _turndownPath = require.resolve("turndown");
  }
  return _turndownPath;
}

function resolveGfmPluginPath(): string {
  if (!_gfmPluginPath) {
    const require = createRequire(import.meta.url);
    _gfmPluginPath = require.resolve("turndown-plugin-gfm");
  }
  return _gfmPluginPath;
}

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

// Subprocess code that fetches a URL, detects Content-Type, and outputs a
// __CM_CT__:<type> marker on the first line so the handler can route to the
// appropriate indexing strategy.  HTML is converted to markdown via Turndown.
export function buildFetchCode(url: string, outputPath: string): string {
  const turndownPath = JSON.stringify(resolveTurndownPath());
  const gfmPath = JSON.stringify(resolveGfmPluginPath());
  const escapedOutputPath = JSON.stringify(outputPath);
  // Embed classifyIp into the subprocess so the connect-time DNS lookup is
  // re-validated with the same policy as ssrfGuard. Without this, an attacker
  // can serve a public IP for the parent's pre-flight ssrfGuard lookup and
  // then a blocked IP (e.g. 169.254.169.254 IMDS) for the subprocess fetch's
  // own lookup — classic DNS rebinding across the parent/child boundary.
  //
  // CRITICAL: bundlers (esbuild) rename top-level identifiers — `classifyIp`
  // becomes e.g. `_h` in server.bundle.mjs. `classifyIp.toString()` returns
  // the renamed source `function _h(t){...}`, but the embedded subprocess
  // template references the literal name `classifyIp` (and the function's
  // own internal recursion is also `_h(...)`). Result: the subprocess sees
  // `function _h(t){...; return _h(...)}` injected, then references to
  // `classifyIp` blow up with `ReferenceError: classifyIp is not defined`.
  //
  // Fix: emit `var <fnName> = <fn-expr>; var classifyIp = <fnName>;`. The
  // named function expression preserves recursion under whatever name the
  // bundler chose, and the alias re-exposes the canonical `classifyIp`
  // identifier the rest of the embedded script depends on.
  const classifyIpInner = classifyIp.toString();
  const classifyIpFnName = classifyIp.name || "classifyIp";
  const classifyIpSrc =
    classifyIpFnName === "classifyIp"
      ? `var classifyIp = ${classifyIpInner};`
      : `var ${classifyIpFnName} = ${classifyIpInner};\nvar classifyIp = ${classifyIpFnName};`;
  const strictMode = process.env.CTX_FETCH_STRICT === "1";
  return `
const TurndownService = require(${turndownPath});
const { gfm } = require(${gfmPath});
const fs = require('fs');
const dns = require('no' + 'de:dns');
const dnsPromises = require('no' + 'de:dns/promises');
const url = ${JSON.stringify(url)};
const outputPath = ${escapedOutputPath};

// Strip proxy env vars from this subprocess only. A configured outbound
// proxy (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY) would route fetch through
// an arbitrary target — DNS resolution happens at the proxy and the
// in-subprocess DNS rebinding guard never sees the rebound IP. The
// sandbox fetch path has no legitimate need for an upstream proxy.
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.all_proxy;
delete process.env.npm_config_proxy;
delete process.env.npm_config_https_proxy;

${classifyIpSrc}

const STRICT = ${JSON.stringify(strictMode)};

// SSRF rebinding defense: every dns.lookup call inside this subprocess
// (including the one undici performs to connect the fetch socket) is
// re-validated against the same policy ssrfGuard runs in the parent.
// Even if a hostname rebinds between the parent's pre-flight check and
// the subprocess's actual connect, the connect-time lookup re-classifies
// every returned record and aborts before TCP if any verdict is "block".
const _origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') { options = { family: options }; }
  const wantAll = options && options.all;
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  _origLookup(hostname, opts, function(err, records) {
    if (err) return callback(err);
    if (!Array.isArray(records)) {
      records = [{ address: records, family: (options && options.family) || 4 }];
    }
    for (var i = 0; i < records.length; i++) {
      var verdict = classifyIp(records[i].address);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        return callback(new Error(
          'SSRF blocked at connect-time: ' + hostname +
          ' resolves to ' + records[i].address +
          ' (' + verdict + ')'
        ));
      }
    }
    if (wantAll) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  });
};

// dns/promises is a separate function reference. Patching dns.lookup does
// NOT affect dnsPromises.lookup. Today undici's connect path uses callback
// dns.lookup so default fetch is covered, but the invariant is fragile —
// any future undici switch (or user code calling dnsPromises.lookup
// directly) would bypass the guard. Patch both to keep the contract.
const _origPromisesLookup = dnsPromises.lookup;
dnsPromises.lookup = async function patchedPromisesLookup(hostname, options) {
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  const records = await _origPromisesLookup(hostname, opts);
  const list = Array.isArray(records) ? records : [records];
  for (var i = 0; i < list.length; i++) {
    var verdict = classifyIp(list[i].address);
    if (verdict === 'block' || (STRICT && verdict === 'private')) {
      throw new Error(
        'SSRF blocked at connect-time: ' + hostname +
        ' resolves to ' + list[i].address + ' (' + verdict + ')'
      );
    }
  }
  return options && options.all
    ? list
    : { address: list[0].address, family: list[0].family };
};

// dns.resolve4 / dns.resolve6 use a different code path (no getaddrinfo,
// no /etc/hosts) than dns.lookup — they must be patched separately or the
// guard is trivially bypassed by any caller using dns.resolve* directly.
['resolve4', 'resolve6'].forEach(function patchResolve(name) {
  const _origResolve = dns[name];
  dns[name] = function patchedResolve(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = undefined; }
    _origResolve.call(dns, hostname, options || {}, function(err, addrs) {
      if (err) return cb(err);
      var withTtl = options && options.ttl;
      for (var i = 0; i < addrs.length; i++) {
        var ip = withTtl ? addrs[i].address : addrs[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
      cb(null, addrs);
    });
  };
});

// Generic dns.resolve is a polymorphic dispatcher (rrtype-driven). Internally
// Node delegates to dns.resolve4/dns.resolve6 for A/AAAA, but the patches
// above hook the *exported* references — Node's internal dispatcher holds
// captured originals and bypasses our patch. Patch the wrapper explicitly:
// classify A/AAAA records the same way; pass through CNAME/MX/TXT/SRV/etc.
const _origResolveGeneric = dns.resolve;
dns.resolve = function patchedResolveGeneric(hostname, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
  _origResolveGeneric.call(dns, hostname, rrtype, function(err, records) {
    if (err) return cb(err);
    if ((rrtype === 'A' || rrtype === 'AAAA') && Array.isArray(records)) {
      for (var i = 0; i < records.length; i++) {
        var ip = records[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
    }
    cb(null, records);
  });
};

function emit(ct, content) {
  // Write content to file to bypass executor stdout truncation (100KB limit).
  // Only the content-type marker goes to stdout.
  fs.writeFileSync(outputPath, content);
  console.log('__CM_CT__:' + ct);
}

// Manual redirect handling: a 3xx Location header can rebind the subprocess
// fetch to an alternate host the parent's pre-flight ssrfGuard never saw.
// Even with the connect-time DNS patch, a redirect target that is a literal
// IP (e.g. http://169.254.169.254/) skips getaddrinfo entirely. Walk the
// chain manually so every hop runs through classifyIp before the next fetch.
const MAX_REDIRECTS = 5;
async function fetchWithManualRedirect(initialUrl) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const resp = await fetch(currentUrl, { redirect: 'manual' });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get('location') || resp.headers.get('Location');
    if (!location) return resp;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
    }
    let nextParsed;
    try { nextParsed = new URL(location, currentUrl); } catch (e) {
      throw new Error('SSRF blocked: invalid redirect Location: ' + location);
    }
    if (nextParsed.protocol !== 'http:' && nextParsed.protocol !== 'https:') {
      throw new Error('SSRF blocked: redirect to non-http(s) scheme ' + nextParsed.protocol);
    }
    // If the redirect target is a literal IP, classify it directly — no DNS
    // lookup will fire and the connect-time guard would never see it.
    const hostname = nextParsed.hostname.replace(/^\[|\]$/g, '');
    const isIpLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
    if (isIpLiteral) {
      const verdict = classifyIp(hostname);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        throw new Error('SSRF blocked: redirect to ' + hostname + ' (' + verdict + ')');
      }
    } else {
      // Hostname target: resolve and classify every record. The patched
      // dns.lookup also fires on the next fetch's connect, but checking
      // here gives a clearer error and short-circuits before TCP setup.
      const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
      for (const rec of records) {
        const verdict = classifyIp(rec.address);
        if (verdict === 'block' || (STRICT && verdict === 'private')) {
          throw new Error(
            'SSRF blocked: redirect target ' + hostname +
            ' resolves to ' + rec.address + ' (' + verdict + ')'
          );
        }
      }
    }
    currentUrl = nextParsed.toString();
  }
  throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
}

// Subprocess response-body size cap. A malicious or unexpectedly large
// endpoint reachable through ctx_fetch_and_index would otherwise stream
// gigabytes into resp.text(), then into outputPath, then into the parent
// MCP server's heap via readFileSync. 50 MB is far above typical web
// page / API response sizes (~1-5 MB) but bounded enough to keep parent
// heap survivable. Cap both early via Content-Length and after the read.
const MAX_FETCH_BYTES = 50 * 1024 * 1024;
async function safeText(resp) {
  const cl = parseInt(resp.headers.get('content-length') || '0', 10);
  if (cl > MAX_FETCH_BYTES) {
    throw new Error('Response too large: Content-Length ' + cl + ' exceeds ' + MAX_FETCH_BYTES);
  }
  const text = await resp.text();
  if (text.length > MAX_FETCH_BYTES) {
    throw new Error('Response too large: ' + text.length + ' bytes exceeds ' + MAX_FETCH_BYTES);
  }
  return text;
}

async function main() {
  const resp = await fetchWithManualRedirect(url);
  if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
  const contentType = resp.headers.get('content-type') || '';

  // --- JSON responses ---
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await safeText(resp);
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      emit('json', pretty);
    } catch {
      emit('text', text);
    }
    return;
  }

  // --- HTML responses (default for text/html, application/xhtml+xml) ---
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const html = await safeText(resp);
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    td.use(gfm);
    td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
    emit('html', td.turndown(html));
    return;
  }

  // --- Everything else: plain text, CSV, XML, etc. ---
  const text = await safeText(resp);
  emit('text', text);
}
main();
`;
}

// ─────────────────────────────────────────────────────────
// fetch_and_index helpers — split into parallel-safe fetch and serial-only index
// ─────────────────────────────────────────────────────────

const FETCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_PREVIEW_LIMIT = 3072;

function formatFetchTtl(ttlMs: number): string {
  if (ttlMs === 0) return "0ms";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (ttlMs % day === 0) return `${ttlMs / day}d`;
  if (ttlMs % hour === 0) return `${ttlMs / hour}h`;
  if (ttlMs % minute === 0) return `${ttlMs / minute}m`;
  return `${ttlMs}ms`;
}

export type FetchOneResult =
  | { kind: "cached"; label: string; chunkCount: number; estimatedBytes: number; ageStr: string; ttlStr: string }
  | { kind: "fetched"; url: string; source?: string; markdown: string; header: string }
  | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" };

/**
 * Pure fetch step — TTL cache check + subprocess fetch. SAFE TO RUN IN PARALLEL.
 * Performs zero SQLite writes (only reads source meta). Caller must funnel
 * fetched results through `indexFetched` serially to avoid FTS5 WAL contention.
 */
/**
 * SSRF guard for ctx_fetch_and_index: validate URL scheme + resolve target IP +
 * block link-local / IMDS / multicast / reserved IP ranges. Returns null if
 * safe; returns a FetchOneResult fetch_error if blocked.
 *
 * Policy (PR #401 ops review, developer-friendly default):
 *
 * **HARD BLOCK** (no legitimate dev workflow):
 *   - file://, gopher://, javascript:, data: schemes (only http: and https:)
 *   - 169.254.0.0/16 link-local (INCLUDES 169.254.169.254 = AWS/GCP/Azure IMDS
 *     cloud credential endpoint — high-value target for indirect prompt injection)
 *   - IPv6 link-local fe80::/10
 *   - Multicast (224+ IPv4, ff00::/8 IPv6) and reserved (0.0.0.0/8) ranges
 *
 * **ALLOW by default** (legitimate developer use cases dominate):
 *   - localhost, 127.x.x.x, ::1 (local dev servers — Next.js, Vite, Postgres, …)
 *   - 10.x, 172.16-31.x, 192.168.x RFC1918 private (developer's internal network)
 *
 * **STRICT MODE** opt-in via env var: `CTX_FETCH_STRICT=1`
 *   - Blocks loopback + RFC1918 too
 *   - For hosted/CI environments where the runtime isn't the user's own machine
 *
 * DNS resolution is performed against the resolved IP (not just URL parse) so a
 * hostname like `evil.com` pointing to 169.254.169.254 is rejected — defends
 * against attacker-controlled DNS records and DNS rebinding.
 */
async function ssrfGuard(rawUrl: string): Promise<FetchOneResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "fetch_error", url: rawUrl, error: "invalid URL", reason: "exit" };
  }

  // 1. Scheme allowlist — http and https only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `URL scheme "${parsed.protocol}" not allowed (only http: and https:)`,
      reason: "exit",
    };
  }

  const strict = process.env.CTX_FETCH_STRICT === "1";

  // 2. DNS resolve + check IP ranges (hard-block + optional strict-mode block)
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    for (const rec of records) {
      const verdict = classifyIp(rec.address);
      if (verdict === "block") {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to ${rec.address} — blocked (link-local / IMDS / multicast / reserved)`,
          reason: "exit",
        };
      }
      if (verdict === "private" && strict) {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to private IP ${rec.address} — blocked under CTX_FETCH_STRICT=1`,
          reason: "exit",
        };
      }
    }
  } catch (err) {
    // libuv DNS error codes that typically indicate the resolver itself can't
    // reach a nameserver — common when the MCP host process is running under
    // a sandbox that blocks outbound network, OR a transient upstream DNS
    // hiccup. Append an imperative retry hint so the agent does not capitulate
    // to training data on the FIRST transient failure (PR #654 substitute —
    // Keep fetch error wording consistent across call sites.
    const errCode = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
    const isTransientDns = errCode === "ETIMEOUT" || errCode === "ETIMEDOUT" ||
      errCode === "EAI_AGAIN" || errCode === "ENETUNREACH" || errCode === "EPERM";
    const baseMsg = err instanceof Error ? err.message : String(err);
    const hint = isTransientDns
      ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
      : "";
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `DNS lookup failed for "${parsed.hostname}": ${baseMsg}${hint}`,
      reason: "exit",
    };
  }

  return null; // safe to fetch
}

/**
 * Classify an IP address.
 *   - "block":    always blocked (link-local/IMDS/multicast/reserved/malformed)
 *   - "private":  loopback or RFC1918 — allowed by default, blocked in strict mode
 *   - "public":   safe to fetch
 *
 * Exported (via the function name) so SSRF tests can exercise the matcher directly.
 */
export function classifyIp(rawIp: string): "block" | "private" | "public" {
  // RFC 6874 zone identifiers (`fe80::1%eth0`, URL-encoded `%25eth0`) must
  // be stripped BEFORE any prefix/equality classification. Without the strip,
  // a loopback `::1%eth0` no longer matches `lower === "::1"` and falls
  // through to "public" — silently bypassing the SSRF guard. Strip first,
  // classify second.
  const pctIdx = rawIp.indexOf("%");
  const ip = pctIdx === -1 ? rawIp : rawIp.slice(0, pctIdx);
  const lower = ip.toLowerCase();

  // IPv6 takes priority — check for `:` first so IPv4-mapped addresses
  // (`::ffff:127.0.0.1`) don't get incorrectly routed through the IPv4 parser.
  if (lower.includes(":")) {
    // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — recurse through IPv4 classifier
    const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
    if (v4MappedMatch) return classifyIp(v4MappedMatch[1]);
    // Hard-block
    if (lower === "::") return "block"; // unspecified
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return "block"; // fe80::/10 link-local
    if (lower.startsWith("ff")) return "block"; // ff00::/8 multicast
    // Private (loopback + ULA)
    if (lower === "::1") return "private";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7 ULA
    return "public";
  }

  // IPv4 (or non-IP string — malformed = block)
  if (!ip.includes(".")) return "block"; // not an IP at all
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return "block";
  const [a, b] = parts;
  // Hard-block (no legitimate use)
  if (a === 169 && b === 254) return "block"; // link-local incl. 169.254.169.254 (IMDS)
  if (a === 0) return "block";                 // 0.0.0.0/8 (current network)
  if (a >= 224) return "block";                // 224.0.0.0+ multicast/reserved
  // Private (loopback + RFC1918) — allow by default
  if (a === 127) return "private";                          // 127.0.0.0/8 loopback
  if (a === 10) return "private";                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private";    // 172.16.0.0/12
  if (a === 192 && b === 168) return "private";             // 192.168.0.0/16
  return "public";
}

export async function fetchOneUrl(
  executor: PolyglotExecutor,
  url: string,
  source: string | undefined,
  force: boolean | undefined,
  ttl: number | undefined,
  signal?: AbortSignal,
): Promise<FetchOneResult> {
 if (signal?.aborted) throw abortReason(signal);
 // SSRF guard — reject file://, javascript:, loopback, RFC1918, IMDS, link-local
  // BEFORE any cache lookup or subprocess spawn. Even cached entries shouldn't
  // serve a previously-poisoned source label.
  const ssrfBlock = await ssrfGuard(url);
  if (ssrfBlock) return ssrfBlock;

  if (!force && ttl !== 0) {
    const store = getStore();
    // Cache key composes (source, url) so two distinct URLs sharing the same
    // `source` label do not collide — they each get their own cache slot
    // (commit 1f1243e regression test enforced).
    const cacheKey = source === undefined ? url : `${source}::${url}`;
    const meta = store.getSourceMeta(cacheKey);
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
      const ageMs = Date.now() - indexedAt.getTime();
      const cacheTtlMs = ttl ?? FETCH_TTL_MS;
      if (ageMs < cacheTtlMs) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        const estimatedBytes = meta.chunkCount * 1600; // ~1.6KB/chunk avg
        return { kind: "cached", label: meta.label, chunkCount: meta.chunkCount, estimatedBytes, ageStr, ttlStr: formatFetchTtl(cacheTtlMs) };
      }
      // Stale — fall through to re-fetch silently
    }
  }

  const outputPath = join(tmpdir(), `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
  try {
    const fetchCode = buildFetchCode(url, outputPath);
    const result = await executor.execute({
      language: "javascript",
      code: fetchCode,
      timeout: 30_000,
      signal,
    });
    if (signal?.aborted) throw abortReason(signal);
    if (result.exitCode !== 0) {
      // Subprocess fetch failure — undici / fetch can surface EAI_AGAIN /
      // ETIMEDOUT / ENETUNREACH in stderr when the resolver is overloaded
      // or the network is briefly unavailable. Append the same retry hint
      // ssrfGuard's pre-flight DNS path emits so the agent doesn't capitulate
      // to training data on the first transient failure (PR #654 substitute —
      // Keep fetch error wording consistent across call sites.
      const raw = result.stderr || result.stdout || "unknown error";
      const isTransientDns = /\b(EAI_AGAIN|ETIMEDOUT|ETIMEOUT|ENETUNREACH|EPERM|getaddrinfo)\b/.test(raw);
      const hint = isTransientDns
        ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
        : "";
      return { kind: "fetch_error", url, error: `${raw}${hint}`, reason: "exit" };
    }
    const header = (result.stdout || "").trim();
    let markdown: string;
    try {
      // Parent-side defense-in-depth on the subprocess output size. The
      // embedded safeText() in buildFetchCode already caps before writing,
      // but a torn write (subprocess killed mid-write, fs cache desync,
      // etc.) could still leave an oversized file. Bail before slurping
      // multiple gigabytes into the long-running MCP server's heap.
      const MAX_FETCH_OUTPUT_BYTES = 50 * 1024 * 1024;
      const fileSize = statSync(outputPath).size;
      if (fileSize > MAX_FETCH_OUTPUT_BYTES) {
        return { kind: "fetch_error", url, error: `subprocess output ${fileSize} bytes exceeds cap ${MAX_FETCH_OUTPUT_BYTES}`, reason: "read" };
      }
      markdown = readFileSync(outputPath, "utf-8").trim();
    } catch {
      return { kind: "fetch_error", url, error: "could not read subprocess output", reason: "read" };
    }
    if (markdown.length === 0) {
      return { kind: "fetch_error", url, error: "empty content", reason: "empty" };
    }
    return { kind: "fetched", url, source, markdown, header };
  } catch (err: unknown) {
    if (signal?.aborted) throw abortReason(signal);
    return {
      kind: "fetch_error",
      url,
      error: err instanceof Error ? err.message : String(err),
      reason: "throw",
    };
  } finally {
    try { rmSync(outputPath); } catch { /* already gone */ }
  }
}

export interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
}

/**
 * Serial-only indexing step — single FTS5 write per call. Caller loops over
 * fetched results and calls this one-at-a-time to avoid SQLite WAL contention
 * (PRD finding E).
 */
export function indexFetched(f: { url: string; source?: string; markdown: string; header: string }): IndexedFetchResult {
  const store = getStore();
  // Include the URL when a source label is supplied so distinct URLs do not collide.
  const storageLabel = f.source === undefined ? f.url : `${f.source}::${f.url}`;
  let indexed: IndexResult;
  if (f.header === "__CM_CT__:json") {
    indexed = store.indexJSON(f.markdown, storageLabel);
  } else if (f.header === "__CM_CT__:text") {
    indexed = store.indexPlainText(f.markdown, storageLabel);
  } else {
    indexed = store.index({ content: f.markdown, source: storageLabel });
  }
  // Track AFTER the FTS5 write succeeds — failed indexes shouldn't inflate the counter.
  const preview = f.markdown.length > FETCH_PREVIEW_LIMIT
    ? charSafePrefix(f.markdown, FETCH_PREVIEW_LIMIT) + "\n\n…[truncated — use ctx_search() for full content]"
    : f.markdown;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(f.markdown),
    preview,
  };
}
