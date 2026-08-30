import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  JobManager,
  SystemdJobRunner,
  buildSystemdRunArgs,
  classifyJobTermination,
  type JobCompletion,
  type JobHandle,
  type JobRunner,
} from "../src/jobs.js";

class FakeRunner implements JobRunner {
  completions: Array<(value: JobCompletion) => void> = [];
  tails: Array<{ stdoutTail: string; stderrTail: string }> = [];
  cancels = 0;
  reconciles = 0;

  reconcile(): void {
    this.reconciles += 1;
  }

  start(): JobHandle {
    let resolve!: (value: JobCompletion) => void;
    const done = new Promise<JobCompletion>((r) => { resolve = r; });
    const tail = { stdoutTail: "", stderrTail: "" };
    this.completions.push(resolve);
    this.tails.push(tail);
    return {
      done,
      snapshot: () => ({ ...tail }),
      cancel: async () => { this.cancels += 1; },
    };
  }
}

describe("async jobs", () => {

  test("reconciles stale runner jobs when the manager starts", () => {
    const runner = new FakeRunner();
    new JobManager({ runner });
    expect(runner.reconciles).toBe(1);
  });

  test("reports bounded live output while a job is running", () => {
    const runner = new FakeRunner();
    const manager = new JobManager({ runner });
    const root = mkdtempSync(join(tmpdir(), "context-mode-job-live-"));
    try {
      const started = manager.start({ command: "build", cwd: root });
      runner.tails[0].stdoutTail = "compile 42%";
      runner.tails[0].stderrTail = "warning";
      expect(manager.status(started.jobId)).toEqual(expect.objectContaining({
        status: "running",
        stdout_tail: "compile 42%",
        stderr_tail: "warning",
      }));
      runner.completions[0]({ exitCode: 0, stdoutTail: "done", stderrTail: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("admits two projects, limits one job per project, and enforces global capacity", async () => {
    const runner = new FakeRunner();
    const manager = new JobManager({ runner, maxCompleted: 4, ttlMs: 60_000, maxActive: 2, maxActivePerProject: 1 });
    const rootA = mkdtempSync(join(tmpdir(), "context-mode-job-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "context-mode-job-b-"));
    const rootC = mkdtempSync(join(tmpdir(), "context-mode-job-c-"));
    try {
      const artifact = join(rootA, "app.apk");
      const first = manager.start({ command: "build-a", cwd: rootA, expectedArtifacts: ["app.apk"] });
      const second = manager.start({ command: "build-b", cwd: rootB });
      expect(manager.activeCount()).toBe(2);
      expect(manager.isActive(rootA)).toBe(true);
      expect(manager.isActive(rootB)).toBe(true);
      expect(manager.isActive(rootC)).toBe(false);
      expect(() => manager.start({ command: "same-project", cwd: rootA })).toThrow(/this project/i);
      expect(() => manager.start({ command: "third-project", cwd: rootC })).toThrow(/capacity/i);

      writeFileSync(artifact, "apk");
      runner.completions[0]({ exitCode: 0, stdoutTail: "ok-a", stderrTail: "" });
      runner.completions[1]({ exitCode: 0, stdoutTail: "ok-b", stderrTail: "" });
      await Promise.all([first.done, second.done]);

      expect(manager.activeCount()).toBe(0);
      const status = manager.status(first.jobId);
      expect(status.status).toBe("succeeded");
      expect(status.stdout_tail).toBe("ok-a");
      expect(status.artifacts).toEqual([expect.objectContaining({ path: artifact, size: 3 })]);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(rootC, { recursive: true, force: true });
    }
  });

  test("cancels the active job and rejects artifact paths outside cwd", async () => {
    const runner = new FakeRunner();
    const manager = new JobManager({ runner });
    const root = mkdtempSync(join(tmpdir(), "context-mode-job-cancel-"));
    try {
      expect(() => manager.start({ command: "bad", cwd: root, expectedArtifacts: ["../escape.apk"] }))
        .toThrow(/artifact/i);

      const started = manager.start({ command: "sleep", cwd: root });
      const cancel = manager.cancel(started.jobId);
      expect(runner.cancels).toBe(1);
      runner.completions[0]({ exitCode: 143, stdoutTail: "", stderrTail: "" });
      await Promise.all([cancel, started.done]);
      expect(manager.status(started.jobId).status).toBe("cancelled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies systemd termination reasons without losing cancellation precedence", async () => {
    const cases = [
      [{ exitCode: 1, systemdResult: "oom-kill", execMainStatus: 9 }, "oom-kill"],
      [{ exitCode: 1, systemdResult: "timeout", execMainStatus: 9 }, "runtime-timeout"],
      [{ exitCode: 1, systemdResult: "signal", execMainStatus: 15 }, "signal:15"],
      [{ exitCode: 7, systemdResult: "exit-code", execMainStatus: 7 }, "exit:7"],
    ] as const;
    for (const [completion, expected] of cases) {
      const runner = new FakeRunner();
      const manager = new JobManager({ runner });
      const root = mkdtempSync(join(tmpdir(), "context-mode-job-reason-"));
      try {
        const started = manager.start({ command: "fail", cwd: root });
        runner.completions[0]({ ...completion, stdoutTail: "", stderrTail: "" } as JobCompletion);
        await started.done;
        expect(manager.status(started.jobId).termination_reason).toBe(expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const runner = new FakeRunner();
    const manager = new JobManager({ runner });
    const root = mkdtempSync(join(tmpdir(), "context-mode-job-cancel-reason-"));
    try {
      const started = manager.start({ command: "sleep", cwd: root });
      const cancelled = manager.cancel(started.jobId);
      runner.completions[0]({ exitCode: 1, systemdResult: "signal", execMainStatus: 15, stdoutTail: "", stderrTail: "" } as JobCompletion);
      await cancelled;
      expect(manager.status(started.jobId).termination_reason).toBe("cancelled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads RuntimeMaxSec from systemd as runtime-timeout", async () => {
    if (process.platform !== "linux" || typeof process.getuid !== "function" || !existsSync(`/run/user/${process.getuid()}/bus`)) return;
    const previous = process.env.CONTEXT_MODE_JOB_RUNTIME_MAX_SEC;
    process.env.CONTEXT_MODE_JOB_RUNTIME_MAX_SEC = "1";
    try {
      const runner = new SystemdJobRunner();
      const completion = await runner.start({
        unit: `context-mode-test-timeout-${process.pid}`,
        cwd: process.cwd(),
        command: "sleep 5",
      }).done;
      expect(completion.systemdResult).toBe("timeout");
      expect(classifyJobTermination(completion, false)).toEqual({ status: "failed", reason: "runtime-timeout" });
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MODE_JOB_RUNTIME_MAX_SEC;
      else process.env.CONTEXT_MODE_JOB_RUNTIME_MAX_SEC = previous;
    }
  });

  test("builds a bounded native systemd user service command", () => {
    const args = buildSystemdRunArgs({
      unit: "context-mode-job-abc",
      cwd: "/tmp/project",
      command: "godot --headless --export-debug Android app.apk",
      memoryHighMb: 2048,
      memoryMaxMb: 2304,
      memorySwapMaxMb: 256,
      tasksMax: 128,
      cpuQuotaPercent: 200,
      runtimeMaxSec: 3600,
      path: "/usr/bin:/bin",
      home: "/home/test",
    });
    expect(args).toContain("--property=MemoryHigh=2048M");
    expect(args).toContain("--property=MemoryMax=2304M");
    expect(args).toContain("--property=MemorySwapMax=256M");
    expect(args).toContain("--property=TasksMax=128");
    expect(args).toContain("--property=CPUQuota=200%");
    expect(args).toContain("--property=RuntimeMaxSec=3600s");
    expect(args).toContain("--property=NoNewPrivileges=yes");
    expect(args).toContain("--property=UMask=0077");
    expect(args).toContain("--setenv=LANG=en_US.UTF-8");
    expect(args).toContain("--setenv=NO_COLOR=1");
    expect(args).toContain("--pipe");
    expect(args).not.toContain("--collect");
    expect(args.slice(-3)).toEqual(["/bin/bash", "-c", "godot --headless --export-debug Android app.apk"]);
  });
});
