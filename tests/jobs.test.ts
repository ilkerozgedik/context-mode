import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  JobManager,
  buildSystemdRunArgs,
  type JobCompletion,
  type JobHandle,
  type JobRunner,
} from "../src/jobs.js";

class FakeRunner implements JobRunner {
  completions: Array<(value: JobCompletion) => void> = [];
  cancels = 0;

  start(): JobHandle {
    let resolve!: (value: JobCompletion) => void;
    const done = new Promise<JobCompletion>((r) => { resolve = r; });
    this.completions.push(resolve);
    return {
      done,
      cancel: async () => { this.cancels += 1; },
    };
  }
}

describe("async jobs", () => {
  test("admits only one active job and exposes a receipt after completion", async () => {
    const runner = new FakeRunner();
    const manager = new JobManager({ runner, maxCompleted: 4, ttlMs: 60_000 });
    const root = mkdtempSync(join(tmpdir(), "context-mode-job-"));
    try {
      const artifact = join(root, "app.apk");
      const first = manager.start({ command: "build", cwd: root, expectedArtifacts: ["app.apk"] });
      expect(() => manager.start({ command: "second", cwd: root })).toThrow(/busy/i);
      writeFileSync(artifact, "apk");
      runner.completions[0]({ exitCode: 0, stdoutTail: "ok", stderrTail: "" });
      await first.done;

      const status = manager.status(first.jobId);
      expect(status.status).toBe("succeeded");
      expect(status.exit_code).toBe(0);
      expect(status.stdout_tail).toBe("ok");
      expect(status.artifacts).toEqual([
        expect.objectContaining({ path: artifact, size: 3 }),
      ]);

      const next = manager.start({ command: "next", cwd: root });
      runner.completions[1]({ exitCode: 1, stdoutTail: "", stderrTail: "failed" });
      await next.done;
      expect(manager.status(next.jobId).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  test("builds a bounded native systemd user service command", () => {
    const args = buildSystemdRunArgs({
      unit: "context-mode-job-abc",
      cwd: "/tmp/project",
      command: "godot --headless --export-debug Android app.apk",
      memoryMaxMb: 1536,
      memorySwapMaxMb: 256,
      tasksMax: 128,
      cpuQuotaPercent: 200,
      runtimeMaxSec: 3600,
      path: "/usr/bin:/bin",
      home: "/home/test",
    });
    expect(args).toContain("--property=MemoryMax=1536M");
    expect(args).toContain("--property=MemorySwapMax=256M");
    expect(args).toContain("--property=TasksMax=128");
    expect(args).toContain("--property=CPUQuota=200%");
    expect(args).toContain("--property=RuntimeMaxSec=3600s");
    expect(args).toContain("--pipe");
    expect(args).toContain("--collect");
    expect(args.slice(-3)).toEqual(["/bin/bash", "-lc", "godot --headless --export-debug Android app.apk"]);
  });
});
