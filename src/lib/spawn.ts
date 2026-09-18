import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { type MeshDb } from "./db.js";
import { setWorkerSession, setWorkerStatus, upsertWorker, type Worker } from "./workers.js";

export type SpawnedProcess = {
  pid: number;
  stdout: {
    on(event: "data", listener: (chunk: string) => void): void;
  };
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(signal?: string): void;
};

export type SpawnFn = (argv: string[]) => SpawnedProcess;
export type KillFn = (id: string, signal: string) => void;

// Real adapter used by the plugin: node child_process wrapped to the minimal
// SpawnedProcess surface (works under Bun's node compat at runtime).
export function nodeSpawn(argv: string[]): SpawnedProcess {
  const child = spawn(argv[0] ?? "", argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
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
      child.kill((signal ?? "SIGTERM") as never);
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
  onSpawned?: (worker: Worker, proc: SpawnedProcess) => void;
};

export type StopOptions = {
  killFn?: KillFn;
};

const LIVE_PROCESSES = new Map<string, SpawnedProcess>();

// Headless worker: one prompt in an isolated worktree, tracked by pid and log.
export function runWorker(db: MeshDb, dataDir: string, input: RunWorkerInput): Worker {
  const argv = buildArgv(input);
  const proc = input.spawnFn(argv);

  mkdirSync(join(dataDir, "workers"), { recursive: true });
  const worker = upsertWorker(db, {
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
    setWorkerStatus(db, worker.id, code === 0 ? "completed" : "failed", { exit_code: code });
  });

  LIVE_PROCESSES.set(worker.id, proc);
  input.onSpawned?.(worker, proc);
  return worker;
}

// Stop a running worker. The default kill sends SIGTERM to the recorded pid;
// killFn is an injection seam for tests.
export function stopWorker(db: MeshDb, id: string, options: StopOptions = {}): boolean {
  const worker = db && liveWorker(id);
  if (!worker) {
    throw new Error(`worker ${id} is not running`);
  }

  const kill = options.killFn ?? defaultKill;
  kill(worker.id, "SIGTERM");
  // Registry is authoritative: remove the process entry even if the OS takes
  // time to reap the process (or a test fake ignores the signal).
  LIVE_PROCESSES.delete(id);
  setWorkerStatus(db, id, "stopped", { exit_code: null });
  return true;
}

export function defaultKill(id: string, signal: string): void {
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
  if (input.agent !== undefined) {
    argv.push("--agent", input.agent);
  }
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

function liveWorker(id: string): { id: string } | null {
  return LIVE_PROCESSES.has(id) ? { id } : null;
}
