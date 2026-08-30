import { runPool, type PoolJob } from "./runPool.js";

export interface BatchCommand { label: string; command: string; }

export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}

export interface BatchRunOptions {
  /** Total budget (serial) or per-command budget (parallel). */
  timeout: number | undefined;
  concurrency: number;
  nodeOptsPrefix: string;
  cwd?: string;
  onFsBytes?: (bytes: number) => void;
  signal?: AbortSignal;
}

interface BatchExecutor {
  execute(input: {
    language: "shell";
    code: string;
    timeout: number | undefined;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; stderr?: string; timedOut?: boolean; timeoutMs?: number }>;
}

function readPositiveEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function getBatchConcurrencyLimit(): number {
  return Math.min(8, Math.floor(readPositiveEnv("CONTEXT_MODE_MAX_BATCH_CONCURRENCY", 8)));
}

export function resolveConfiguredConcurrency(requested: number): number {
  return Math.min(Math.max(1, Math.floor(requested)), getBatchConcurrencyLimit());
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildBatchNodeOptionsPrefix(shellPath: string, preloadPath: string): string {
  const option = `--require ${preloadPath}`;
  const shell = shellPath.toLowerCase();
  const base = shell.split(/[\\/]/).pop() ?? shell;
  if (shell.includes("powershell") || shell.includes("pwsh")) {
    return `$env:NODE_OPTIONS=${quotePowerShellSingle(option)}; `;
  }
  if (base === "cmd" || base === "cmd.exe") {
    return `set "NODE_OPTIONS=${option.replace(/"/g, '""')}" && `;
  }
  return `export NODE_OPTIONS=${quotePosixSingle(option)}; `;
}

const COMMAND_ECHO_MAX = 500;
const CODE_ECHO_MAX = 2000;

export function truncateCommandForEcho(command: string): string {
  const cleaned = command.replace(/\s+/g, " ").trim();
  return cleaned.length <= COMMAND_ECHO_MAX ? cleaned : cleaned.slice(0, COMMAND_ECHO_MAX) + "…";
}

function truncateCodeForEcho(code: string): string {
  return code.length <= CODE_ECHO_MAX ? code : code.slice(0, CODE_ECHO_MAX) + "\n… (truncated)";
}

export function buildExecuteEcho(language: string, code: string, path?: string): string {
  const header = path ? `path=${path}\n` : "";
  return `${header}\`\`\`${language}\n${truncateCodeForEcho(code)}\n\`\`\`\n\n`;
}

function formatCommandOutput(label: string, command: string, raw: string, onFsBytes?: (bytes: number) => void): string {
  let output = raw || "(no output)";
  let cmdFsBytes = 0;
  for (const match of output.matchAll(/__CM_FS__:(\d+)/g)) cmdFsBytes += parseInt(match[1]);
  if (cmdFsBytes > 0) {
    onFsBytes?.(cmdFsBytes);
    output = output.replace(/__CM_FS__:\d+\n?/g, "");
  }
  return `# ${label}\n\n$ ${truncateCommandForEcho(command)}\n\n${output}\n`;
}

function combineExecOutput(result: { stdout?: string; stderr?: string }): string {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

export async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, cwd, onFsBytes, signal } = opts;
  const effectiveConcurrency = resolveConfiguredConcurrency(concurrency);
  if (effectiveConcurrency <= 1) {
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const remaining = timeout - (Date.now() - startTime);
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell", code: `${nodeOptsPrefix}${cmd.command}`, timeout: perCmdTimeout, cwd, signal,
      });
      outputs.push(formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell", code: `${nodeOptsPrefix}${cmd.command}`, timeout, cwd, signal,
      });
      const formatted = formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes);
      const output = result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${result.timeoutMs ?? timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));
  const { settled } = await runPool(jobs, { concurrency: effectiveConcurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      outputs[i] = result.value.output;
      if (result.value.timedOut) timedOut = true;
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}
