import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { pluginModule } from "../src/index.js";
import { pairWithToken } from "../src/lib/peers.js";
import { openMeshDb } from "../src/lib/db.js";

// Regression: the v2 adapter MUST pass the fanout to the tools — without it,
// local broadcasts with no local recipients error instead of forwarding
// (the pool federation silently died for tool-originated broadcasts).

const dirs: string[] = [];
const servers: Array<{ close(): void }> = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  for (const s of servers) s.close();
  servers.length = 0;
});

function input() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: "/work/project",
    worktree: "/work/project",
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

describe("v2 fanout wiring", () => {
  it("forwards an empty-local broadcast to the paired peer", async () => {
    // Fake remote peer: GET /pools advertises a member; POST /mail records.
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/pools") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ pools: { "team:x": ["far-member"] } }));
          return;
        }
        if (req.url === "/mail") {
          received.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    servers.push(server);

    const dir = mkdtempSync(join(tmpdir(), "mesh-v2-fanout-"));
    dirs.push(dir);
    const { ctx, added, rpcHandlers } = (() => {
      // Reuse the v2 fakeCtx from plugin-v2.test.ts shape (minimal inline).
      const addedTools: Array<{
        name: string;
        execute: (
          args: Record<string, unknown>,
          context: { sessionID: string },
        ) => Promise<{ content?: string }>;
      }> = [];
      const rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {};
      const prompts: string[] = [];
      const ctxObj = {
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
            fn({ add: (t: never) => addedTools.push(t as never) } as never),
        },
        session: {
          hook: async () => {},
          get: async (i: { sessionID: string }) =>
            i.sessionID === "s1" ? { sessionID: i.sessionID } : undefined,
          prompt: async () => {},
        },
        event: { subscribe: () => (async function* () {})() },
        storage: { get: async () => undefined, set: async () => {} },
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
      return { ctx: ctxObj, added: addedTools, rpcHandlers, prompts };
    })();

    const cleanup = await pluginModule.setup(ctx as never);

    // Bind (TUI mount) so sessionKnown passes, then register + join.
    await rpcHandlers.bind?.({ sessionID: "s1" });
    const register = added.find((t) => t.name === "mesh_register");
    await register?.execute({ name: "local", role: "pair" }, { sessionID: "s1" });
    const joinTool = added.find((t) => t.name === "mesh_join");
    await joinTool?.execute({ pool: "team:x" }, { sessionID: "s1" });

    // Pair the fake peer (address = the recording server).
    const pairDb = openMeshDb(join(dir, "mesh.db"));
    pairWithToken(pairDb, {
      node_id: "peer-far",
      hostname: "far",
      fingerprint: "ff",
      token: "tok-far",
      addresses: [`127.0.0.1:${port}`],
    });
    pairDb.close();

    const send = added.find((t) => t.name === "mesh_send");
    const raw = await send?.execute(
      { to: "team:x", subject: "status: federation", body: "hello far" },
      { sessionID: "s1" },
    );
    const out = typeof raw === "string" ? raw : (raw?.content ?? "{}");
    const parsed = JSON.parse(out) as { recipients: string[]; forwarded: string[] };
    expect(parsed.recipients).toEqual([]);
    expect(parsed.forwarded).toEqual(["peer-far"]);
    expect(received).toHaveLength(1);
    expect(received[0]?.to).toBe("team:x");
    expect(String(received[0]?.origin_id)).toBeTruthy();

    await cleanup?.();
  });
});

// NOTE: the bind-no-steal semantics get their own describe here because the
// fakeCtx already wires sessionsSeen via tool calls and bind.

describe("bind no-steal", () => {
  it("recovers dead bindings but never steals a live tab's hat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-bind-nosteal-"));
    dirs.push(dir);
    const tools: Array<{
      name: string;
      execute: (
        args: Record<string, unknown>,
        context: { sessionID: string },
      ) => Promise<{ content?: string }>;
    }> = [];
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
          fn({ add: (t: never) => tools.push(t as never) } as never),
      },
      session: { hook: async () => {}, get: async () => undefined, prompt: async () => {} },
      event: { subscribe: () => (async function* () {})() },
      storage: { get: async () => undefined, set: async () => {} },
      rpc: {
        register: async (
          _id: unknown,
          handlers: Record<string, (input: unknown) => Promise<unknown>>,
        ) => {
          Object.assign(rpcHandlers, handlers);
          return { dispose: async () => {}, events: { emit: async () => {} } };
        },
      },
    } as unknown as Parameters<typeof pluginModule.setup>[0];

    const cleanup = await pluginModule.setup(ctx);

    // Tab A registers its hat and runs a tool → hat-a bound to tab-a, seen.
    const registerTool = tools.find((t) => t.name === "mesh_register");
    await registerTool?.execute({ name: "hat-a" }, { sessionID: "tab-a" });

    // Tab B (another tab of the same TUI) binds on switch.
    await rpcHandlers.bind?.({ sessionID: "tab-b" });

    const meshDb = openMeshDb(join(dir, "mesh.db"));
    const hatA = meshDb.conn.get<{ session_id: string }>(
      "SELECT session_id FROM mailboxes WHERE name = 'hat-a'",
    );
    // Live tab keeps its hat.
    expect(hatA?.session_id).toBe("tab-a");

    // A box bound to a DEAD (never-seen) session gets recovered by the bind.
    meshDb.conn.run(
      "INSERT INTO mailboxes (name, session_id, role, pools, bind_key, last_seen, created_at) VALUES ('hat-dead', 'ses-dead', 'pair', '[]', 'p1:/work/project', 0, 0)",
    );
    await rpcHandlers.bind?.({ sessionID: "tab-c" });
    const hatDead = meshDb.conn.get<{ session_id: string }>(
      "SELECT session_id FROM mailboxes WHERE name = 'hat-dead'",
    );
    expect(hatDead?.session_id).toBe("tab-c");
    meshDb.close();

    await cleanup?.();
  });
});
