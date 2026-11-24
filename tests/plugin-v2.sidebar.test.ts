import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pluginModule } from "../src/index.js";

// The sidebar default lives in the RPC handler's nothing-persisted answer: the
// TUI store starts collapsed but adopts the RPC state right away, so an
// expanded default there defeated the folded start (fixed in 0.24.4).

const dirs: string[] = [];
const servers: Array<{ close(): void }> = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  for (const s of servers) s.close();
  servers.length = 0;
});

describe("v2 sidebar RPC default", () => {
  it("answers collapsed when nothing is persisted, keeps the user's toggle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-v2-sidebar-"));
    dirs.push(dir);
    const map = new Map<string, unknown>();
    const rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {};
    const ctx = {
      location: {
        directory: "/work/project",
        project: { id: "p1", directory: "/work/project", canonical: "/work/project" },
      },
      worktree: undefined,
      options: {
        dataDir: dir,
        port: 0,
        advertise: false,
        spawnFn: () => ({ pid: -1, kill: async () => {} }) as never,
      },
      tool: {
        transform: async (fn: (editor: { add: (t: never) => void }) => void) =>
          fn({ add: () => {} } as never),
      },
      session: {
        hook: async () => {},
        get: async () => undefined,
        prompt: async () => {},
      },
      event: { subscribe: () => (async function* () {})() },
      storage: {
        get: async (key: string) => map.get(key),
        set: async (key: string, value: unknown) => void map.set(key, value),
      },
      rpc: {
        register: async (
          _id: unknown,
          handlers: Record<string, (input: unknown) => Promise<unknown>>,
        ) => {
          Object.assign(rpcHandlers, handlers);
          return { dispose: async () => {}, events: { emit: async () => {} } };
        },
      },
    };

    const cleanup = await pluginModule.setup(ctx as never);
    try {
      const sidebar = rpcHandlers.sidebar as unknown as (input: object) => Promise<{
        collapsed: boolean;
      }>;
      const set_sidebar = rpcHandlers.set_sidebar as unknown as (input: {
        collapsed: boolean;
      }) => Promise<{ collapsed: boolean }>;

      expect((await sidebar({})).collapsed).toBe(true);
      await set_sidebar({ collapsed: false });
      expect((await sidebar({})).collapsed).toBe(false);
      await set_sidebar({ collapsed: true });
      expect((await sidebar({})).collapsed).toBe(true);
    } finally {
      await cleanup?.();
    }
  });
});
