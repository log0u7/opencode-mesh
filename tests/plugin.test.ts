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
      "mesh_status",
      "mesh_unlock",
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
