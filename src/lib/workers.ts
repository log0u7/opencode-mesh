import { randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";
import { leavePool, mailboxByName } from "./mail.js";

export type WorkerStatus = "running" | "completed" | "failed" | "stopped";

export type Worker = {
  id: string;
  task: string;
  worktree_path: string;
  branch: string;
  pid: number | null;
  session_id: string | null;
  status: WorkerStatus;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  /** Set for an enrolled spawn (0.23.0): the worker was born a fleet agent
   * with this mailbox name. NULL for a plain headless worker. */
  mailbox: string | null;
};

const TERMINAL_STATUSES = new Set<WorkerStatus>(["completed", "failed", "stopped"]);

type WorkerRow = Omit<Worker, "status"> & { status: string };

export function insertWorker(
  db: MeshDb,
  input: {
    id?: string;
    task: string;
    worktree_path: string;
    branch: string;
    pid: number | null;
    mailbox?: string | null;
  },
): Worker {
  const id = input.id ?? randomUUID();
  const now = Date.now();

  db.conn.run(
    `INSERT INTO workers (id, task, worktree_path, branch, pid, session_id, status, exit_code, started_at, finished_at, mailbox)
     VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, ?, NULL, ?)`,
    [id, input.task, input.worktree_path, input.branch, input.pid, now, input.mailbox ?? null],
  );

  return {
    id,
    task: input.task,
    worktree_path: input.worktree_path,
    branch: input.branch,
    pid: input.pid,
    session_id: null,
    status: "running",
    exit_code: null,
    started_at: now,
    finished_at: null,
    mailbox: input.mailbox ?? null,
  };
}

export function getWorker(db: MeshDb, id: string): Worker | null {
  const row = db.conn.get<WorkerRow>("SELECT * FROM workers WHERE id = ?", [id]);
  return row ? rowToWorker(row) : null;
}

export function listWorkers(db: MeshDb): Worker[] {
  return db.conn
    .all<WorkerRow>("SELECT * FROM workers ORDER BY started_at DESC, rowid DESC")
    .map(rowToWorker);
}

export function setWorkerSession(db: MeshDb, id: string, sessionId: string): void {
  // A late stdout chunk after the process finalized must not resurrect a
  // session id on a terminal row.
  db.conn.run("UPDATE workers SET session_id = ? WHERE id = ? AND status = 'running'", [
    sessionId,
    id,
  ]);
}

export function setWorkerPid(db: MeshDb, id: string, pid: number): void {
  db.conn.run("UPDATE workers SET pid = ? WHERE id = ?", [pid, id]);
}

export function setWorkerStatus(
  db: MeshDb,
  id: string,
  status: WorkerStatus,
  options: { exit_code?: number | null } = {},
): void {
  const finished = TERMINAL_STATUSES.has(status) ? Date.now() : null;
  const exitCode = "exit_code" in options ? (options.exit_code ?? null) : null;
  // Guard the transition inside the UPDATE: a concurrent finalize in another
  // process must not be overwritten by a stale read-then-write. The terminal
  // list comes from TERMINAL_STATUSES so it cannot drift.
  const terminals = [...TERMINAL_STATUSES];
  db.conn.run(
    `UPDATE workers SET status = ?, exit_code = ?, finished_at = ?
     WHERE id = ? AND status NOT IN (${terminals.map(() => "?").join(", ")})`,
    [status, exitCode, finished, id, ...terminals],
  );
  const changed =
    (db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) > 0;
  if (changed) {
    return;
  }

  const existing = getWorker(db, id);
  if (!existing) {
    throw new Error(`unknown worker: ${id}`);
  }
  throw new Error(
    `worker ${id} is in terminal state ${existing.status}; refusing transition to ${status}`,
  );
}

export function deleteWorker(db: MeshDb, id: string): boolean {
  db.conn.run("DELETE FROM workers WHERE id = ?", [id]);
  return (db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) > 0;
}

// spawnMax quota (0.23.0): only enrolled workers count — a plain headless
// worker pool stays unlimited.
export function countRunningEnrolled(db: MeshDb): number {
  return (
    db.conn.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workers WHERE mailbox IS NOT NULL AND status = 'running'",
    )?.n ?? 0
  );
}

// Reap an enrolled worker's pool memberships after a deliberate stop/remove.
// The mailbox row itself stays: the name re-binds on the next mesh_register of
// the same name (last binder wins). Brutal child death is NOT reaped here (the
// exit path cannot distinguish signal from crash): a future mailbox GC handles
// those leftovers. Guard against a handoff: if the mailbox was re-registered by
// another session in the meantime, its pools belong to the new binder.
export function reapEnrolledPools(db: MeshDb, worker: Worker): string[] {
  if (worker.mailbox === null) {
    return [];
  }
  const box = mailboxByName(db, worker.mailbox);
  if (!box) {
    return [];
  }
  if (worker.session_id !== null && box.session_id !== worker.session_id) {
    return [];
  }
  for (const pool of box.pools) {
    leavePool(db, box.name, pool);
  }
  return box.pools;
}

// After a host restart the in-memory process map is gone, so 'running' rows can
// never be stopped again. Rows whose pid no longer exists are marked stopped.
export function reconcileWorkers(db: MeshDb): number {
  const rows = db.conn.all<{ id: string; pid: number | null }>(
    "SELECT id, pid FROM workers WHERE status = 'running'",
  );
  let reconciled = 0;
  for (const row of rows) {
    if (row.pid === null || !pidAlive(row.pid)) {
      db.conn.run(
        "UPDATE workers SET status = 'stopped', exit_code = NULL, finished_at = ? WHERE id = ?",
        [Date.now(), row.id],
      );
      reconciled++;
    }
  }
  return reconciled;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function rowToWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    task: row.task,
    worktree_path: row.worktree_path,
    branch: row.branch,
    pid: row.pid,
    session_id: row.session_id,
    status: statusFromRow(row.status),
    exit_code: row.exit_code,
    started_at: row.started_at,
    finished_at: row.finished_at,
    mailbox: row.mailbox,
  };
}

function statusFromRow(raw: string): WorkerStatus {
  if (raw === "completed" || raw === "failed" || raw === "stopped") {
    return raw;
  }
  return "running";
}
