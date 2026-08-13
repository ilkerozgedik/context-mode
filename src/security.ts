import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

const defaultGlobalSettingsPath = () => resolve(homedir(), ".claude", "settings.json");

// ==============================================================================
// File permission pattern parsing
// ==============================================================================

/**
 * Parse any tool permission pattern like "ToolName(glob)".
 * Returns { tool, glob } or null if not a valid pattern.
 */
export function parseToolPattern(
  pattern: string,
): { tool: string; glob: string } | null {
  // .+ is greedy: for "Read(some(path))" it captures "some(path)"
  // because $ forces the final \) to match only the last paren.
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  return match ? { tool: match[1], glob: match[2] } : null;
}

// ==============================================================================
// Glob-to-Regex Conversion
// ==============================================================================

/**
 * Convert a file path glob to a regex.
 *
 * File path semantics:
 * - `**` matches any number of path segments (including zero)
 * - `*` matches anything except path separators
 * - Paths are matched with forward slashes (callers normalize first)
 */
export function fileGlobToRegex(
  glob: string,
  caseInsensitive: boolean = false,
): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < glob.length) {
    // Handle ** (globstar): match any number of directory segments
    if (glob[i] === "*" && glob[i + 1] === "*") {
      // **/ at the start or after a slash means "zero or more directories"
      if (i + 2 < glob.length && glob[i + 2] === "/") {
        regexStr += "(.*/)?";
        i += 3; // skip "*" "*" "/"
      } else {
        // Trailing ** matches everything
        regexStr += ".*";
        i += 2;
      }
    } else if (glob[i] === "*") {
      // Single * matches anything except /
      regexStr += "[^/]*";
      i++;
    } else if (glob[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      // Escape regex-special characters
      regexStr += glob[i].replace(/[.+^${}()|[\]\\\/\-]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`, caseInsensitive ? "i" : "");
}

// ==============================================================================
// Settings Reader
// ==============================================================================

/**
 * Read deny patterns for a specific tool from settings files.
 *
 * Reads the configured settings tiers and extracts
 * only deny globs for the given tool. Used for Read and Grep enforcement
 * — checks if file paths should be blocked by deny patterns.
 *
 * Returns an array of arrays (one per settings file, in precedence order).
 * Each inner array contains the extracted glob strings.
 */
export function readToolDenyPatterns(
  toolName: string,
  projectDir?: string,
  globalSettingsPath?: string,
): string[][] {
  return readToolPermissionPatterns(toolName, "deny", projectDir, globalSettingsPath);
}

/**
 * Read `permissions.{deny|allow}` globs for a tool from every settings file in
 * precedence order (project local → project shared → global).
 *
 * Generalizes the original deny-only reader so the project-boundary guard
 * (#852) can consult the SAME `permissions.allow` rules the user already
 * maintains for the host's `Read` tool — instead of inventing a context-mode-
 * specific opt-out env that would rot into dead code. A user who legitimately
 * needs an out-of-project read expresses it once, in the host config, e.g.
 * `"permissions": { "allow": ["Read(/var/log/**)"] }`, and both the host and
 * context-mode honor it.
 */
export function readToolPermissionPatterns(
  toolName: string,
  kind: "deny" | "allow",
  projectDir?: string,
  globalSettingsPath?: string,
): string[][] {
  const result: string[][] = [];

  const extractGlobs = (path: string): string[] | null => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const entries = parsed?.permissions?.[kind];
    if (!Array.isArray(entries)) return [];

    const globs: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const tp = parseToolPattern(entry);
      if (tp && tp.tool === toolName) {
        globs.push(tp.glob);
      }
    }
    return globs;
  };

  if (projectDir) {
    const localGlobs = extractGlobs(
      resolve(projectDir, ".claude", "settings.local.json"),
    );
    if (localGlobs !== null) result.push(localGlobs);

    const sharedGlobs = extractGlobs(
      resolve(projectDir, ".claude", "settings.json"),
    );
    if (sharedGlobs !== null) result.push(sharedGlobs);
  }

  // Keep the global settings file as its own precedence tier.
  const globalPaths = [globalSettingsPath ?? defaultGlobalSettingsPath()];

  for (const globalPath of globalPaths) {
    const globalGlobs = extractGlobs(globalPath);
    if (globalGlobs !== null) result.push(globalGlobs);
  }

  return result;
}

// ==============================================================================
// File Path Evaluation
// ==============================================================================

/**
 * Check if a file path should be denied based on deny globs.
 *
 * Normalizes backslashes to forward slashes before matching so that
 * Windows paths work with Unix-style glob patterns.
 *
 * When `projectRoot` is supplied, the path is also matched in its
 * fully-resolved absolute form **and** — when the file exists — in
 * its canonical form (`fs.realpathSync`). This prevents two classes
 * of bypass:
 *
 *   1. `..` traversal: a relative path like `../../.ssh/id_rsa` no
 *      longer evades absolute-path deny rules.
 *   2. Symlink escape: a project-local path whose realpath points
 *      outside the project (e.g. `safe.log -> ~/.ssh/id_rsa`) no
 *      longer evades absolute-path deny rules.
 *
 * realpath is best-effort: if the file does not exist yet (ENOENT)
 * or the syscall fails for any reason, the lexical resolved form is
 * still checked. This keeps the function usable for paths that will
 * be created during execution.
 */
export function evaluateFilePath(
  filePath: string,
  denyGlobs: string[][],
  caseInsensitive: boolean = process.platform === "win32" || process.platform === "darwin",
  projectRoot?: string,
): { denied: boolean; matchedPattern?: string } {
  const toForward = (path: string): string => path.replace(/\\/g, "/");

  // Match against the raw input, the lexically-resolved absolute path,
  // and the canonical (symlink-resolved) path when the file exists.
  // Deduplicated so absolute inputs and paths that don't cross symlinks
  // don't pay the matching cost multiple times.
  const candidates = new Set<string>();
  candidates.add(toForward(filePath));
  if (projectRoot) {
    const lexical = resolve(projectRoot, filePath);
    candidates.add(toForward(lexical));
    try {
      candidates.add(toForward(realpathSync(lexical)));
    } catch {
      // File does not exist yet, or realpath failed — rely on lexical form.
    }
  }

  for (const globs of denyGlobs) {
    for (const glob of globs) {
      // Normalize the glob's path separators the same way candidates were
      // normalized — otherwise a Windows absolute deny rule like
      // `Read(C:\Users\...\secret.env)` parses with literal backslashes that
      // never match a forward-slash candidate.
      const regex = fileGlobToRegex(toForward(glob), caseInsensitive);
      for (const candidate of candidates) {
        if (regex.test(candidate)) {
          return { denied: true, matchedPattern: glob };
        }
      }
    }
  }

  return { denied: false };
}

// ==============================================================================
// Project-Boundary Containment (Issue #852)
// ==============================================================================

/**
 * Pure, algorithmic (no-regex) test: does `filePath` resolve to a location
 * inside `projectRoot`?
 *
 * Issue #852 — `ctx_execute_file` previously fed its `path` argument straight
 * into `resolve(projectRoot, path)`. Because `path.resolve` lets an *absolute*
 * argument win outright, an agent could read any file on the host
 * (`/home/user/secret`, `/etc/passwd`) regardless of the project root, and
 * `../` traversal escaped just as easily. This guard re-anchors the selected
 * path to the project boundary.
 *
 * Containment is decided on the *resolved* form. When the file (or its parent
 * chain) exists, the symlink-canonical form is ALSO required to stay inside —
 * this closes the symlink-escape class (a project-local `safe.log` whose
 * realpath points at `~/.ssh/id_rsa`), mirroring `evaluateFilePath`.
 *
 * A path equal to the project root itself counts as inside. Comparison is
 * case-insensitive on Windows/macOS to match those filesystems' semantics.
 *
 * Returns `true` when `projectRoot` is falsy (no boundary to enforce) so the
 * caller's fail-open posture is preserved when the root cannot be resolved.
 */
export function isPathInsideProject(
  filePath: string,
  projectRoot: string | undefined,
  caseInsensitive: boolean = process.platform === "win32" || process.platform === "darwin",
): boolean {
  if (!projectRoot) return true;

  const root = resolve(projectRoot);
  const lexical = resolve(projectRoot, filePath);

  const within = (root: string, candidate: string): boolean => {
    let a = root;
    let b = candidate;
    if (caseInsensitive) {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }
    if (a === b) return true;
    // `path.relative` is pure string arithmetic — no regex. A candidate inside
    // the root yields a relative path that neither starts with `..` (escapes
    // upward) nor is absolute (a different drive/root on Windows that cannot be
    // expressed relatively).
    const rel = relative(a, b);
    if (rel === "") return true;
    if (rel === ".." || rel.startsWith(".." + sep)) return false;
    if (isAbsoluteRel(rel)) return false;
    return true;
  };

  // Lexical containment is the primary gate.
  if (!within(root, lexical)) return false;

  // Defense-in-depth: when the path (or a parent) is a symlink that points
  // outside the project, the canonical form must ALSO stay inside. Best-effort
  // — a not-yet-created file (ENOENT) falls back to the lexical decision above.
  try {
    const canonicalRoot = realpathSync(root);
    const canonical = realpathSync(lexical);
    if (!within(canonicalRoot, canonical)) return false;
  } catch {
    /* file does not exist yet / realpath failed — lexical decision stands */
  }

  return true;
}

/** Pure helper: is a `path.relative` result an absolute path? (no regex) */
function isAbsoluteRel(rel: string): boolean {
  if (rel.startsWith("/")) return true; // POSIX absolute
  // Windows drive-absolute: "C:\..." or "C:/..."
  if (rel.length >= 3 && rel[1] === ":" && (rel[2] === "\\" || rel[2] === "/")) {
    const c = rel.charCodeAt(0);
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  }
  return false;
}

/**
 * Decide whether `filePath` may be processed, given the project boundary AND
 * the user's existing host `Read(...)` allow rules.
 *
 * Decision order:
 *   1. Inside the project root  → allowed (the common case; no config needed).
 *   2. Outside the project, but matching a `permissions.allow` `Read(...)` glob
 *      the user already configured for the host → allowed. This is the
 *      principled escape hatch: a deliberate out-of-project read is expressed
 *      ONCE in the host config the user already maintains, reusing the same
 *      host Read allow rules already used for path access.
 *   3. Outside the project, no allow match → denied (closes the #852 escape).
 *
 * `allowGlobs` has the same per-settings-file shape as the deny globs returned
 * by `readToolPermissionPatterns(toolName, "allow", …)`. Allow-matching reuses
 * `evaluateFilePath` so absolute/`..`/symlink-canonical candidate resolution is
 * identical to the deny path — one matcher, no divergence.
 *
 * Fail-open on an unknown project root (boundary cannot be computed) so the
 * guard never blocks legitimate in-project work when resolution fails.
 */
export function evaluateProjectContainment(
  filePath: string,
  projectRoot: string | undefined,
  allowGlobs: string[][] = [],
  caseInsensitive: boolean = process.platform === "win32" || process.platform === "darwin",
): { allowed: boolean; reason: "inside" | "allow-rule" | "outside" } {
  if (isPathInsideProject(filePath, projectRoot, caseInsensitive)) {
    return { allowed: true, reason: "inside" };
  }
  // Outside the project — permit only if the user explicitly allowed this path
  // for the host Read tool. `evaluateFilePath` returns `denied:true` when a glob
  // MATCHES, so a match here means "explicitly allowed".
  if (allowGlobs.some((g) => g.length > 0)) {
    const matched = evaluateFilePath(filePath, allowGlobs, caseInsensitive, projectRoot);
    if (matched.denied) return { allowed: true, reason: "allow-rule" };
  }
  return { allowed: false, reason: "outside" };
}
