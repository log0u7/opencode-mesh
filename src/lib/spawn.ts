import { spawn } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { MeshDb } from "./db.js";
import {
  getWorker,
  insertWorker,
  setWorkerSession,
  setWorkerStatus,
  type Worker,
} from "./workers.js";

export type SpawnedProcess = {
  pid: number;
  stdout: {
    on(event: "data", listener: (chunk: string) => void): void;
  };
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(signal?: string): void;
};

export type SpawnFn = (argv: string[], env?: Record<string, string>) => SpawnedProcess;
export type KillFn = (id: string, signal: string) => void;

// A child must not boot its own mesh node: a pool of N workers would otherwise
// cost N servers, N mDNS advertisers and N databases.
export const CHILD_ENV = { OPENCODE_MESH_CHILD: "1" };

// Real adapter used by the plugin: node child_process wrapped to the minimal
// SpawnedProcess surface (works under Bun's node compat at runtime).
export function nodeSpawn(argv: string[], env?: Record<string, string>): SpawnedProcess {
  // Detached on POSIX: the worker becomes a process group leader, so a stop
  // takes down its own children too instead of orphaning them.
  const detached = process.platform !== "win32";
  const child = spawn(argv[0] ?? "", argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    ...(detached ? { detached: true } : {}),
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  });
  const pid = child.pid ?? -1;
  return {
    pid,
    stdout: {
      on: (event, listener) => {
        child.stdout?.on(event, (chunk: Buffer) => listener(chunk.toString("utf8")));
      },
    },
    on: (event, listener) => {
      child.on(event, (code: number | null) => listener(code));
    },
    kill: (signal) => {
      const sig = (signal ?? "SIGTERM") as NodeJS.Signals;
      if (detached && pid > 0) {
        try {
          // Negative pid targets the whole group: worker plus its children.
          process.kill(-pid, sig);
          return;
        } catch {
          // Group already gone; fall through to the direct signal.
        }
      }
      child.kill(sig);
    },
  };
}

export type RunWorkerInput = {
  task: string;
  worktree_path: string;
  branch: string;
  model?: string;
  agent?: string;
  auto?: boolean;
  spawnFn: SpawnFn;
  killFn?: KillFn;
};

export type StopOptions = {
  killFn?: KillFn;
};

const LIVE_PROCESSES = new Map<string, SpawnedProcess>();

// Headless worker: one prompt in an isolated worktree, tracked by pid and log.
export function runWorker(db: MeshDb, dataDir: string, input: RunWorkerInput): Worker {
  const argv = buildArgv(input);
  const proc = input.spawnFn(argv, CHILD_ENV);

  mkdirSync(join(dataDir, "workers"), { recursive: true });
  const worker = insertWorker(db, {
    task: input.task,
    worktree_path: input.worktree_path,
    branch: input.branch,
    pid: proc.pid,
  });

  let sawSessionId = false;
  proc.stdout.on("data", (chunk: string) => {
    appendFileSync(logPath(dataDir, worker.id), chunk);
    if (!sawSessionId) {
      const sessionId = parseSessionId(chunk);
      if (sessionId) {
        sawSessionId = true;
        setWorkerSession(db, worker.id, sessionId);
      }
    }
  });

  proc.on("exit", (code) => {
    LIVE_PROCESSES.delete(worker.id);
    // A deliberate stopWorker already recorded a terminal state; the OS-level
    // exit event that follows must not fight it.
    const current = getWorker(db, worker.id);
    if (current === null || current.status !== "running") {
      return;
    }
    setWorkerStatus(db, worker.id, code === 0 ? "completed" : "failed", { exit_code: code });
  });

  LIVE_PROCESSES.set(worker.id, proc);
  return worker;
}

// Stop a running worker. The default kill sends SIGTERM to the recorded pid;
// killFn is an injection seam for tests.
export function stopWorker(db: MeshDb, id: string, options: StopOptions = {}): boolean {
  if (!LIVE_PROCESSES.has(id)) {
    throw new Error(`worker ${id} is not running`);
  }

  const kill = options.killFn ?? defaultKill;
  kill(id, "SIGTERM");
  // Registry is authoritative: remove the process entry even if the OS takes
  // time to reap the process (or a test fake ignores the signal).
  LIVE_PROCESSES.delete(id);
  setWorkerStatus(db, id, "stopped", { exit_code: null });
  return true;
}

function defaultKill(id: string, signal: string): void {
  const proc = LIVE_PROCESSES.get(id);
  proc?.kill(signal);
}

// Terminate every live worker: used by the plugin's dispose so a stopped
// opencode session never leaves orphan processes behind.
export function stopAllWorkers(db: MeshDb, options: StopOptions = {}): void {
  for (const id of [...LIVE_PROCESSES.keys()]) {
    try {
      stopWorker(db, id, options);
    } catch {
      // Worker may have exited between snapshot and stop: nothing to do.
    }
  }
}

export function liveWorkerIds(): string[] {
  return [...LIVE_PROCESSES.keys()];
}

function buildArgv(input: RunWorkerInput): string[] {
  const argv = ["opencode", "run", "--dir", input.worktree_path, "--format", "json"];
  if (input.model !== undefined) {
    argv.push("--model", input.model);
  }
  // Workers must execute, never plan: build is the safe default agent.
  argv.push("--agent", input.agent ?? "build");
  if (input.auto !== false) {
    argv.push("--auto");
  }
  argv.push(input.task);
  return argv;
}

function parseSessionId(chunk: string): string | null {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { sessionID?: unknown };
      if (typeof parsed.sessionID === "string" && parsed.sessionID.length > 0) {
        return parsed.sessionID;
      }
    } catch {
      // Partial or non-JSON line: try the next one.
    }
  }
  return null;
}

function logPath(dataDir: string, id: string): string {
  return join(dataDir, "workers", `${id}.log`);
}

// Bounded tail read: a chatty worker can produce tens of MB, and the host's
// event loop must not pay for a full readFileSync on every mesh_worker_logs
// call. Reads at most LOG_WINDOW bytes from the end, then keeps the last
// `limit` complete lines.
const LOG_WINDOW_BYTES = 256 * 1024;

export function readLogTail(dataDir: string, id: string, limit: number): string {
  let fd: number;
  try {
    fd = openSync(logPath(dataDir, id), "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LOG_WINDOW_BYTES);
    const chunk = Buffer.alloc(size - start);
    readSync(fd, chunk, 0, chunk.length, start);
    const lines = chunk.toString("utf8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    if (start > 0 && lines.length > 0) {
      // The window may begin mid-line: drop the partial line.
      lines.shift();
    }
    return lines.slice(-limit).join("\n");
  } finally {
    closeSync(fd);
  }
}
