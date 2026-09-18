import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MeshPlugin } from "../src/plugin.js";
import type { ToolContext } from "@opencode-ai/plugin";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-plugin-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const WORKTREE = "/work/project";

function ctx(): ToolContext {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "build",
    directory: WORKTREE,
    worktree: WORKTREE,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function fakeInput() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: WORKTREE,
    worktree: WORKTREE,
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

describe("mesh plugin", () => {
  it("registers mesh tools and cleans up on dispose", async () => {
    const hooks = await MeshPlugin(fakeInput(), {
      dataDir: dir,
      port: 0,
      advertise: false,
    });

    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "mesh_inbox",
      "mesh_lock",
      "mesh_pair",
      "mesh_send",
      "mesh_spawn",
      "mesh_status",
      "mesh_unlock",
      "mesh_worker_logs",
      "mesh_worker_remove",
      "mesh_worker_stop",
      "mesh_workers",
    ]);

    const status = await hooks.tool?.mesh_status?.execute({}, ctx());
    expect(status).toContain("node");

    await hooks.dispose?.();
  });

  it("locks and unlocks a path from the tool surface", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    const tools = hooks.tool ?? {};

    const locked = await tools.mesh_lock?.execute({ path: "src/api.ts" }, ctx());
    expect(locked).toContain("locked");

    const again = await tools.mesh_lock?.execute({ path: "src/api.ts" }, ctx());
    expect(again).toContain("locked");

    const unlocked = await tools.mesh_unlock?.execute({ path: "src/api.ts" }, ctx());
    expect(unlocked).toContain("released");

    await hooks.dispose?.();
  });

  it("mesh_inbox lists unread messages after delivery", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    const tools = hooks.tool ?? {};

    // Deliver directly through the server-facing store for this test.
    const { receiveMessage } = await import("../src/lib/mail.js");
    const { openMeshDb } = await import("../src/lib/db.js");
    const db = openMeshDb(`${dir}/mesh.db`);
    receiveMessage(db, { from: "node-b", subject: "handoff", body: "done" });

    const inbox = await tools.mesh_inbox?.execute({}, ctx());
    expect(inbox).toContain("handoff");

    db.close();
    await hooks.dispose?.();
  });
});

describe("mesh plugin tool branches", () => {
  it("mesh_pair completes with a token and mesh_send reports unknown peers", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    const tools = hooks.tool ?? {};

    const paired = await tools.mesh_pair?.execute(
      { node_id: "peer-remote", token: "tok", address: "127.0.0.1:4399" },
      ctx("s1"),
    );
    expect(paired).toBe("paired with peer-remote");

    const missing = await tools.mesh_send?.execute(
      { peer: "ghost", subject: "s", body: "b" },
      ctx("s1"),
    );
    expect(missing).toContain("no paired peer");

    await hooks.dispose?.();
  });

  it("mesh_send reports peers without addresses and mesh_unlock on unlocked path", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    const tools = hooks.tool ?? {};

    // Pair through the token flow, without an address: sendable but unreachable list.
    const offer = String(await tools.mesh_pair?.execute({}, ctx("s1")));
    const token = /token="([^"]+)"/.exec(offer)?.[1];
    const nodeId = /node_id="([^"]+)"/.exec(offer)?.[1];
    await tools.mesh_pair?.execute({ node_id: nodeId, token }, ctx("s1"));
    // The just-paired peer has no address until announce/discovery fills it.
    const noAddress = await tools.mesh_send?.execute(
      { peer: nodeId, subject: "s", body: "b" },
      ctx("s1"),
    );
    expect(noAddress).toContain("no known address");

    const notLocked = await tools.mesh_unlock?.execute({ path: "never-locked.ts" }, ctx("s1"));
    expect(notLocked).toContain("was not locked");

    await hooks.dispose?.();
  });

  it("mesh_inbox with ack=false keeps messages unread", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    const tools = hooks.tool ?? {};
    const { receiveMessage } = await import("../src/lib/mail.js");
    const { openMeshDb } = await import("../src/lib/db.js");
    const db = openMeshDb(`${dir}/mesh.db`);
    receiveMessage(db, { from: "node-b", subject: "keep", body: "unread please" });

    const first = await tools.mesh_inbox?.execute({ ack: false }, ctx("s1"));
    expect(first).toContain("keep");
    const second = await tools.mesh_inbox?.execute({ ack: false }, ctx("s1"));
    expect(second).toContain("keep");

    db.close();
    await hooks.dispose?.();
  });
});
