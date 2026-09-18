import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import {
  getWorker,
  listWorkers,
  setWorkerSession,
  setWorkerStatus,
  upsertWorker,
} from "../src/lib/workers.js";

function spawn(db: ReturnType<typeof openMeshDb>, overrides: Record<string, unknown> = {}) {
  return upsertWorker(db, {
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

  it("rejects transitions from a terminal state", () => {
    const db = openMeshDb(":memory:");
    spawn(db);
    setWorkerStatus(db, "w1", "failed", { exit_code: 1 });

    expect(() => setWorkerStatus(db, "w1", "running")).toThrow(/terminal/);
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
