import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { getWorker, insertWorker, reconcileWorkers } from "../src/lib/workers.js";
import { readLogTail, runWorker, stopWorker, type SpawnedProcess } from "../src/lib/spawn.js";

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
  const env: Array<Record<string, string> | undefined> = [];
  const proc = new FakeProc();
  const spawnFn = (a: string[], e?: Record<string, string>) => {
    argv.push(...a);
    env.push(e);
    // Emit asynchronously so runWorker can attach listeners first.
    queueMicrotask(() => script(proc));
    return proc as unknown as SpawnedProcess;
  };
  return { spawnFn, argv, env, proc };
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
    // Workers must execute, never plan: --agent build is the default.
    expect(fake.argv).toContain("--agent");
    expect(fake.argv).toContain("build");
    expect(fake.argv.at(-1)).toBe("summarize the README");
    expect(fake.argv).not.toContain("--model");
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

  it("marks the child process so it does not boot its own mesh node", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => proc.emitExit(0));

    await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    // Without this, every worker starts a server, an mDNS advertiser and a db.
    expect(fake.env).toEqual([{ OPENCODE_MESH_CHILD: "1" }]);
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

describe("readLogTail", () => {
  it("returns only the requested number of final lines", () => {
    const logDir = join(dir, "workers");
    mkdirSync(logDir, { recursive: true });
    const id = "log-tail-worker";
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    writeFileSync(join(logDir, `${id}.log`), `${lines.join("\n")}\n`, "utf8");

    const tail = readLogTail(dir, id, 50);
    const tailLines = tail.split("\n");
    expect(tailLines).toHaveLength(50);
    expect(tailLines[0]).toBe("line 4950");
    expect(tailLines.at(-1)).toBe("line 4999");
  });

  it("returns the whole file when it is smaller than the window", () => {
    const logDir = join(dir, "workers");
    mkdirSync(logDir, { recursive: true });
    const id = "log-small-worker";
    writeFileSync(join(logDir, `${id}.log`), "one\ntwo\n", "utf8");

    expect(readLogTail(dir, id, 50)).toBe("one\ntwo");
  });

  it("returns an empty string when no log exists yet", () => {
    expect(readLogTail(dir, "missing-worker", 50)).toBe("");
  });
});

describe("reconcileWorkers", () => {
  it("marks running rows dead when their pid no longer exists", async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const db = openMeshDb(":memory:");

    // A pid that is guaranteed gone: a child that already exited and was reaped.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(dead, "exit");
    expect(dead.pid).toBeDefined();

    const alive = insertWorker(db, {
      id: "still-here",
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      pid: process.pid,
    });
    const gone = insertWorker(db, {
      id: "gone-after-reload",
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      pid: dead.pid as number,
    });

    expect(reconcileWorkers(db)).toBe(1);
    expect(getWorker(db, alive.id)?.status).toBe("running");
    expect(getWorker(db, gone.id)?.status).toBe("stopped");

    db.close();
  });
});
