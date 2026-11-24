import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import {
  countRunningEnrolled,
  getWorker,
  listWorkers,
  reapEnrolledPools,
  setWorkerPid,
  setWorkerSession,
  setWorkerStatus,
  insertWorker,
} from "../src/lib/workers.js";
import { joinPool, mailboxByName, registerMailbox } from "../src/lib/mail.js";

function spawn(db: ReturnType<typeof openMeshDb>, overrides: Record<string, unknown> = {}) {
  return insertWorker(db, {
    id: "w1",
    task: "summarize the README",
    worktree_path: "/data/worktree/p1/task",
    branch: "opencode/task",
    pid: 4242,
    ...overrides,
  });
}

describe("workers store", () => {
  it("registers a worker in running state with timestamps", () => {
    const db = openMeshDb(":memory:");
    const worker = spawn(db);

    expect(worker.id).toBe("w1");
    expect(worker.status).toBe("running");
    expect(worker.session_id).toBeNull();
    expect(worker.exit_code).toBeNull();
    expect(worker.started_at).toBeGreaterThan(0);

    const fetched = getWorker(db, "w1");
    expect(fetched?.task).toBe("summarize the README");
    db.close();
  });

  it("binds a session id and finalizes with status and exit code", () => {
    const db = openMeshDb(":memory:");
    spawn(db);
    setWorkerSession(db, "w1", "ses-123");

    expect(getWorker(db, "w1")?.session_id).toBe("ses-123");

    setWorkerStatus(db, "w1", "completed", { exit_code: 0 });
    const done = getWorker(db, "w1");
    expect(done?.status).toBe("completed");
    expect(done?.exit_code).toBe(0);
    expect(done?.finished_at).toBeGreaterThan(0);
    db.close();
  });

  it("ignores a session id bound after the worker reached a terminal state", () => {
    const db = openMeshDb(":memory:");
    spawn(db);
    setWorkerStatus(db, "w1", "failed", { exit_code: 1 });

    // A late stdout chunk must not resurrect a session id on a terminal row.
    setWorkerSession(db, "w1", "ses-late");
    expect(getWorker(db, "w1")?.session_id).toBeNull();
    db.close();
  });

  it("records the pid after the row exists (insert-first spawn)", () => {
    const db = openMeshDb(":memory:");
    insertWorker(db, {
      id: "w-pid",
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      pid: null,
    });

    setWorkerPid(db, "w-pid", 31337);
    expect(getWorker(db, "w-pid")?.pid).toBe(31337);
    db.close();
  });

  it("rejects transitions from a terminal state", () => {
    const db = openMeshDb(":memory:");
    spawn(db);
    setWorkerStatus(db, "w1", "failed", { exit_code: 1 });

    expect(() => setWorkerStatus(db, "w1", "running")).toThrow(/terminal/);
    db.close();
  });

  it("does not overwrite a terminal row when the pre-read is stale", () => {
    const db = openMeshDb(":memory:");
    spawn(db);
    // Another process finalizes the worker first.
    db.conn.run("UPDATE workers SET status = 'failed', finished_at = 1 WHERE id = 'w1'");

    // Simulate a stale read: the transition guard must come from the UPDATE,
    // not from the earlier SELECT.
    const realGet = db.conn.get.bind(db.conn);
    db.conn.get = ((sql: string, params?: unknown[]) => {
      if (sql.includes("FROM workers WHERE id")) {
        return {
          id: "w1",
          task: "t",
          worktree_path: "/wt",
          branch: "b",
          pid: null,
          session_id: null,
          status: "running",
          exit_code: null,
          started_at: 1,
          finished_at: null,
        } as unknown;
      }
      return realGet(sql, params);
    }) as typeof db.conn.get;

    expect(() => setWorkerStatus(db, "w1", "completed", { exit_code: 0 })).toThrow(/terminal/);

    db.conn.get = realGet;
    expect(getWorker(db, "w1")?.status).toBe("failed");
    db.close();
  });

  it("throws for an unknown worker id", () => {
    const db = openMeshDb(":memory:");
    expect(() => setWorkerStatus(db, "ghost", "completed")).toThrow(/unknown worker/);
    db.close();
  });

  it("lists workers newest first and returns null for unknown ids", () => {
    const db = openMeshDb(":memory:");
    spawn(db);
    spawn(db, { id: "w2", task: "second" });

    const all = listWorkers(db);
    expect(all.map((w) => w.id)).toEqual(["w2", "w1"]);

    expect(getWorker(db, "ghost")).toBeNull();
    db.close();
  });

  it("stop transition is allowed from running but not from completed", () => {
    const db = openMeshDb(":memory:");
    spawn(db);
    setWorkerStatus(db, "w1", "stopped", { exit_code: null });
    expect(getWorker(db, "w1")?.status).toBe("stopped");
    expect(() => setWorkerStatus(db, "w1", "completed", { exit_code: 0 })).toThrow(/terminal/);
    db.close();
  });
});

describe("enrolled workers (0.23.0)", () => {
  it("persists the mailbox on the row", () => {
    const db = openMeshDb(":memory:");
    const worker = spawn(db, { mailbox: "fleet-1" });
    const plain = insertWorker(db, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      pid: 1,
    });

    expect(worker.mailbox).toBe("fleet-1");
    expect(getWorker(db, worker.id)?.mailbox).toBe("fleet-1");
    expect(plain.mailbox).toBeNull();
    db.close();
  });

  it("counts only running enrolled workers for the spawnMax quota", () => {
    const db = openMeshDb(":memory:");
    insertWorker(db, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      pid: 1,
      mailbox: "fleet-1",
    });
    insertWorker(db, { task: "t", worktree_path: "/wt", branch: "b", pid: 2 });
    const stopped = insertWorker(db, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      pid: 3,
      mailbox: "fleet-2",
    });
    setWorkerStatus(db, stopped.id, "stopped");

    // Plain headless workers and terminal enrolled rows do not count.
    expect(countRunningEnrolled(db)).toBe(1);
    db.close();
  });

  it("reapEnrolledPools leaves the pools and keeps the mailbox", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "fleet-1", session_id: "ses-1", now: Date.now() });
    joinPool(db, "fleet-1", "team:x");
    joinPool(db, "fleet-1", "team:y");
    const worker = insertWorker(db, {
      task: "t",
      worktree_path: "/wt",
      branch: "b",
      pid: 1,
      mailbox: "fleet-1",
    });
    setWorkerSession(db, worker.id, "ses-1");

    expect(reapEnrolledPools(db, getWorker(db, worker.id)!)).toEqual(["team:x", "team:y"]);
    expect(mailboxByName(db, "fleet-1")?.pools).toEqual([]);
    expect(mailboxByName(db, "fleet-1")).not.toBeNull();
    db.close();
  });

  it("reapEnrolledPools is a no-op for a plain worker or an unknown mailbox", () => {
    const db = openMeshDb(":memory:");
    const plain = insertWorker(db, { task: "t", worktree_path: "/wt", branch: "b", pid: 1 });

    expect(reapEnrolledPools(db, getWorker(db, plain.id)!)).toEqual([]);
    expect(
      reapEnrolledPools(db, {
        ...plain,
        mailbox: "ghost",
        session_id: null,
      }),
    ).toEqual([]);
    db.close();
  });
});
