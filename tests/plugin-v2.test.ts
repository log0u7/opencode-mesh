import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Plugin } from "@opencode/plugin";

import { pluginModule } from "../src/index.js";

const dirs: string[] = [];

function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-v2-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

type AddedTool = {
  name: string;
  execute: (
    input: Record<string, unknown>,
    context: { sessionID: string },
  ) => Promise<{ content?: string }>;
};

function fakeCtx(dataDir: string, extraOptions: Record<string, unknown> = {}) {
  const added: AddedTool[] = [];

  const ctx = {
    location: { directory: "/home/u/project" },
    options: {
      dataDir,
      port: 0, // random OS port
      advertise: false, // no mDNS in tests
      worktreeClient: {
        worktree: {
          create: async () => ({ data: { name: "wt", directory: "/tmp/wt" } }),
          remove: async () => ({ data: null }),
        },
      },
      spawnFn: () => ({ pid: -1, kill: async () => {} }) as never,
      ...extraOptions,
    },
    tool: {
      transform: async (fn: (editor: { add: (t: AddedTool & { id: string }) => void }) => void) =>
        fn({ add: (t) => added.push(t) }),
    },
    session: { hook: async () => {} },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as Plugin.Context;

  return { ctx, added };
}

const TOOL_NAMES = [
  "mesh_status",
  "mesh_pair",
  "mesh_send",
  "mesh_inbox",
  "mesh_lock",
  "mesh_unlock",
  "mesh_spawn",
  "mesh_workers",
  "mesh_worker_logs",
  "mesh_worker_stop",
  "mesh_worker_remove",
].sort();

describe("opencode-mesh v2 setup", () => {
  it("registers the eleven mesh tools", async () => {
    const { ctx, added } = fakeCtx(tmpDataDir());
    const cleanup = await pluginModule.setup(ctx);

    expect(added.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    await cleanup?.();
  });

  it("exposes node identity and pairing offer through the tools", async () => {
    const { ctx, added } = fakeCtx(tmpDataDir());
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    const status = JSON.parse(
      (await byName.get("mesh_status")?.execute({}, { sessionID: "s1" }))?.content ?? "{}",
    );
    expect(status.node_id).toMatch(/^[a-f0-9]{8}-/);
    expect(status.server).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(Array.isArray(status.peers)).toBe(true);

    const offer = (await byName.get("mesh_pair")?.execute({}, { sessionID: "s1" }))?.content ?? "";
    expect(offer).toContain('mesh_pair(node_id="');
    expect(offer).toContain('token="');

    await cleanup?.();
  });

  it("locks, refreshes and unlocks a path (node-scoped ownership)", async () => {
    const { ctx, added } = fakeCtx(tmpDataDir());
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    const locked = (
      await byName.get("mesh_lock")?.execute({ path: "src/a.ts", ttl: 60 }, { sessionID: "s1" })
    )?.content;
    expect(locked).toBe("locked src/a.ts");

    // Same node (any session) refreshes its claim per lib/locks.ts semantics.
    const refreshed = (
      await byName.get("mesh_lock")?.execute({ path: "src/a.ts" }, { sessionID: "s2" })
    )?.content;
    expect(refreshed).toBe("locked src/a.ts");

    const released = (
      await byName.get("mesh_unlock")?.execute({ path: "src/a.ts" }, { sessionID: "s1" })
    )?.content;
    expect(released).toBe("released src/a.ts");

    const unlockAgain = (
      await byName.get("mesh_unlock")?.execute({ path: "src/a.ts" }, { sessionID: "s1" })
    )?.content;
    expect(unlockAgain).toContain("was not locked by this node");

    await cleanup?.();
  });
});
