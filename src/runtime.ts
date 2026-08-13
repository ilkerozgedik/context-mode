import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

export type Language = "javascript" | "python" | "shell";

export interface RuntimeMap {
  javascript: string;
  python: string | null;
  shell: string;
}

const ALLOWED_SHELL_BASENAMES = /^(bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/i;
const isWindows = process.platform === "win32";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isAllowlistedShell(shellPath: string): boolean {
  return ALLOWED_SHELL_BASENAMES.test(basename(shellPath));
}

function commandExists(command: string): boolean {
  try {
    execSync(isWindows ? `where ${command}` : `command -v ${command}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runnablePython(command: string): boolean {
  if (!commandExists(command)) return false;
  try {
    if (isWindows) execSync(`"${command}" --version`, { stdio: "pipe", timeout: 5000 });
    else execFileSync(command, ["--version"], { stdio: "pipe", timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

function resolveShell(): string {
  const configured = process.env.SHELL;
  if (configured && existsSync(configured) && isAllowlistedShell(configured)) return configured;
  if (!isWindows) return commandExists("bash") ? "bash" : "sh";
  for (const shell of ["bash", "pwsh", "powershell", "cmd.exe"]) {
    if (commandExists(shell)) return shell;
  }
  return "cmd.exe";
}

export function detectRuntimes(): RuntimeMap {
  return {
    javascript: process.execPath,
    python: runnablePython("python3") ? "python3" : runnablePython("python") ? "python" : runnablePython("py") ? "py" : null,
    shell: resolveShell(),
  };
}

function version(command: string): string {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 })
      .trim().split(/\r?\n/)[0] || "unknown";
  } catch {
    return "unknown";
  }
}

export function getRuntimeSummary(runtimes: RuntimeMap): string {
  return [
    `  JavaScript: ${runtimes.javascript} (${version(runtimes.javascript)})`,
    `  Python:     ${runtimes.python ? `${runtimes.python} (${version(runtimes.python)})` : "not available"}`,
    `  Shell:      ${runtimes.shell} (${version(runtimes.shell)})`,
  ].join("\n");
}

export function getAvailableLanguages(runtimes: RuntimeMap): Language[] {
  return runtimes.python ? ["javascript", "shell", "python"] : ["javascript", "shell"];
}

export function buildCommand(runtimes: RuntimeMap, language: Language, filePath: string): string[] {
  if (language === "javascript") return [runtimes.javascript, filePath];
  if (language === "python") {
    if (!runtimes.python) throw new Error("No Python runtime available. Install python3 or python.");
    return [runtimes.python, filePath];
  }

  if (isWindows) {
    const shell = runtimes.shell.toLowerCase();
    if (shell.includes("bash") || shell.endsWith("/sh") || shell.endsWith("\\sh.exe")) {
      const escaped = filePath.replace(/'/g, "'\\''");
      return [runtimes.shell, "-c", `source '${escaped}'`];
    }
    if (shell.includes("powershell") || shell.includes("pwsh")) {
      return [runtimes.shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath];
    }
    if (basename(shell) === "cmd" || basename(shell) === "cmd.exe") {
      return [runtimes.shell, "/d", "/s", "/c", filePath];
    }
  }
  return [runtimes.shell, filePath];
}
