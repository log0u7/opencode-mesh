import { randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";

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
};

const TERMINAL_STATUSES = new Set<WorkerStatus>(["completed", "failed", "stopped"]);

type WorkerRow = {
  id: string;
  task: string;
  worktree_path: string;
  branch: string;
  pid: number | null;
  session_id: string | null;
  status: string;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
};

export function upsertWorker(
  db: MeshDb,
  input: { id?: string; task: string; worktree_path: string; branch: string; pid: number | null },
): Worker {
  const id = input.id ?? randomUUID();
  const now = Date.now();

  db.conn.run(
    `INSERT INTO workers (id, task, worktree_path, branch, pid, session_id, status, exit_code, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, ?, NULL)`,
    [id, input.task, input.worktree_path, input.branch, input.pid, now],
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
  db.conn.run("UPDATE workers SET session_id = ? WHERE id = ?", [sessionId, id]);
}

export function setWorkerStatus(
  db: MeshDb,
  id: string,
  status: WorkerStatus,
  options: { exit_code?: number | null } = {},
): void {
  const existing = getWorker(db, id);
  if (!existing) {
    throw new Error(`unknown worker: ${id}`);
  }
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw new Error(
      `worker ${id} is in terminal state ${existing.status}; refusing transition to ${status}`,
    );
  }

  const finished = TERMINAL_STATUSES.has(status) ? Date.now() : null;
  const exitCode = "exit_code" in options ? (options.exit_code ?? null) : null;
  db.conn.run("UPDATE workers SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?", [
    status,
    exitCode,
    finished,
    id,
  ]);
}

export function deleteWorker(db: MeshDb, id: string): boolean {
  db.conn.run("DELETE FROM workers WHERE id = ?", [id]);
  return (db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) > 0;
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
  };
}

function statusFromRow(raw: string): WorkerStatus {
  if (raw === "completed" || raw === "failed" || raw === "stopped") {
    return raw;
  }
  return "running";
}
