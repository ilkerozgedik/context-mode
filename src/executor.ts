import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRuntimes,
  buildCommand,
  type RuntimeMap,
  type Language,
} from "./runtime.js";
export type { ExecResult } from "./types.js";
import type { ExecResult } from "./types.js";

const isWin = process.platform === "win32";

/**
 * Pure helper: extension map for temp script files per language.
 * On Windows, shell scripts usually get NO extension to avoid Windows
 * file-association for `.sh` (which spawns a visible Git Bash window over the
 * user's IDE). Windows PowerShell/pwsh is the exception because `-File`
 * requires `.ps1` there.
 */
const SCRIPT_EXT: Record<Language, string> = {
  javascript: "js",
  python: "py",
  shell: "sh",
};

/** Pure helper — exported for unit testing. Returns "script" or "script.<ext>". */
export function buildScriptFilename(
  language: Language,
  platform: NodeJS.Platform,
  shellPath?: string | null,
): string {
  if (platform === "win32" && language === "shell") {
    const shellName = shellPath?.toLowerCase() ?? "";
    if (shellName.includes("powershell") || shellName.includes("pwsh")) return "script.ps1";
    const shellBase = shellName.split(/[\\/]/).pop() ?? shellName;
    if (shellBase === "cmd" || shellBase === "cmd.exe") return "script.cmd";
    return "script";
  }
  return `script.${SCRIPT_EXT[language]}`;
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Pure helper — exported for unit testing. Restores parent PATH after shell startup. */
export function buildShellScriptContent(
  code: string,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32" || !inheritedPath) return code;
  return `export PATH=${quoteForPosixShell(inheritedPath)}\n${code}`;
}

function isPowerShell(shellPath: string | null | undefined): boolean {
  const shellName = shellPath?.toLowerCase() ?? "";
  return shellName.includes("powershell") || shellName.includes("pwsh");
}

export function buildPowerShellScriptContent(code: string): string {
  // Prefix a UTF-8 BOM so Windows PowerShell 5.1 reliably detects the script
  // file as UTF-8 (without it, 5.1 falls back to the ANSI code page and
  // mangles non-ASCII characters in the script body).
  return [
    "\uFEFF[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    code,
  ].join("\n");
}

/**
 * Resolve the real OS temp directory, bypassing any TMPDIR env override.
 * os.tmpdir() reads TMPDIR from the environment, which some shells/tools
 * set to the project root — causing temp files to pollute the working tree.
 */
const OS_TMPDIR = (() => {
  if (isWin) return process.env.TEMP ?? process.env.TMP ?? tmpdir();
  try {
    const result = execFileSync(
      process.platform === "darwin" ? "getconf" : "mktemp",
      process.platform === "darwin" ? ["DARWIN_USER_TEMP_DIR"] : ["-u", "-d"],
      { env: { ...process.env, TMPDIR: undefined as unknown as string }, encoding: "utf-8" },
    ).trim();
    const dir = process.platform === "darwin" ? result : resolve(result, "..");
    if (dir && dir !== process.cwd()) return dir;
  } catch { /* fall through */ }
  return "/tmp";
})();

/**
 * Pure helper — exported for unit testing. Issue #782.
 *
 * On Windows, the sandbox shell runtime is Git Bash. A bare `mvn` invocation
 * runs Maven's POSIX shell script, which on the `mingw=true` branch (uname →
 * MINGW64_NT-*) fails to convert `CLASSWORLDS_JAR` from a POSIX path
 * (`/c/tools/maven/boot/plexus-classworlds-*.jar`) to a Windows path. Native
 * `java.exe` then can't resolve the bootstrap jar → ClassNotFoundException for
 * `org.codehaus.plexus.classworlds.launcher.Launcher`.
 *
 * The third-way fix (issue Option C): rewrite the bare `mvn` token to `mvn.cmd`,
 * the native Windows launcher that uses Windows-native paths and bypasses the
 * broken mingw shell branch entirely. This does NOT touch the global MSYS
 * path-conversion env (MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL), which #826/#791
 * deliberately leave unset so native git.exe launched from bash keeps its
 * /tmp→C:\ argument conversion. Re-enabling global suppression would re-break
 * native git; rewriting only the mvn token keeps both correct.
 *
 * Only a `mvn` that starts a command (start of string, or after a shell
 * separator `&& | ; ( newline`) is rewritten. `mvnw`, `mvnd`, `mymvn`,
 * paths like `./mvnw`, and an already-`mvn.cmd` token are left untouched
 * (the token must be exactly `mvn` followed by whitespace or end-of-string).
 */
export function rewriteWindowsBuildTools(
  code: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") return code;
  // Rewrite a bare `mvn` command token to `mvn.cmd` (Maven's native Windows launcher).
  // Algorithmic (no regex): only at a command-start position (string start or right
  // after a shell separator ; & | ( newline, skipping leading spaces/tabs) and only
  // when the token is exactly `mvn` followed by whitespace or end — leaves
  // mvnw / mvnd / ./mvnw / already-mvn.cmd untouched.
  const SEP = new Set([";", "&", "|", "(", "\n"]);
  let out = "";
  let atStart = true;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (atStart && (ch === " " || ch === "\t")) {
      out += ch;
      i++;
      continue;
    }
    if (atStart && code.startsWith("mvn", i)) {
      const after = code[i + 3];
      if (after === undefined || after === " " || after === "\t" || after === "\n") {
        out += "mvn.cmd";
        i += 3;
        atStart = false;
        continue;
      }
    }
    out += ch;
    atStart = SEP.has(ch);
    i++;
  }
  return out;
}

/**
 * Remove a sandbox temp dir, retrying on Windows. Issue #788.
 *
 * On Windows, a child process that opened SQLite databases inside the sandbox
 * can leave `*-wal` / `*-shm` files with handles that linger briefly after the
 * process exits. A single `rmSync` then throws EBUSY/EPERM/ENOTEMPTY and the
 * old silent `catch {}` swallowed it, leaking `.ctx-mode-*` directories under
 * `%TEMP%`. Node's `rmSync({ maxRetries, retryDelay })` is purpose-built for
 * exactly this Windows-handle race, so let it back off and retry.
 */
function cleanupTmpDir(tmpDir: string): void {
  try {
    rmSync(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: isWin ? 8 : 2,
      retryDelay: 100,
    });
  } catch {
    /* best-effort — OS will reclaim %TEMP% eventually */
  }
}

/** Kill process tree — on Windows uses taskkill /T; on Unix kills the process group. */
function killTree(proc: ReturnType<typeof spawn>): void {
  if (isWin && proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "pipe" });
    } catch { /* already dead */ }
  } else if (proc.pid) {
    try {
      // Kill entire process group (negative PID) to prevent orphaned children
      process.kill(-proc.pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}

interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
  /** Keep process running after timeout instead of killing it. */
  background?: boolean;
  /**
   * Issue #45 — per-call cwd override for the shell language. When set,
   * the shell script runs in this directory instead of `#projectRoot`.
   * Non-shell languages keep their tmpDir sandbox cwd regardless (the
   * script file lives there). Used by Codex MCP handlers to pin shell
   * commands to a resolved project root when the spawning host inherited
   * a non-project cwd (e.g. $HOME).
   */
  cwd?: string;
}

interface ExecuteFileOptions extends ExecuteOptions {
  path: string;
}

export class PolyglotExecutor {
  #hardCapBytes: number;
  /**
   * Resolves the project root on every access. Stored as a thunk so the
   * executor stays in sync with server-side env-cascade resolvers (e.g.
   * `getProjectDir` in server.ts) instead of capturing a snapshot of
   * `CLAUDE_PROJECT_DIR` at construction time. String inputs are wrapped
   * to preserve constructor backward compatibility.
   */
  #projectRootResolver: () => string;
  #runtimes: RuntimeMap;

  /** PIDs of backgrounded processes — killed on cleanup to prevent zombies. */
  #backgroundedPids = new Set<number>();

  constructor(opts?: {
    hardCapBytes?: number;
    projectRoot?: string | (() => string);
    runtimes?: RuntimeMap;
  }) {
    this.#hardCapBytes = opts?.hardCapBytes ?? 8 * 1024 * 1024; // 8MB
    const pr = opts?.projectRoot;
    if (typeof pr === "function") {
      this.#projectRootResolver = pr;
    } else if (typeof pr === "string") {
      this.#projectRootResolver = () => pr;
    } else {
      this.#projectRootResolver = () => process.cwd();
    }
    this.#runtimes = opts?.runtimes ?? detectRuntimes();
  }

  get #projectRoot(): string {
    return this.#projectRootResolver();
  }

  get runtimes(): RuntimeMap {
    return { ...this.#runtimes };
  }

  /** Kill all backgrounded processes to prevent zombie/port-conflict issues. */
  cleanupBackgrounded(): void {
    for (const pid of this.#backgroundedPids) {
      try {
        // Kill process group on Unix to catch all children
        process.kill(isWin ? pid : -pid, "SIGTERM");
      } catch { /* already dead */ }
    }
    this.#backgroundedPids.clear();
  }

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout, background = false, cwd: cwdOverride } = opts;
    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".ctx-mode-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);

      // Every language runs in the project directory so git, relative paths,
      // and other project-aware tools resolve naturally. The script FILE lives
      // in the sandbox tmpDir and is passed to the runtime by absolute path
      // (see buildCommand), so cwd is free to be the project root.
      //
      // Issue #788 — previously only `shell` used the project root; non-shell
      // runtimes (python/js/ts/…) used tmpDir, so repo-relative checks like
      // `pathlib.Path("package.json").exists()` silently failed depending on
      // the chosen language. Unifying cwd removes that surprise.
      // Issue #45 — `cwdOverride` lets per-call sites (Codex MCP handlers) pin
      // cwd without mutating process-wide state.
      const cwd = cwdOverride ?? this.#projectRoot;
      const result = await this.#spawn(cmd, cwd, tmpDir, timeout, background);

      // Skip tmpDir cleanup if process was backgrounded — it may still need files
      if (!result.backgrounded) {
        cleanupTmpDir(tmpDir);
      }

      return result;
    } catch (err) {
      cleanupTmpDir(tmpDir);
      throw err;
    }
  }

  async executeFile(opts: ExecuteFileOptions): Promise<ExecResult> {
    const { path: filePath, language, code, timeout } = opts;
    const absolutePath = resolve(this.#projectRoot, filePath);
    const wrappedCode = this.#wrapWithFileContent(
      absolutePath,
      language,
      code,
    );
    return this.execute({ language, code: wrappedCode, timeout });
  }

  #writeScript(tmpDir: string, code: string, language: Language): string {
    const fp = join(
      tmpDir,
      buildScriptFilename(
        language,
        process.platform,
        language === "shell" ? this.#runtimes.shell : null,
      ),
    );
    if (language === "shell") {
      const shellPath = this.#runtimes.shell;
      const rewritten = rewriteWindowsBuildTools(code, process.platform);
      const shellCode = isWin && isPowerShell(shellPath)
        ? buildPowerShellScriptContent(rewritten)
        : rewritten;
      writeFileSync(
        fp,
        buildShellScriptContent(shellCode, process.env.PATH, process.platform),
        { encoding: "utf-8", mode: 0o700 },
      );
    } else {
      writeFileSync(fp, code, "utf-8");
    }
    return fp;
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    sandboxTmpDir: string,
    timeout: number | undefined,
    background = false,
  ): Promise<ExecResult> {
    return new Promise((res) => {
      const spawnCmd = cmd[0];
      const spawnArgs = isWin
        ? cmd.slice(1).map((arg) => arg.replace(/\\/g, "/"))
        : cmd.slice(1);
      const proc = spawn(spawnCmd, spawnArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(sandboxTmpDir),
        detached: !isWin,
        windowsHide: process.platform === "win32",
        shell: false,
      });

      let timedOut = false;
      let resolved = false;
      // Issue #406 — if the caller didn't pass a timeout we don't fire one.
      // Timeout policy belongs to the MCP host/client (Claude Code, VSCode,
      // JetBrains all enforce their own RPC timeouts); imposing a second
      // policy here turned 30-minute Gradle/Maven/SBT builds into spurious
      // false negatives whenever the caller forgot the explicit value.
      const timer: NodeJS.Timeout | undefined = timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        if (background) {
          // Background mode: detach process, return partial output, keep running
          resolved = true;
          if (proc.pid) this.#backgroundedPids.add(proc.pid);
          proc.unref();
          // Do NOT destroy stdout/stderr — closing the read end of the pipe
          // sends SIGPIPE to the child on its next write, killing it.
          // Instead, replace the data listeners with no-op drains that
          // consume the stream without accumulating buffers. This keeps
          // the pipe open and prevents the child from blocking on a full
          // pipe buffer.
          if (proc.stdout) {
            proc.stdout.removeAllListeners("data");
            proc.stdout.on("data", () => {});
          }
          if (proc.stderr) {
            proc.stderr.removeAllListeners("data");
            proc.stderr.on("data", () => {});
          }
          const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
          let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
          if (capExceeded) {
            rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB — excess output discarded]`;
          }
          res({
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: 0,
            timedOut: true,
            backgrounded: true,
          });
        } else {
          killTree(proc);
        }
      }, timeout);

      // Stream-level capture cap: retain at most hardCapBytes across stdout+stderr
      // while continuing to drain excess output so verbose commands can finish.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let capturedBytes = 0;
      let capExceeded = false;

      const capture = (chunks: Buffer[], chunk: Buffer) => {
        const remaining = this.#hardCapBytes - capturedBytes;
        if (remaining > 0) {
          const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
          chunks.push(kept);
          capturedBytes += kept.length;
        }
        if (chunk.length > remaining) capExceeded = true;
      };

      proc.stdout!.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
      proc.stderr!.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        if (resolved) return; // Already resolved by background timeout
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (capExceeded) {
          rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB — excess output discarded]`;
        }

        const stdout = rawStdout;
        const stderr = rawStderr;

        res({
          stdout,
          stderr,
          exitCode: timedOut ? 1 : (exitCode ?? 1),
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (resolved) return; // Already resolved by background timeout
        res({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
        });
      });
    });
  }

  #buildSafeEnv(tmpDir: string): Record<string, string> {
    const realHome = process.env.HOME ?? process.env.USERPROFILE ?? tmpDir;

    // Denylist: env vars that corrupt sandbox stdout, inject code, or break
    // language runtimes. Each entry is backed by CVE, MITRE, or live testing.
    // See: https://www.elttam.com/blog/env/, MITRE T1574.006
    const DENIED = new Set([
      // Shell — auto-execute scripts, override builtins
      "BASH_ENV",             // sourced by non-interactive bash
      "ENV",                  // sourced by sh/dash
      "PROMPT_COMMAND",       // runs before each prompt
      "PS4",                  // $(cmd) expansion in xtrace
      "SHELLOPTS",            // enables xtrace/verbose, dumps to stdout
      "BASHOPTS",             // bash-specific shell options
      "CDPATH",               // makes cd print to stdout
      "INPUTRC",              // readline key rebinding
      "BASH_XTRACEFD",        // redirects debug output to stdout
      // Node.js — require injection, inspector
      "NODE_OPTIONS",         // --require, --loader, --inspect
      "NODE_PATH",            // module search path injection
      // Python — stdlib override, startup injection
      "PYTHONSTARTUP",        // auto-executes in interactive mode
      "PYTHONHOME",           // overrides stdlib location (breaks Python)
      "PYTHONWARNINGS",       // triggers module import chain → RCE
      "PYTHONBREAKPOINT",     // arbitrary callable
      "PYTHONINSPECT",        // enters interactive mode after script
      // Dynamic linker — shared library injection
      "LD_PRELOAD",           // loads .so before all others (Linux)
      "DYLD_INSERT_LIBRARIES", // macOS equivalent of LD_PRELOAD
      // OpenSSL — engine loading
      "OPENSSL_CONF",         // loads engine modules → .so exec
      "OPENSSL_ENGINES",      // engine directory override
      // Compiler — binary substitution
      "CC",                   // C compiler override
      "CXX",                  // C++ compiler override
      "AR",                   // archiver override
      // Git — command injection via hooks/config
      "GIT_TEMPLATE_DIR",     // hook injection on git init
      "GIT_CONFIG_GLOBAL",    // core.pager/editor runs commands
      "GIT_CONFIG_SYSTEM",    // system-level config injection
      "GIT_EXEC_PATH",        // substitute git subcommands
      "GIT_SSH",              // arbitrary command instead of ssh
      "GIT_SSH_COMMAND",      // arbitrary ssh command
      "GIT_ASKPASS",          // arbitrary credential command
    ]);

    // Start with parent env, then strip dangerous vars and apply overrides.
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (
        val !== undefined &&
        !DENIED.has(key) &&
        !key.startsWith("BASH_FUNC_")
      ) {
        env[key] = val;
      }
    }

    // Sandbox overrides — forced values for correct sandbox behavior
    env["TMPDIR"] = tmpDir;
    env["HOME"] = realHome;
    env["LANG"] = "en_US.UTF-8";
    env["PYTHONDONTWRITEBYTECODE"] = "1";
    env["PYTHONUNBUFFERED"] = "1";
    env["PYTHONUTF8"] = "1";
    env["NO_COLOR"] = "1";
    // Windows uses "Path" (not "PATH") — normalize to "PATH" for consistency
    if (isWin && !env["PATH"] && env["Path"]) {
      env["PATH"] = env["Path"];
      delete env["Path"];
    }
    if (!env["PATH"]) {
      env["PATH"] = isWin ? "" : "/usr/local/bin:/usr/bin:/bin";
    }

    // Windows-critical PATH fixes.
    if (isWin) {
      // Do not carry global MSYS path-conversion blockers into Git Bash.
      // Native Windows tools launched from bash (notably git.exe) need MSYS
      // to convert /tmp-style arguments to Windows paths so sibling tools see
      // the same filesystem location (#791).
      for (const key of Object.keys(env)) {
        const upper = key.toUpperCase();
        if (upper === "MSYS_NO_PATHCONV" || upper === "MSYS2_ARG_CONV_EXCL") {
          delete env[key];
        }
      }

      const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
      const gitBin = "C:\\Program Files\\Git\\bin";
      if (!env["PATH"].includes(gitUsrBin)) {
        env["PATH"] = `${gitUsrBin};${gitBin};${env["PATH"]}`;
      }
    }

    // Ensure SSL_CERT_FILE is set so Python HTTPS works in sandbox.
    if (!env["SSL_CERT_FILE"]) {
      const certPaths = isWin ? [] : [
        "/etc/ssl/cert.pem",                         // macOS, some Linux
        "/etc/ssl/certs/ca-certificates.crt",         // Debian/Ubuntu/Alpine
        "/etc/pki/tls/certs/ca-bundle.crt",           // RHEL/CentOS/Fedora
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // Fedora alt
      ];
      for (const p of certPaths) {
        if (existsSync(p)) {
          env["SSL_CERT_FILE"] = p;
          break;
        }
      }
    }

    return env;
  }

  #wrapWithFileContent(
    absolutePath: string,
    language: Language,
    code: string,
  ): string {
    const escaped = JSON.stringify(absolutePath);
    if (language === "javascript") {
      return `const FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
    }
    if (language === "python") {
      return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
    }
    const sq = "'" + absolutePath.replace(/'/g, "'\\''") + "'";
    return `FILE_CONTENT_PATH=${sq}\nfile_path=${sq}\nFILE_CONTENT=$(cat ${sq})\n${code}`;
  }
}
