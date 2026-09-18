import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { getWorker } from "../src/lib/workers.js";
import { runWorker, stopWorker, type SpawnedProcess } from "../src/lib/spawn.js";

class FakeProc {
  exitCode: number | null = null;
  pid = 7777;
  signals: string[] = [];
  private listeners: Array<(code: number | null) => void> = [];
  private stdoutListeners: Array<(chunk: string) => void> = [];

  stdout = {
    on: (_: string, cb: (chunk: string) => void) => {
      this.stdoutListeners.push(cb);
    },
  };

  kill(signal: string): void {
    this.signals.push(signal);
    this.emitExit(143);
  }

  on(event: string, cb: (code: number | null) => void) {
    if (event === "exit") {
      this.listeners.push(cb);
    }
  }

  write(text: string): void {
    for (const cb of this.stdoutListeners) {
      cb(text);
    }
  }

  emitExit(code: number | null): void {
    this.exitCode = code;
    for (const cb of this.listeners) {
      cb(code);
    }
  }
}

let dir: string;

function fakeSpawn(script: (proc: FakeProc) => void) {
  const argv: string[] = [];
  const proc = new FakeProc();
  const spawnFn = (a: string[]) => {
    argv.push(...a);
    // Emit asynchronously so runWorker can attach listeners first.
    queueMicrotask(() => script(proc));
    return proc as unknown as SpawnedProcess;
  };
  return { spawnFn, argv, proc };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-spawn-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runWorker argv", () => {
  it("builds the headless opencode run command with default flags", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => proc.emitExit(0));

    await runWorker(db, dir, {
      task: "summarize the README",
      worktree_path: "/data/wt/task",
      branch: "opencode/task",
      spawnFn: fake.spawnFn,
    });

    expect(fake.argv[0]).toBe("opencode");
    expect(fake.argv.slice(1, 4)).toEqual(["run", "--dir", "/data/wt/task"]);
    expect(fake.argv).toContain("--format");
    expect(fake.argv).toContain("json");
    expect(fake.argv).toContain("--auto");
    // No model/agent flags when not provided; task is the last argument.
    expect(fake.argv.at(-1)).toBe("summarize the README");
    expect(fake.argv).not.toContain("--model");
    expect(fake.argv).not.toContain("--agent");
    db.close();
  });

  it("adds model and agent flags when provided, and honours auto=false", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => proc.emitExit(0));

    await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      model: "z/glm",
      agent: "build",
      auto: false,
      spawnFn: fake.spawnFn,
    });

    expect(fake.argv).toContain("--model");
    expect(fake.argv).toContain("z/glm");
    expect(fake.argv).toContain("--agent");
    expect(fake.argv).toContain("build");
    expect(fake.argv).not.toContain("--auto");
    db.close();
  });
});

describe("runWorker lifecycle", () => {
  it("parses sessionID from JSON lines, writes a log file, and finalizes completed on exit 0", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.write('{"type":"step_start","sessionID":"ses-1"}\n');
      proc.write('{"type":"text","sessionID":"ses-1","text":"hello from worker"}\n');
      proc.emitExit(0);
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    const row = getWorker(db, worker.id);
    expect(row?.session_id).toBe("ses-1");
    expect(row?.status).toBe("completed");
    expect(row?.exit_code).toBe(0);
    expect(row?.finished_at).not.toBeNull();

    const log = readFileSync(join(dir, "workers", `${worker.id}.log`), "utf8");
    expect(log).toContain("hello from worker");
    db.close();
  });

  it("marks failed on non-zero exit", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => proc.emitExit(1));

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    expect(getWorker(db, worker.id)?.status).toBe("failed");
    expect(getWorker(db, worker.id)?.exit_code).toBe(1);
    db.close();
  });

  it("stopWorker SIGTERMs the process and records the stopped status", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn(() => {
      // Long-running: no exit until killed.
    });
    const killFn = vi.fn();

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
      killFn,
    });

    stopWorker(db, worker.id, { killFn });

    expect(killFn).toHaveBeenCalledWith(worker.id, "SIGTERM");
    expect(getWorker(db, worker.id)?.status).toBe("stopped");
    db.close();
  });
});
