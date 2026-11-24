import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import type { MeshDb } from "./db.js";
import {
  getWorker,
  insertWorker,
  reapEnrolledPools,
  setWorkerPid,
  setWorkerSession,
  setWorkerStatus,
  type Worker,
  type WorkerStatus,
} from "./workers.js";

export type DataListener = (chunk: string) => void;

export type SpawnedProcess = {
  pid: number;
  stdout: { on(event: "data", listener: DataListener): void };
  stderr: { on(event: "data", listener: DataListener): void };
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: string): void;
};

export type SpawnFn = (argv: string[], env?: Record<string, string>) => SpawnedProcess;
export type KillFn = (id: string, signal: string) => void;

// A child must not boot its own mesh node: a pool of N workers would otherwise
// cost N servers, N mDNS advertisers and N databases.
export const CHILD_ENV = { OPENCODE_MESH_CHILD: "1" };

// An enrolled spawn (0.23.0) is a fleet agent: it skips the server and mDNS
// (the host's server on 4399 already serves every session of this host) but
// keeps the mesh tools, and self-enrolls from its prompt header at its first
// turn.
export const CHILD_ENV_ENROLLED = { OPENCODE_MESH_CHILD: "enrolled" };

export type EnrollIdentity = {
  /** The child's mailbox name. */
  name: string;
  /** Fleet role (default "worker"). */
  role: string;
  /** Pools to join; pools[0] becomes the primary group. */
  pools: string[];
};

// The self-enrollment instructions prepended to the enrolled child's task: no
// new protocol, the child just calls the existing tools on its first turn.
export function enrollHeader(enroll: EnrollIdentity): string {
  const [primary, ...rest] = enroll.pools;
  const register =
    primary !== undefined
      ? `mesh_register(name=${enroll.name}, role=${enroll.role}, primary=${primary})`
      : `mesh_register(name=${enroll.name}, role=${enroll.role})`;
  const joins = rest.map((pool) => `mesh_join(${pool})`).join(" then ");
  const lines = [
    "You are an enrolled fleet agent: first join the mesh, then run the task below.",
    `1. Enroll: ${register}${joins.length > 0 ? ` then ${joins}` : ""}.`,
  ];
  if (primary !== undefined) {
    // mesh_register refuses a primary that no mailbox carries yet: a spawn
    // that founds a fresh pool falls back to join-creates-membership.
    lines.push(
      `   If mesh_register errors "unknown pool", call it again without the primary argument, then mesh_join(${primary}).`,
    );
  }
  lines.push("2. Then treat the following task.");
  return lines.join("\n");
}

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
      on: (_event, listener) => {
        child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
      },
    },
    stderr: {
      on: (_event, listener) => {
        child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
      },
    },
    on: ((event: "exit" | "error", listener: (arg: never) => void) => {
      if (event === "error") {
        child.on("error", listener as (error: Error) => void);
      } else {
        child.on("exit", listener as (code: number | null) => void);
      }
    }) as SpawnedProcess["on"],
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
  /** Enrolled spawn (0.23.0): the child is born a fleet agent. Absent = the
   * legacy headless worker, unchanged. */
  enroll?: EnrollIdentity;
  /** Distant spawn (0.24.0): the requesting peer's node id, stamped on the
   * registry row for the per-peer quota. Absent = local spawn. */
  spawned_by?: string;
  spawnFn: SpawnFn;
};

export type StopOptions = {
  killFn?: KillFn;
  graceMs?: number;
};

const LIVE_PROCESSES = new Map<string, SpawnedProcess>();
const PENDING_KILLS = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_KILL_GRACE_MS = 3000;
// Session-id line-buffer cap: session lines are short, 64 KiB is generous.
const PENDING_MAX_CHARS = 64 * 1024;

// Headless worker: one prompt in an isolated worktree, tracked by pid and log.
export function runWorker(db: MeshDb, dataDir: string, input: RunWorkerInput): Worker {
  mkdirSync(join(dataDir, "workers"), { recursive: true });
  // Insert first: a process spawned before the row exists would be untracked if
  // the insert threw, and the pid is only known after spawnFn returns.
  const worker = insertWorker(db, {
    task: input.task,
    worktree_path: input.worktree_path,
    branch: input.branch,
    pid: null,
    ...(input.enroll !== undefined ? { mailbox: input.enroll.name } : {}),
    ...(input.spawned_by !== undefined ? { spawned_by: input.spawned_by } : {}),
  });

  let proc: SpawnedProcess;
  try {
    proc = input.spawnFn(buildArgv(input), input.enroll ? CHILD_ENV_ENROLLED : CHILD_ENV);
  } catch {
    finalize(db, worker.id, "failed", null);
    return { ...worker, status: "failed", finished_at: Date.now() };
  }

  // A failed spawn reports pid -1 (child.pid undefined): never persist it.
  if (proc.pid > 0) {
    setWorkerPid(db, worker.id, proc.pid);
    worker.pid = proc.pid;
  }

  let sawSessionId = false;
  let pending = "";
  const captureSession = (text: string): void => {
    if (sawSessionId) {
      return;
    }
    const sessionId = parseSessionId(text);
    if (sessionId) {
      sawSessionId = true;
      setWorkerSession(db, worker.id, sessionId);
    }
  };

  proc.stdout.on("data", (chunk) => {
    appendLog(dataDir, worker.id, chunk);
    // Buffer across chunks: a JSON line split between two reads must still be
    // parsed once, not dropped as two invalid halves. Cap host memory: a
    // newline-free chatty stream would otherwise accumulate forever.
    pending += chunk;
    if (pending.length > PENDING_MAX_CHARS) {
      pending = pending.slice(-PENDING_MAX_CHARS);
    }
    const lastBreak = pending.lastIndexOf("\n");
    if (lastBreak === -1) {
      return;
    }
    const complete = pending.slice(0, lastBreak);
    pending = pending.slice(lastBreak + 1);
    captureSession(complete);
  });

  // stderr is piped: someone must drain it or the child blocks once the pipe
  // fills (~64 KB). Fold it into the same log so diagnostics survive.
  proc.stderr.on("data", (chunk) => {
    appendLog(dataDir, worker.id, chunk);
  });

  // A spawn failure (binary not on PATH) emits 'error' and never 'exit': without
  // this the row stays 'running' forever and the live entry leaks.
  proc.on("error", () => {
    LIVE_PROCESSES.delete(worker.id);
    clearPendingKill(worker.id);
    finalize(db, worker.id, "failed", null);
  });

  proc.on("exit", (code) => {
    LIVE_PROCESSES.delete(worker.id);
    clearPendingKill(worker.id);
    captureSession(pending);
    // A deliberate stopWorker already recorded a terminal state; the OS-level
    // exit event that follows must not fight it.
    const current = getWorker(db, worker.id);
    if (current === null || current.status !== "running") {
      return;
    }
    setWorkerStatus(db, worker.id, code === 0 ? "completed" : "failed", { exit_code: code });
  });

  // A pid <= 0 means the child never spawned (a real ENOENT reports pid -1
  // synchronously and delivers 'error' a tick later). Finalize now so the tool
  // reports the failure; the later 'error' event finds a terminal row and is a
  // no-op. Listeners stay attached so an unhandled 'error' cannot crash the host.
  if (proc.pid <= 0) {
    finalize(db, worker.id, "failed", null);
    return { ...worker, status: "failed", finished_at: Date.now() };
  }

  LIVE_PROCESSES.set(worker.id, proc);
  return worker;
}

// Stop a running worker. The default kill sends SIGTERM to the recorded pid and
// escalates to SIGKILL after graceMs if the process ignores it; killFn is an
// injection seam for tests (and disables escalation).
export function stopWorker(db: MeshDb, id: string, options: StopOptions = {}): boolean {
  const proc = LIVE_PROCESSES.get(id);
  if (proc === undefined) {
    throw new Error(`worker ${id} is not running`);
  }

  const kill = options.killFn ?? defaultKill;
  kill(id, "SIGTERM");
  // Registry is authoritative: remove the process entry even if the OS takes
  // time to reap the process (or a test fake ignores the signal).
  LIVE_PROCESSES.delete(id);
  setWorkerStatus(db, id, "stopped", { exit_code: null });
  // A deliberate stop of an enrolled spawn leaves its pools (0.23.0): the
  // mailbox row itself survives for the next binder of the same name.
  const row = getWorker(db, id);
  if (row !== null) {
    reapEnrolledPools(db, row);
  }

  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  if (options.killFn === undefined && proc.pid > 0 && graceMs > 0) {
    clearPendingKill(id);
    const timer = setTimeout(() => {
      PENDING_KILLS.delete(id);
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process group already gone.
      }
    }, graceMs);
    timer.unref?.();
    PENDING_KILLS.set(id, timer);
  }
  return true;
}

function clearPendingKill(id: string): void {
  const timer = PENDING_KILLS.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    PENDING_KILLS.delete(id);
  }
}

function finalize(db: MeshDb, id: string, status: WorkerStatus, exitCode: number | null): void {
  const current = getWorker(db, id);
  if (current === null || current.status !== "running") {
    return;
  }
  setWorkerStatus(db, id, status, { exit_code: exitCode });
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

// Bare JS runtimes (dev from source, tests) resolve `opencode` from PATH;
// anywhere else the plugin IS opencode, so execPath is the exact binary. A
// service-launched peer can have a PATH without `opencode`: the child then
// dies as a bare "failed" row with no cause (0.24.5) — resolve explicitly.
const BARE_RUNTIMES = new Set(["node", "bun", "deno", "tsx"]);

function openCodeArgv0(): string {
  const name = basename(process.execPath)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "");
  return BARE_RUNTIMES.has(name) ? "opencode" : process.execPath;
}

function buildArgv(input: RunWorkerInput): string[] {
  const argv = [openCodeArgv0(), "run", "--dir", input.worktree_path, "--format", "json"];
  if (input.model !== undefined) {
    argv.push("--model", input.model);
  }
  // Workers must execute, never plan: build is the safe default agent.
  argv.push("--agent", input.agent ?? "build");
  if (input.auto !== false) {
    argv.push("--auto");
  }
  // An enrolled child self-enrolls from its prompt header before the task; the
  // registry row keeps the raw task, the header lives in the prompt only.
  argv.push(input.enroll ? `${enrollHeader(input.enroll)}\n\n${input.task}` : input.task);
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

// Bound one worker's log to ~LOG_MAX_BYTES: rotate to `.1` (overwritten) once it
// grows past the cap, so a chatty worker cannot fill the disk. The tail reader
// only ever needs the last LOG_WINDOW_BYTES anyway.
const LOG_MAX_BYTES = 512 * 1024;

function appendLog(dataDir: string, id: string, chunk: string): void {
  const path = logPath(dataDir, id);
  try {
    if (statSync(path).size > LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // No log yet: nothing to rotate.
  }
  appendFileSync(path, chunk);
}

// Remove a worker's captured log, including the rotated generation.
export function removeWorkerLog(dataDir: string, id: string): void {
  const path = logPath(dataDir, id);
  rmSync(path, { force: true });
  rmSync(`${path}.1`, { force: true });
}

// Bounded tail read: a chatty worker can produce tens of MB, and the host's
// event loop must not pay for a full readFileSync on every mesh_worker_logs
// call. Reads at most LOG_WINDOW bytes from the end, then keeps the last
// `limit` complete lines.
const LOG_WINDOW_BYTES = 256 * 1024;

export function readLogTail(dataDir: string, id: string, limit: number): string {
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
  if (count === 0) {
    return "";
  }
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
    // readSync may return a short count (pipes, signals): loop until filled.
    let read = 0;
    while (read < chunk.length) {
      const n = readSync(fd, chunk, read, chunk.length - read, start + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    const lines = chunk.subarray(0, read).toString("utf8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    if (start > 0 && lines.length > 0) {
      // The window may begin mid-line: drop the partial line.
      lines.shift();
    }
    return lines.slice(-count).join("\n");
  } finally {
    closeSync(fd);
  }
}
