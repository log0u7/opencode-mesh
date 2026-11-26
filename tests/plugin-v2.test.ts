import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";

import { pluginModule } from "../src/index.js";
import { sendMail } from "../src/lib/client.js";
import { openMeshDb } from "../src/lib/db.js";
import { pairWithToken } from "../src/lib/peers.js";
import { loadOrCreateIdentity } from "../src/lib/identity.js";
import { buildTlsMaterial, certPkSpki } from "../src/lib/tls.js";
import { deliverMessage, registerMailbox } from "../src/lib/mail.js";
import { MESH_GUIDANCE } from "../src/lib/guidance.js";

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

// A worker process that reports nothing and exits cleanly, so mesh_spawn
// returns a success envelope without waiting on any real child.
function okSpawn() {
  const exitListeners: Array<(code: number | null) => void> = [];
  const proc = {
    pid: 2222,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event: string, cb: (code: number | null) => void) => {
      if (event === "exit") exitListeners.push(cb);
    },
    kill: () => {},
  };
  queueMicrotask(() => {
    for (const cb of exitListeners) cb(0);
  });
  return proc as never;
}

function fakeCtx(
  dataDir: string,
  overrides: {
    options?: Record<string, unknown>;
    worktree?: unknown;
    /** Host session list (ctx.session.list, @opencode/plugin >= 2.3). */
    sessionList?: (input: { cursor?: string }) => Promise<unknown>;
  } = {},
) {
  const added: AddedTool[] = [];
  const rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  const prompts: string[] = [];
  const promptInputs: Array<Record<string, unknown>> = [];
  const hookRegistrations: Array<{ name: string; callback: (input: never) => void }> = [];

  const ctx = {
    location: {
      directory: "/home/u/project",
      project: {
        id: "proj-1",
        directory: "/home/u/project",
        canonical: "/home/u/project",
      },
    },
    worktree: overrides.worktree,
    options: {
      dataDir,
      port: 0, // random OS port
      advertise: false, // no mDNS in tests
      worktreeClient: {
        worktree: {
          create: async () => ({ data: { name: "wt", directory: "/tmp/wt" } }),
          remove: async () => ({ data: true }),
        },
      },
      spawnFn: () => ({ pid: -1, kill: async () => {} }) as never,
      ...overrides.options,
    },
    tool: {
      transform: async (fn: (editor: { add: (t: AddedTool & { id: string }) => void }) => void) =>
        fn({ add: (t) => added.push(t) }),
    },
    session: {
      hook: async (name: string, callback: (input: never) => void) => {
        hookRegistrations.push({ name, callback });
        return { dispose: async () => {} };
      },
      get: vi.fn(async (input: { sessionID: string }) =>
        input.sessionID === "s1" ? { sessionID: input.sessionID } : undefined,
      ),
      prompt: vi.fn(async (input: { sessionID: string; text: string; id?: string }) => {
        prompts.push(input.text);
        promptInputs.push({ ...input });
      }),
      ...(overrides.sessionList !== undefined ? { list: overrides.sessionList } : {}),
    },
    event: { subscribe: () => (async function* () {})() },
    storage: {
      get: async () => undefined,
      set: async () => {},
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
  } as unknown as Plugin.Context;

  return { ctx, added, rpcHandlers, prompts, promptInputs, hookRegistrations };
}

const TOOL_NAMES = [
  "mesh_ask",
  "mesh_inbox",
  "mesh_join",
  "mesh_journal",
  "mesh_leave",
  "mesh_lock",
  "mesh_pair",
  "mesh_pools",
  "mesh_register",
  "mesh_reply",
  "mesh_send",
  "mesh_spawn",
  "mesh_status",
  "mesh_tasks",
  "mesh_unlock",
  "mesh_worker_logs",
  "mesh_worker_remove",
  "mesh_worker_stop",
  "mesh_workers",
].sort();

describe("opencode-mesh v2 setup", () => {
  it("exposes host capabilities through the RPC snapshot", async () => {
    const { ctx, rpcHandlers } = fakeCtx(tmpDataDir());
    const cleanup = await pluginModule.setup(ctx);
    const snap = (await rpcHandlers.snapshot?.({ sessionID: "s1" })) as {
      capa?: { cpu: { cores: number }; sessionsRunning: number };
    };
    expect(snap.capa?.cpu.cores).toBeGreaterThan(0);
    expect(snap.capa?.sessionsRunning).toBe(0);
    await cleanup?.();
  });

  it("registers the mesh tools", async () => {
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

  it("rejects invalid options before opening the server (fail-fast)", async () => {
    const { ctx } = fakeCtx(tmpDataDir(), { options: { port: -1 } });

    await expect(pluginModule.setup(ctx)).rejects.toThrow(/port/);
  });

  describe("child processes", () => {
    const previous = process.env.OPENCODE_MESH_CHILD;

    afterEach(() => {
      if (previous === undefined) {
        delete process.env.OPENCODE_MESH_CHILD;
      } else {
        process.env.OPENCODE_MESH_CHILD = previous;
      }
    });

    it("registers no tools as a headless child", async () => {
      process.env.OPENCODE_MESH_CHILD = "1";
      const { ctx, added } = fakeCtx(tmpDataDir());
      const cleanup = await pluginModule.setup(ctx);

      expect(added).toEqual([]);
      await cleanup?.();
    });

    it("registers the mesh tools as an enrolled child, with no server of its own", async () => {
      process.env.OPENCODE_MESH_CHILD = "enrolled";
      const { ctx, added } = fakeCtx(tmpDataDir());
      const cleanup = await pluginModule.setup(ctx);

      // Fleet agent: the worker surface (0.30.0) — the orchestration tools
      // stay off a worker's skin (mesh_spawn, mesh_pair, mesh_worker_*):
      // a worker registers, drains, waits, replies and reads the journal.
      // The setup never touched ctx.session, ctx.rpc or ctx.event (no wake
      // loop, no rpc, no guidance — a one-shot worker needs none).
      const workerToolNames = added.map((t) => t.name).sort();
      for (const blocked of [
        "mesh_spawn",
        "mesh_pair",
        "mesh_workers",
        "mesh_worker_logs",
        "mesh_worker_stop",
        "mesh_worker_remove",
      ]) {
        expect(workerToolNames).not.toContain(blocked);
      }
      for (const required of [
        "mesh_register",
        "mesh_ask",
        "mesh_inbox",
        "mesh_ask",
        "mesh_reply",
        "mesh_tasks",
        "mesh_send",
        "mesh_journal",
      ]) {
        expect(workerToolNames).toContain(required);
      }
      await cleanup?.();
    });
  });

  it("mesh_spawn spawns through the injected options.worktreeClient", async () => {
    const create = vi.fn(async () => ({ data: { name: "wt", directory: "/tmp/wt" } }));
    const { ctx, added } = fakeCtx(tmpDataDir(), {
      options: {
        worktreeClient: { worktree: { create, remove: async () => ({ data: true }) } },
        spawnFn: okSpawn,
      },
    });
    const cleanup = await pluginModule.setup(ctx);
    const spawn = added.find((t) => t.name === "mesh_spawn");

    const out = (await spawn?.execute({ task: "t" }, { sessionID: "s1" }))?.content ?? "";
    const parsed = JSON.parse(out) as { worker_id: string; worktree: string };

    expect(create).toHaveBeenCalledWith(
      { worktreeCreateInput: {} },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(parsed.worker_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(parsed.worktree).toBe("/tmp/wt");

    await cleanup?.();
  });

  it("mesh_spawn falls back to the flat, project-scoped v2 ctx.worktree domain", async () => {
    const domain = {
      create: vi.fn(async () => ({ directory: "/v2/wt2" })),
      remove: vi.fn(async () => {}),
    };
    const { ctx, added } = fakeCtx(tmpDataDir(), {
      options: { worktreeClient: undefined, spawnFn: okSpawn },
      worktree: domain,
    });
    const cleanup = await pluginModule.setup(ctx);
    const spawn = added.find((t) => t.name === "mesh_spawn");

    const out = (await spawn?.execute({ task: "t" }, { sessionID: "s1" }))?.content ?? "";
    const parsed = JSON.parse(out) as { worker_id: string; worktree: string; branch: string };

    expect(domain.create).toHaveBeenCalledWith({ projectID: "proj-1" });
    expect(parsed.worktree).toBe("/v2/wt2");
    expect(parsed.branch).toBe("wt2");

    await cleanup?.();
  });

  it("wakes an idle restarted session via dynamic instance binding (no static config)", async () => {
    const dir = tmpDataDir();
    const { ctx, added, rpcHandlers, prompts, promptInputs } = fakeCtx(dir, {
      options: { wakeIntervalMs: 20 },
    });
    const cleanup = await pluginModule.setup(ctx as never);

    // The agent registered its mailbox in an earlier turn: mesh_register
    // stamps the instance binding key (project id + directory).
    const register = added.find((t) => t.name === "mesh_register");
    await register?.execute({ name: "a", role: "pair" }, { sessionID: "s-old" });

    // The session restarts; the TUI binds the new session id and the box
    // follows it (same project key) — no config, no re-registration needed.
    await rpcHandlers.bind?.({ sessionID: "s1" });

    const meshStatus = added.find((t) => t.name === "mesh_status");
    const rawStatus = await meshStatus?.execute({}, { sessionID: "s1" });
    const statusOut = JSON.parse(
      typeof rawStatus === "string" ? rawStatus : (rawStatus?.content ?? "{}"),
    ) as { server: string; mailboxes: Array<{ name: string; session_id?: string }> };
    expect(statusOut.mailboxes[0]?.name).toBe("a");

    // Pair a remote node so the TLS mail authenticates, then deliver from
    // OUTSIDE this process: no tool call may run before the wake.
    const pairDb = openMeshDb(join(dir, "mesh.db"));
    pairWithToken(pairDb, {
      node_id: "node-x",
      hostname: "x",
      fingerprint: "fx",
      token: "tok-x",
    });
    pairDb.close();

    const sendResult = await sendMail({
      url: `https://${statusOut.server}`,
      tls: true,
      pk: certPkSpki(buildTlsMaterial(loadOrCreateIdentity(dir)).certPem),
      token: "tok-x",
      from: "node-x",
      subject: "ping",
      body: "wake up",
      to: "a",
    });
    expect(sendResult).toBe("ok");

    for (let i = 0; i < 60 && prompts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(prompts.some((t) => t.includes('mesh: 1 unread — "ping"'))).toBe(true);

    // The transport-retry idempotency key (0.28.1): the prompt input carries
    // the generated id under the key the server reads (`id`), so a retried
    // call reconciles to the same message instead of spawning a ghost turn.
    expect(promptInputs.length).toBeGreaterThan(0);
    for (const input of promptInputs) {
      expect(input.id).toMatch(/^msg_/);
    }

    await cleanup?.();
  });

  it("applies the static mailbox option at bind, winning role collisions (last act)", async () => {
    const { ctx, added, rpcHandlers } = fakeCtx(tmpDataDir(), {
      options: { mailbox: "shared", mailboxRole: "configured" },
    });
    const cleanup = await pluginModule.setup(ctx as never);

    // Dynamic registration under the same name with a different role.
    const register = added.find((t) => t.name === "mesh_register");
    await register?.execute({ name: "shared", role: "dynamic-role" }, { sessionID: "s-old" });

    await rpcHandlers.bind?.({ sessionID: "s1" });

    const meshStatus = added.find((t) => t.name === "mesh_status");
    const rawStatus = await meshStatus?.execute({}, { sessionID: "s1" });
    const statusOut = JSON.parse(
      typeof rawStatus === "string" ? rawStatus : (rawStatus?.content ?? "{}"),
    ) as { mailboxes: Array<{ name: string; role: string | null }> };
    expect(statusOut.mailboxes).toHaveLength(1);
    expect(statusOut.mailboxes[0]?.name).toBe("shared");
    expect(statusOut.mailboxes[0]?.role).toBe("configured");

    await cleanup?.();
  });

  it("keeps the dynamic binding when no static mailbox is configured", async () => {
    const { ctx, added, rpcHandlers } = fakeCtx(tmpDataDir(), {});
    const cleanup = await pluginModule.setup(ctx as never);

    const register = added.find((t) => t.name === "mesh_register");
    await register?.execute({ name: "dyn", role: "pair" }, { sessionID: "s-old" });
    await rpcHandlers.bind?.({ sessionID: "s1" });

    const meshStatus = added.find((t) => t.name === "mesh_status");
    const rawStatus = await meshStatus?.execute({}, { sessionID: "s1" });
    const statusOut = JSON.parse(
      typeof rawStatus === "string" ? rawStatus : (rawStatus?.content ?? "{}"),
    ) as { mailboxes: Array<{ name: string; role: string | null }> };
    expect(statusOut.mailboxes).toHaveLength(1);
    expect(statusOut.mailboxes[0]?.name).toBe("dyn");
    expect(statusOut.mailboxes[0]?.role).toBe("pair");

    await cleanup?.();
  });

  // The 0.14.0 regression: opencode 2.4.0 TUI plugins require @opentui >=
  // 0.9.4, so the tab-render bind could stop firing and sessionsSeen (in
  // memory) stayed empty — idle sessions were never woken. sessionKnown must
  // come from the HOST's session list, not from what this instance saw.
  it("wakes an idle session known only through the host session list (no tool call, no bind)", async () => {
    const dir = tmpDataDir();
    const { ctx, prompts } = fakeCtx(dir, {
      options: { wakeIntervalMs: 20 },
      sessionList: async () => ({ data: [{ id: "s1" }], cursor: {} }),
    });
    const cleanup = await pluginModule.setup(ctx as never);

    // Register the mailbox and deliver mail WITHOUT any tool call and
    // without rpc.bind: sessionsSeen stays empty on purpose.
    const db = openMeshDb(join(dir, "mesh.db"));
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    db.close();

    await vi.waitFor(
      () => {
        expect(prompts.some((t) => t.includes('mesh: 1 unread — "s"'))).toBe(true);
      },
      { timeout: 5000 },
    );

    await cleanup?.();
  });

  it("stays silent when the host session list does not know the bound session", async () => {
    const dir = tmpDataDir();
    const { ctx, prompts } = fakeCtx(dir, {
      options: { wakeIntervalMs: 20 },
      sessionList: async () => ({ data: [], cursor: {} }),
    });
    const cleanup = await pluginModule.setup(ctx as never);

    const db = openMeshDb(join(dir, "mesh.db"));
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    db.close();

    await new Promise((r) => setTimeout(r, 200));
    expect(prompts).toHaveLength(0);

    await cleanup?.();
  });

  it("injects the standing anti-narration guidance through the session context hook", async () => {
    const { ctx, hookRegistrations } = fakeCtx(tmpDataDir(), {});
    const cleanup = await pluginModule.setup(ctx as never);

    const contextHook = hookRegistrations.find((h) => h.name === "context");
    if (!contextHook) throw new Error("session context hook not registered");

    const system: Array<{ type: string; text: string }> = [];
    (contextHook.callback as (input: { system: typeof system }) => void)({ system });
    expect(system).toEqual([{ type: "text", text: MESH_GUIDANCE }]);
    // The 0.16.0 token-economy ack rule rides along the anti-narration line.
    expect(MESH_GUIDANCE).toContain("Ack silently");
    expect(MESH_GUIDANCE).toContain("Reply only when asked or when adding information");
    // The 0.17.0 addressing rule (Slack model): pools are quiet, DMs wake.
    expect(MESH_GUIDANCE).toContain("team-wide announcements go to the POOL as one post");
    expect(MESH_GUIDANCE).toContain("never as individual DMs — a DM wakes its recipient");
    expect(MESH_GUIDANCE).toContain("DM = only what must be seen NOW by ONE mailbox");
    expect(MESH_GUIDANCE).toContain("role: keep it 1-3 words");
    expect(MESH_GUIDANCE).toContain("the panel truncates at word boundary");
    expect(MESH_GUIDANCE).toContain("the full role lives in mesh_status");
    // The 0.28.2 batch protocol (the sequential-processing failure seen live:
    // a turn acting on the first message while the rest of the batch sits
    // unread in the box).
    expect(MESH_GUIDANCE).toContain("drain the whole inbox first");
    expect(MESH_GUIDANCE).toContain("process the set in one pass");
    expect(MESH_GUIDANCE).toContain("re-check the inbox before any decisive reply");
    expect(MESH_GUIDANCE).toContain("mesh_wait no longer exists");
    expect(MESH_GUIDANCE).toContain("mesh_ask (NEVER blocks)");

    await cleanup?.();
  });

  it("disposes idempotently: timers dead, no second db close", async () => {
    const dir = tmpDataDir();
    const { ctx, prompts } = fakeCtx(dir, {
      options: { wakeIntervalMs: 20 },
      sessionList: async () => ({ data: [{ id: "s1" }], cursor: {} }),
    });
    const cleanup = await pluginModule.setup(ctx as never);

    const db = openMeshDb(join(dir, "mesh.db"));
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    db.close();

    // Hot-swap races a manual cleanup: the second dispose must be a no-op,
    // not a double db.close()/server.close()/hook.dispose().
    await cleanup?.();
    const second = typeof cleanup === "function" ? cleanup() : undefined;
    expect(second).toBeDefined();
    await expect(second).resolves.toBeUndefined();

    await new Promise((r) => setTimeout(r, 150));
    // The wake loop's timers are dead: unread mail is left unprompted.
    expect(prompts).toHaveLength(0);
  });
});
