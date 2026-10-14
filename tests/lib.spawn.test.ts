import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { getWorker, insertWorker, reconcileWorkers } from "../src/lib/workers.js";
import {
  readLogTail,
  removeWorkerLog,
  runWorker,
  stopWorker,
  type SpawnedProcess,
} from "../src/lib/spawn.js";

class FakeProc {
  exitCode: number | null = null;
  pid = 7777;
  signals: string[] = [];
  ignoredSignals = new Set<string>();
  private listeners: Array<(code: number | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private stdoutListeners: Array<(chunk: string) => void> = [];
  private stderrListeners: Array<(chunk: string) => void> = [];

  stdout = {
    on: (_: string, cb: (chunk: string) => void) => {
      this.stdoutListeners.push(cb);
    },
  };

  stderr = {
    on: (_: string, cb: (chunk: string) => void) => {
      this.stderrListeners.push(cb);
    },
  };

  kill(signal: string): void {
    this.signals.push(signal);
    if (this.ignoredSignals.has(signal)) {
      return;
    }
    this.emitExit(signal === "SIGKILL" ? 137 : 143);
  }

  on(event: string, cb: (...args: unknown[]) => void) {
    if (event === "exit") {
      this.listeners.push(cb as (code: number | null) => void);
    } else if (event === "error") {
      this.errorListeners.push(cb as (error: Error) => void);
    }
  }

  write(text: string): void {
    for (const cb of this.stdoutListeners) {
      cb(text);
    }
  }

  writeErr(text: string): void {
    for (const cb of this.stderrListeners) {
      cb(text);
    }
  }

  emitExit(code: number | null): void {
    this.exitCode = code;
    for (const cb of this.listeners) {
      cb(code);
    }
  }

  emitError(error: Error): void {
    for (const cb of this.errorListeners) {
      cb(error);
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
    });

    stopWorker(db, worker.id, { killFn });

    expect(killFn).toHaveBeenCalledWith(worker.id, "SIGTERM");
    expect(getWorker(db, worker.id)?.status).toBe("stopped");
    db.close();
  });

  it("escalates to SIGKILL when the worker ignores SIGTERM", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.ignoredSignals.add("SIGTERM");
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    stopWorker(db, worker.id, { graceMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(fake.proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(getWorker(db, worker.id)?.status).toBe("stopped");
    db.close();
  });

  it("cancels the SIGKILL escalation when the worker exits during the grace window", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      // Exit asynchronously on SIGTERM, like a real child honouring the signal.
      proc.kill = (signal: string) => {
        proc.signals.push(signal);
        queueMicrotask(() => proc.emitExit(143));
      };
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    stopWorker(db, worker.id, { graceMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(fake.proc.signals).toEqual(["SIGTERM"]);
    expect(getWorker(db, worker.id)?.status).toBe("stopped");
    db.close();
  });

  it("schedules no escalation for graceMs 0", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.ignoredSignals.add("SIGTERM");
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    stopWorker(db, worker.id, { graceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(fake.proc.signals).toEqual(["SIGTERM"]);
    expect(getWorker(db, worker.id)?.status).toBe("stopped");
    db.close();
  });

  it("ignores a spawn error delivered after the row already finalized", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.emitExit(0);
      proc.emitError(new Error("late error"));
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const row = getWorker(db, worker.id);
    expect(row?.status).toBe("completed");
    expect(row?.exit_code).toBe(0);
    db.close();
  });

  it("captures a session id delivered without a trailing newline", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.write('{"type":"step_start","sessionID":"ses-tail"}');
      proc.emitExit(0);
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    expect(getWorker(db, worker.id)?.session_id).toBe("ses-tail");
    db.close();
  });

  it("finalizes failed when the spawn emits an error instead of exiting", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.emitError(new Error("spawn opencode ENOENT"));
    });
    // A failed spawn reports pid -1 synchronously, before spawnFn returns.
    fake.proc.pid = -1;

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });
    // The error event is async: let it deliver before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const row = getWorker(db, worker.id);
    expect(row?.status).toBe("failed");
    // pid -1 means "no process": it must never be persisted.
    expect(row?.pid).toBeNull();
    db.close();
  });

  it("reassembles a session id split across two stdout chunks", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.write('{"type":"step_start","session');
      proc.write('ID":"ses-split"}\n');
      proc.emitExit(0);
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    expect(getWorker(db, worker.id)?.session_id).toBe("ses-split");
    db.close();
  });

  it("drains stderr into the worker log", async () => {
    const db = openMeshDb(":memory:");
    const fake = fakeSpawn((proc) => {
      proc.writeErr("warning: something\n");
      proc.emitExit(0);
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    const log = readFileSync(join(dir, "workers", `${worker.id}.log`), "utf8");
    expect(log).toContain("warning: something");
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

  it("returns nothing for a non-positive limit and falls back for NaN", () => {
    const logDir = join(dir, "workers");
    mkdirSync(logDir, { recursive: true });
    const id = "log-limit-worker";
    writeFileSync(join(logDir, `${id}.log`), "one\ntwo\nthree\n", "utf8");

    expect(readLogTail(dir, id, 0)).toBe("");
    expect(readLogTail(dir, id, -5)).toBe("");
    // A non-finite limit falls back to the 50-line default, not to "all".
    expect(readLogTail(dir, id, Number.NaN)).toBe("one\ntwo\nthree");
  });
});

describe("removeWorkerLog", () => {
  it("deletes the log and its rotated generation, and is idempotent", () => {
    const logDir = join(dir, "workers");
    mkdirSync(logDir, { recursive: true });
    const id = "remove-log-worker";
    writeFileSync(join(logDir, `${id}.log`), "current\n", "utf8");
    writeFileSync(join(logDir, `${id}.log.1`), "rotated\n", "utf8");

    removeWorkerLog(dir, id);

    expect(existsSync(join(logDir, `${id}.log`))).toBe(false);
    expect(existsSync(join(logDir, `${id}.log.1`))).toBe(false);
    expect(() => removeWorkerLog(dir, id)).not.toThrow();
  });
});

describe("worker log rotation", () => {
  it("rotates the log to .1 once it exceeds the cap", async () => {
    const db = openMeshDb(":memory:");
    const chunk = "x".repeat(300 * 1024);
    const fake = fakeSpawn((proc) => {
      proc.write(chunk);
      proc.write(chunk);
      proc.write(chunk);
      proc.emitExit(0);
    });

    const worker = await runWorker(db, dir, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      spawnFn: fake.spawnFn,
    });

    const log = join(dir, "workers", `${worker.id}.log`);
    const rotated = `${log}.1`;
    expect(existsSync(rotated)).toBe(true);
    // The live log restarted empty, so it is smaller than the rotated one.
    expect(statSync(log).size).toBeLessThan(statSync(rotated).size);
    db.close();
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
