import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface JobCompletion {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
}

export interface JobHandle {
  done: Promise<JobCompletion>;
  snapshot?(): Pick<JobCompletion, "stdoutTail" | "stderrTail">;
  cancel(): Promise<void>;
}

export interface JobRunner {
  reconcile?(): void;
  hasActiveJobs?(): boolean;
  start(opts: { unit: string; cwd: string; command: string }): JobHandle;
}

export interface JobArtifact {
  path: string;
  size: number;
  mtime: string;
}

export interface JobReceipt {
  job_id: string;
  status: JobStatus;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  termination_reason: string | null;
  stdout_tail: string;
  stderr_tail: string;
  artifacts: JobArtifact[];
}

interface JobRecord {
  id: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  terminationReason: string | null;
  stdoutTail: string;
  stderrTail: string;
  expectedArtifacts: string[];
  handle: JobHandle;
  done: Promise<void>;
  cancelRequested: boolean;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function systemdUserEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    throw new Error("async jobs require Linux systemd user services");
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`;
  if (!existsSync(`${runtimeDir}/bus`)) {
    throw new Error(`systemd user bus is unavailable at ${runtimeDir}/bus`);
  }
  return { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: bus };
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (chunk.length >= maxBytes) return chunk.subarray(chunk.length - maxBytes);
  if (current.length + chunk.length <= maxBytes) return Buffer.concat([current, chunk]);
  const keep = maxBytes - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

export interface SystemdRunOptions {
  unit: string;
  cwd: string;
  command: string;
  memoryHighMb: number;
  memoryMaxMb: number;
  memorySwapMaxMb: number;
  tasksMax: number;
  cpuQuotaPercent: number;
  runtimeMaxSec: number;
  path: string;
  home: string;
}

export function buildSystemdRunArgs(opts: SystemdRunOptions): string[] {
  return [
    "--user",
    `--unit=${opts.unit}`,
    "--collect",
    "--pipe",
    "--wait",
    "--service-type=exec",
    "--quiet",
    `--working-directory=${opts.cwd}`,
    `--property=MemoryHigh=${opts.memoryHighMb}M`,
    `--property=MemoryMax=${opts.memoryMaxMb}M`,
    `--property=MemorySwapMax=${opts.memorySwapMaxMb}M`,
    `--property=TasksMax=${opts.tasksMax}`,
    `--property=CPUQuota=${opts.cpuQuotaPercent}%`,
    `--property=RuntimeMaxSec=${opts.runtimeMaxSec}s`,
    "--property=OOMPolicy=stop",
    "--property=NoNewPrivileges=yes",
    "--property=UMask=0077",
    `--setenv=PATH=${opts.path}`,
    `--setenv=HOME=${opts.home}`,
    "--setenv=LANG=en_US.UTF-8",
    "--setenv=NO_COLOR=1",
    "/bin/bash",
    "-c",
    opts.command,
  ];
}

export class SystemdJobRunner implements JobRunner {
  readonly #memoryHighMb = positiveInt(process.env.CONTEXT_MODE_JOB_MEMORY_HIGH_MB, 2048);
  readonly #memoryMaxMb = positiveInt(process.env.CONTEXT_MODE_JOB_MEMORY_MAX_MB, 2304);
  readonly #memorySwapMaxMb = positiveInt(process.env.CONTEXT_MODE_JOB_MEMORY_SWAP_MAX_MB, 256);
  readonly #tasksMax = positiveInt(process.env.CONTEXT_MODE_JOB_TASKS_MAX, 128);
  readonly #cpuQuotaPercent = positiveInt(process.env.CONTEXT_MODE_JOB_CPU_QUOTA_PERCENT, 200);
  readonly #runtimeMaxSec = positiveInt(process.env.CONTEXT_MODE_JOB_RUNTIME_MAX_SEC, 3600);
  readonly #tailBytes = positiveInt(process.env.CONTEXT_MODE_JOB_LOG_TAIL_BYTES, 64 * 1024);

  reconcile(): void {
    for (const unit of this.#listJobUnits()) {
      const match = unit.match(/^context-mode-job-(\d+)-[0-9a-f]+\.service$/);
      const ownerPid = match ? Number(match[1]) : null;
      if (ownerPid !== null && this.#processExists(ownerPid)) continue;
      this.#stopUnit(unit);
      console.error(`[context-mode] reconciled stale job unit=${unit}`);
    }
  }

  hasActiveJobs(): boolean {
    return this.#listJobUnits().length > 0;
  }

  #listJobUnits(): string[] {
    if (process.platform !== "linux" || !existsSync("/usr/bin/systemctl")) return [];
    try {
      const output = execFileSync(
        "/usr/bin/systemctl",
        ["--user", "list-units", "--all", "--plain", "--no-legend", "context-mode-job-*.service"],
        { env: systemdUserEnv(), encoding: "utf8", timeout: 10_000 },
      );
      return output.split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => ["active", "activating", "deactivating"].includes(parts[2] ?? ""))
        .map((parts) => parts[0])
        .filter((unit) => unit?.startsWith("context-mode-job-") && unit.endsWith(".service"));
    } catch {
      return [];
    }
  }

  #processExists(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  #stopUnit(unit: string): void {
    try {
      execFileSync("/usr/bin/systemctl", ["--user", "stop", unit], {
        env: systemdUserEnv(), stdio: "ignore", timeout: 10_000,
      });
    } catch { /* best effort; runtime cap remains the final guard */ }
  }

  start(opts: { unit: string; cwd: string; command: string }): JobHandle {
    if (!existsSync("/usr/bin/systemd-run") || !existsSync("/usr/bin/systemctl")) {
      throw new Error("async jobs require /usr/bin/systemd-run and /usr/bin/systemctl");
    }
    const env = systemdUserEnv();
    const args = buildSystemdRunArgs({
      ...opts,
      memoryHighMb: this.#memoryHighMb,
      memoryMaxMb: this.#memoryMaxMb,
      memorySwapMaxMb: this.#memorySwapMaxMb,
      tasksMax: this.#tasksMax,
      cpuQuotaPercent: this.#cpuQuotaPercent,
      runtimeMaxSec: this.#runtimeMaxSec,
      path: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      home: process.env.HOME || "/tmp",
    });
    const proc = spawn("/usr/bin/systemd-run", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    proc.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk, this.#tailBytes); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk, this.#tailBytes); });

    const done = new Promise<JobCompletion>((resolveDone) => {
      proc.once("error", (error) => {
        resolveDone({ exitCode: null, stdoutTail: stdout.toString("utf8"), stderrTail: `${stderr.toString("utf8")}${error.message}` });
      });
      proc.once("close", (exitCode, signal) => {
        resolveDone({
          exitCode,
          signal,
          stdoutTail: stdout.toString("utf8"),
          stderrTail: stderr.toString("utf8"),
        });
      });
    });

    return {
      done,
      snapshot: () => ({ stdoutTail: stdout.toString("utf8"), stderrTail: stderr.toString("utf8") }),
      cancel: async () => {
        try {
          execFileSync("/usr/bin/systemctl", ["--user", "stop", `${opts.unit}.service`], {
            env,
            stdio: "ignore",
            timeout: 10_000,
          });
        } catch {
          killClient(proc);
        }
      },
    };
  }
}

function killClient(proc: ChildProcess): void {
  if (!proc.pid) return;
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
}

export class JobManager {
  readonly #runner: JobRunner;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #maxCompleted: number;
  readonly #ttlMs: number;
  #activeId: string | null = null;

  constructor(opts?: { runner?: JobRunner; maxCompleted?: number; ttlMs?: number }) {
    this.#runner = opts?.runner ?? new SystemdJobRunner();
    this.#maxCompleted = opts?.maxCompleted ?? 32;
    this.#ttlMs = opts?.ttlMs ?? 60 * 60 * 1000;
    this.#runner.reconcile?.();
  }

  isActive(): boolean {
    return this.#activeId !== null;
  }

  start(opts: { command: string; cwd: string; expectedArtifacts?: string[] }): { jobId: string; done: Promise<void> } {
    this.#prune();
    if (!this.#activeId) this.#runner.reconcile?.();
    if (this.#activeId || this.#runner.hasActiveJobs?.()) {
      console.error(`[context-mode] job busy active=${this.#activeId}`);
      throw new Error("busy: another async job is running");
    }
    const cwd = resolve(opts.cwd);
    const cwdStat = statSync(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`job cwd is not a directory: ${cwd}`);
    const expectedArtifacts = (opts.expectedArtifacts ?? []).map((path) => this.#resolveArtifact(cwd, path));
    const id = randomUUID();
    const unit = `context-mode-job-${process.pid}-${id.replace(/-/g, "")}`;
    const handle = this.#runner.start({ unit, cwd, command: opts.command });
    const record: JobRecord = {
      id,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      terminationReason: null,
      stdoutTail: "",
      stderrTail: "",
      expectedArtifacts,
      handle,
      done: Promise.resolve(),
      cancelRequested: false,
    };
    this.#activeId = id;
    this.#jobs.set(id, record);
    console.error(`[context-mode] job started id=${id} unit=${unit}`);
    record.done = handle.done.then((completion) => {
      record.exitCode = completion.exitCode;
      record.stdoutTail = completion.stdoutTail;
      record.stderrTail = completion.stderrTail;
      record.finishedAt = new Date().toISOString();
      if (record.cancelRequested) {
        record.status = "cancelled";
        record.terminationReason = "cancelled";
      } else if (completion.exitCode === 0) {
        record.status = "succeeded";
        record.terminationReason = "exit:0";
      } else {
        record.status = "failed";
        record.terminationReason = completion.signal ? `signal:${completion.signal}` : `exit:${completion.exitCode ?? "unknown"}`;
      }
      if (this.#activeId === id) this.#activeId = null;
      console.error(`[context-mode] job finished id=${id} status=${record.status} reason=${record.terminationReason}`);
      this.#prune();
    });
    return { jobId: id, done: record.done };
  }

  status(jobId: string): JobReceipt {
    this.#prune();
    const record = this.#jobs.get(jobId);
    if (!record) throw new Error(`unknown job_id: ${jobId}`);
    return this.#receipt(record);
  }

  async cancel(jobId: string): Promise<JobReceipt> {
    const record = this.#jobs.get(jobId);
    if (!record) throw new Error(`unknown job_id: ${jobId}`);
    if (record.status !== "running") return this.#receipt(record);
    record.cancelRequested = true;
    console.error(`[context-mode] job cancel id=${jobId}`);
    await record.handle.cancel();
    await record.done;
    return this.#receipt(record);
  }

  cleanup(): void {
    if (!this.#activeId) return;
    const record = this.#jobs.get(this.#activeId);
    if (!record || record.status !== "running") return;
    record.cancelRequested = true;
    void record.handle.cancel();
  }

  #resolveArtifact(cwd: string, artifact: string): string {
    const path = resolve(cwd, artifact);
    if (path !== cwd && !path.startsWith(`${cwd}${sep}`)) {
      throw new Error(`artifact path escapes job cwd: ${artifact}`);
    }
    return path;
  }

  #receipt(record: JobRecord): JobReceipt {
    const live = record.status === "running" ? record.handle.snapshot?.() : undefined;
    const artifacts: JobArtifact[] = [];
    for (const path of record.expectedArtifacts) {
      try {
        const stat = statSync(path);
        if (stat.isFile()) artifacts.push({ path, size: stat.size, mtime: stat.mtime.toISOString() });
      } catch { /* absent artifact */ }
    }
    return {
      job_id: record.id,
      status: record.status,
      exit_code: record.exitCode,
      started_at: record.startedAt,
      finished_at: record.finishedAt,
      termination_reason: record.terminationReason,
      stdout_tail: live?.stdoutTail ?? record.stdoutTail,
      stderr_tail: live?.stderrTail ?? record.stderrTail,
      artifacts,
    };
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, record] of this.#jobs) {
      if (record.status !== "running" && record.finishedAt && now - Date.parse(record.finishedAt) > this.#ttlMs) {
        this.#jobs.delete(id);
      }
    }
    const completed = [...this.#jobs.values()]
      .filter((record) => record.status !== "running")
      .sort((a, b) => Date.parse(a.finishedAt ?? a.startedAt) - Date.parse(b.finishedAt ?? b.startedAt));
    while (completed.length > this.#maxCompleted) {
      const oldest = completed.shift();
      if (oldest) this.#jobs.delete(oldest.id);
    }
  }
}
