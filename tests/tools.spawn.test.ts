import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb, type MeshDb } from "../src/lib/db.js";
import type { NodeIdentity } from "../src/lib/identity.js";
import { joinPool, mailboxByName, registerMailbox } from "../src/lib/mail.js";
import type { SpawnFn, SpawnedProcess } from "../src/lib/spawn.js";
import type { WorktreeClient } from "../src/lib/worktree.js";
import { listWorkers } from "../src/lib/workers.js";
import { buildToolSpecs, type MeshContext, type ToolSpec } from "../src/tools.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-tspawn-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A hanging fake that records what the child was given.
function captureSpawn(): {
  spawnFn: SpawnFn;
  calls: Array<{ argv: string[]; env?: Record<string, string> }>;
} {
  const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
  const spawnFn: SpawnFn = (argv, env) => {
    calls.push({ argv, ...(env !== undefined ? { env } : {}) });
    return {
      pid: 4242,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    } as unknown as SpawnedProcess;
  };
  return { spawnFn, calls };
}

// A never-spawning fake: pid -1, the real ENOENT shape.
function failingSpawn(): SpawnFn {
  return () =>
    ({
      pid: -1,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    }) as unknown as SpawnedProcess;
}

function recordingWorktreeClient(): {
  client: WorktreeClient;
  creates: Array<unknown>;
  removes: Array<unknown>;
} {
  const creates: Array<unknown> = [];
  const removes: Array<unknown> = [];
  const client: WorktreeClient = {
    worktree: {
      create: async (parameters) => {
        creates.push(parameters.worktreeCreateInput);
        const name = parameters.worktreeCreateInput?.name;
        return { data: { name, branch: `wt/${name ?? "x"}`, directory: `/tmp/wt-${name ?? "x"}` } };
      },
      remove: async (parameters) => {
        removes.push(parameters.worktreeRemoveInput);
        return { data: true };
      },
    },
  };
  return { client, creates, removes };
}

function setup(input: {
  spawnFn: SpawnFn;
  worktreeClient: WorktreeClient;
  spawnWorkspace?: string;
  spawnMax?: number;
}) {
  const db: MeshDb = openMeshDb(":memory:");
  const mesh: MeshContext = {
    db,
    identity: { node_id: "n1" } as NodeIdentity,
    dataDir: dir,
    serverAddress: "127.0.0.1",
    port: 4399,
    bindKey: "test-project:/work/project",
    worktreeClient: input.worktreeClient,
    spawnFn: input.spawnFn,
    ...(input.spawnWorkspace !== undefined ? { spawnWorkspace: input.spawnWorkspace } : {}),
    ...(input.spawnMax !== undefined ? { spawnMax: input.spawnMax } : {}),
  };
  const specs = new Map<string, ToolSpec>(buildToolSpecs(mesh).map((s) => [s.name, s]));
  const call = (
    name: string,
    args: Record<string, unknown> = {},
    sessionID = "s1",
  ): Promise<string> => specs.get(name)!.execute(args, { sessionID });
  return { db, call };
}

describe("mesh_spawn workspace colleague (0.25.0)", () => {
  it("births the enrolled child in the workspace: no worktree created, cwd = spawnWorkspace", async () => {
    const workspace = join(dir, "fleet");
    mkdirSync(workspace, { recursive: true });
    const spawned = captureSpawn();
    const wt = recordingWorktreeClient();
    const { db, call } = setup({
      spawnFn: spawned.spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: workspace,
    });

    const out = await call("mesh_spawn", {
      task: "greet the fleet",
      name: "colleague",
      role: "reviewer",
      pools: ["team:x"],
    });
    const result = JSON.parse(out) as {
      worker_id: string;
      workspace: string;
      mailbox: string;
      worktree?: string;
    };

    expect(result.workspace).toBe(workspace);
    expect(result.mailbox).toBe("colleague");
    expect(result.worktree).toBeUndefined();
    // The child opencode runs with cwd = the workspace directory.
    expect(spawned.calls[0]?.argv.slice(1, 4)).toEqual(["run", "--dir", workspace]);
    expect(spawned.calls[0]?.env?.OPENCODE_MESH_CHILD).toBe("enrolled");
    // No project machinery: the worktree client is never touched.
    expect(wt.creates).toHaveLength(0);
    expect(wt.removes).toHaveLength(0);
    // The row carries the workspace sentinel so a later remove stays safe.
    const row = listWorkers(db)[0];
    expect(row?.branch).toBe("workspace");
    expect(row?.worktree_path).toBe(workspace);
    db.close();
  });

  it("refuses with the explicit remedy when the workspace directory does not exist", async () => {
    const missing = join(dir, "no-fleet");
    const spawned = captureSpawn();
    const wt = recordingWorktreeClient();
    const { db, call } = setup({
      spawnFn: spawned.spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: missing,
    });

    const out = await call("mesh_spawn", { task: "t", name: "colleague" });

    expect(out).toBe(
      `error: spawn workspace ${missing} does not exist — create it or set spawnWorkspace`,
    );
    expect(spawned.calls).toHaveLength(0);
    expect(wt.creates).toHaveLength(0);
    expect(listWorkers(db)).toHaveLength(0);
    db.close();
  });

  it("opts back into the project worktree machinery with project=", async () => {
    const workspace = join(dir, "fleet");
    mkdirSync(workspace, { recursive: true });
    const spawned = captureSpawn();
    const wt = recordingWorktreeClient();
    const { db, call } = setup({
      spawnFn: spawned.spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: workspace,
    });

    const out = await call("mesh_spawn", { task: "fix the bug", name: "coder", project: "/repo" });
    const result = JSON.parse(out) as { worker_id: string; worktree: string; workspace?: string };

    expect(result.worktree).toBe("/tmp/wt-coder");
    expect(result.workspace).toBeUndefined();
    expect(wt.creates).toHaveLength(1);
    expect(spawned.calls[0]?.argv.slice(1, 4)).toEqual(["run", "--dir", "/tmp/wt-coder"]);
    expect(listWorkers(db)[0]?.branch).toBe("wt/coder");
    db.close();
  });

  it("keeps the plain headless worker on the worktree path (back-compat)", async () => {
    const spawned = captureSpawn();
    const wt = recordingWorktreeClient();
    const { db, call } = setup({
      spawnFn: spawned.spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: join(dir, "fleet"),
    });

    const out = await call("mesh_spawn", { task: "summarize the README" });
    const result = JSON.parse(out) as { worker_id: string; worktree: string; mailbox?: string };

    expect(result.mailbox).toBeUndefined();
    expect(result.worktree).toBe("/tmp/wt-x");
    expect(wt.creates).toHaveLength(1);
    expect(spawned.calls[0]?.env?.OPENCODE_MESH_CHILD).toBe("1");
    expect(listWorkers(db)[0]?.mailbox).toBeNull();
    db.close();
  });

  it("fails cleanly: no worktree to strand, row and log dropped", async () => {
    const workspace = join(dir, "fleet");
    mkdirSync(workspace, { recursive: true });
    const wt = recordingWorktreeClient();
    const { db, call } = setup({
      spawnFn: failingSpawn(),
      worktreeClient: wt.client,
      spawnWorkspace: workspace,
    });

    const out = await call("mesh_spawn", { task: "t", name: "ghost" });

    expect(out).toMatch(/^error: worker \S+ failed to start$/);
    expect(wt.creates).toHaveLength(0);
    expect(wt.removes).toHaveLength(0);
    expect(listWorkers(db)).toHaveLength(0);
    db.close();
  });

  it("keeps the spawnMax quota enforced before the workspace spawn", async () => {
    const workspace = join(dir, "fleet");
    mkdirSync(workspace, { recursive: true });
    const spawned = captureSpawn();
    const wt = recordingWorktreeClient();
    const { call } = setup({
      spawnFn: spawned.spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: workspace,
      spawnMax: 1,
    });

    const first = JSON.parse(await call("mesh_spawn", { task: "t", name: "one" })) as {
      worker_id: string;
    };
    expect(first.worker_id).toBeTruthy();
    expect(await call("mesh_spawn", { task: "t", name: "two" })).toBe(
      "error: spawn limit 1 reached, reap one first",
    );
  });
});

describe("mesh_worker_remove of a workspace colleague (0.25.0)", () => {
  it("deletes the row and reaps pools WITHOUT handing the workspace to the worktree API", async () => {
    const workspace = join(dir, "fleet");
    mkdirSync(workspace, { recursive: true });
    const spawned = captureSpawn();
    const wt = recordingWorktreeClient();
    const { db, call } = setup({
      spawnFn: spawned.spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: workspace,
    });

    const spawn = JSON.parse(await call("mesh_spawn", { task: "t", name: "colleague" })) as {
      worker_id: string;
    };
    // The child enrolled and joined pools (simulated on the shared db).
    registerMailbox(db, { name: "colleague", session_id: "ses-1", now: Date.now() });
    joinPool(db, "colleague", "team:x");

    const out = await call("mesh_worker_remove", { worker_id: spawn.worker_id, force: true });

    expect(out).toContain("removed");
    expect(out).toContain("the workspace directory stays");
    // The shared workspace was NEVER passed to the worktree API: a remove
    // there would ask opencode to delete fleet property.
    expect(wt.removes).toHaveLength(0);
    expect(listWorkers(db)).toHaveLength(0);
    // The mailbox survives; only the pools are shed.
    const box = mailboxByName(db, "colleague");
    expect(box).not.toBeNull();
    expect(box?.pools).toEqual([]);
    db.close();
  });

  it("still removes the worktree of a project-opt-in worker", async () => {
    const spawned = captureSpawn();
    const wt = recordingWorktreeClient();
    const { db, call } = setup({
      spawnFn: spawned.spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: join(dir, "fleet"),
    });

    const spawn = JSON.parse(
      await call("mesh_spawn", { task: "t", name: "coder", project: "/repo" }),
    ) as { worker_id: string };

    const out = await call("mesh_worker_remove", { worker_id: spawn.worker_id, force: true });

    expect(out).toContain("removed");
    expect(wt.removes).toEqual([{ directory: "/tmp/wt-coder" }]);
    expect(listWorkers(db)).toHaveLength(0);
    db.close();
  });
});

describe("mesh_worker_logs of a workspace colleague", () => {
  it("reads the tail from the shared dataDir like any worker", async () => {
    const workspace = join(dir, "fleet");
    mkdirSync(workspace, { recursive: true });
    const { spawnFn } = captureSpawn();
    const wt = recordingWorktreeClient();
    const { call } = setup({
      spawnFn,
      worktreeClient: wt.client,
      spawnWorkspace: workspace,
    });

    const spawn = JSON.parse(await call("mesh_spawn", { task: "t", name: "colleague" })) as {
      worker_id: string;
    };
    // No log output yet: the tool answers with its standard line.
    expect(await call("mesh_worker_logs", { worker_id: spawn.worker_id })).toBe(
      "no log output yet",
    );
  });
});
