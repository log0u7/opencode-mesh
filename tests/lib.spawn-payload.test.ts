import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { postSpawn } from "../src/lib/client.js";
import { loadOrCreateIdentity } from "../src/lib/identity.js";
import { pairWithToken } from "../src/lib/peers.js";
import type { SpawnFn, SpawnedProcess } from "../src/lib/spawn.js";
import type { WorktreeClient } from "../src/lib/worktree.js";
import { buildToolSpecs, type ToolSpec } from "../src/tools.js";

// The wire body of every distant spawn POST, captured instead of sent.
const CAPTURED = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock("../src/lib/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/client.js")>();
  return {
    ...actual,
    postSpawn: async (target: { url: string; body: string }) => {
      CAPTURED.bodies.push(target.body);
      return { kind: "ok", worker_id: "w-wire", hostname: "host-b" };
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-payload-"));
});

afterEach(() => {
  CAPTURED.bodies.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

function fakeSpawnFn(): SpawnFn {
  return (): SpawnedProcess => ({
    pid: 4242,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  });
}

function fakeWorktreeClient(): WorktreeClient {
  return {
    worktree: {
      create: async (parameters) => {
        const name = parameters.worktreeCreateInput?.name;
        return {
          data: {
            name,
            branch: `wt/${name ?? "x"}`,
            directory: `/tmp/wt-${name ?? "x"}`,
          },
        };
      },
      remove: async () => ({ data: true }),
    },
  };
}

function tools(projectID?: string) {
  const identity = loadOrCreateIdentity(join(dir, "a"));
  const db = openMeshDb(":memory:");
  // A paired peer to target; the request never leaves (postSpawn is mocked).
  pairWithToken(db, {
    node_id: "node-b",
    hostname: "host-b",
    fingerprint: "fB",
    token: "tok",
    addresses: ["127.0.0.1:1"],
    public_key: loadOrCreateIdentity(join(dir, "b")).public_key,
  });
  const specs = new Map<string, ToolSpec>(
    buildToolSpecs({
      db,
      identity,
      dataDir: dir,
      serverAddress: "127.0.0.1",
      port: 0,
      bindKey: "test-bind",
      worktreeClient: fakeWorktreeClient(),
      spawnFn: fakeSpawnFn(),
      ...(projectID !== undefined ? { projectID } : {}),
    }).map((s) => [s.name, s]),
  );
  return (name: string, args: Record<string, unknown> = {}): Promise<string> =>
    specs.get(name)!.execute(args, { sessionID: "s-a" });
}

const TASK = "implement the parser";
const NAME = "parser";
const PARENT_PROJECT = "proj-parent-9f";

describe("distant spawn payload (0.27.0)", () => {
  it("keeps a session-mode payload spec-only: the parent's projectID stays off the wire", async () => {
    const call = tools(PARENT_PROJECT);
    const out = await call("mesh_spawn", { task: TASK, name: NAME, node: "host-b" });
    expect(JSON.parse(out).worker_id).toBe("w-wire");
    expect(CAPTURED.bodies).toHaveLength(1);
    const body = JSON.parse(CAPTURED.bodies[0]!) as { projectID?: unknown; spec: { task: string } };
    // The default spawn carries NO project: the payload is the spec alone,
    // verifiable by a legacy receiver that knows nothing of project ids.
    expect(body.projectID).toBeUndefined();
    expect(body.spec.task).toBe(TASK);
  });

  it("signs the projectID only when the spawn names a project (project/worktree opt-in)", async () => {
    const call = tools(PARENT_PROJECT);
    await call("mesh_spawn", {
      task: TASK,
      name: NAME,
      node: "host-b",
      project: "/repo/parent",
    });
    expect(CAPTURED.bodies).toHaveLength(1);
    const body = JSON.parse(CAPTURED.bodies[0]!) as {
      projectID?: unknown;
      spec: { project?: string };
    };
    expect(body.spec.project).toBe("/repo/parent");
    expect(body.projectID).toBe(PARENT_PROJECT);
  });
});
