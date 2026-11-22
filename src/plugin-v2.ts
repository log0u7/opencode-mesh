import { Plugin } from "@opencode/plugin";
import { Bonjour } from "bonjour-service";

import { openMeshDb, type MeshDb } from "./lib/db.js";
import { advertiseMesh, browseMesh, type AdvertiseHandle } from "./lib/discovery.js";
import { listLocks } from "./lib/locks.js";
import {
  listMailboxes,
  mailboxByBindKey,
  mailboxBySession,
  registerMailbox,
  unreadBoxCount,
} from "./lib/mail.js";
import { listPeers, upsertDiscoveredPeer } from "./lib/peers.js";
import { loadOrCreateIdentity, type NodeIdentity } from "./lib/identity.js";
import { nodeSpawn, stopAllWorkers, type SpawnFn } from "./lib/spawn.js";
import type { WorktreeClient } from "./lib/worktree.js";
import { v2WorktreeDomainClient } from "./lib/worktree.js";
import { reconcileWorkers } from "./lib/workers.js";
import { startMeshServer } from "./lib/serve.js";
import { createDurableStore } from "./lib/persist.js";
import { startWakeLoop } from "./lib/wake.js";
import { MeshRpc, snapshotFromMesh } from "./rpc.js";
import { buildToolSpecs, type ToolSpec } from "./tools.js";
import { defaultDataDir, parseOptions, type PluginOptions } from "./options.js";

const DEFAULT_PORT = 4399;

// A worker spawned by mesh_spawn inherits this marker: it must not boot its own
// mesh server, advertise over mDNS or register mesh tools. A pool of N workers
// then costs N worktrees, not N mesh nodes.
function isChildProcess(): boolean {
  return process.env.OPENCODE_MESH_CHILD === "1";
}

// The v2 adapter: OpenCode 2.x hosts call setup() (Plugin.define). Tool specs
// come from tools.ts; this file only maps them onto the v2 editor surface
// (JSON Schema inputs, {content} results).
export const MeshV2 = Plugin.define({
  id: "@log0u7/opencode-mesh",
  async setup(ctx) {
    if (isChildProcess()) {
      return async () => {};
    }
    const options = parseOptions(ctx.options as PluginOptions);
    const dataDir = options.dataDir ?? defaultDataDir();
    const identity: NodeIdentity = loadOrCreateIdentity(dataDir);
    const db: MeshDb = openMeshDb(`${dataDir}/mesh.db`);
    // Workers from a previous host process can never be stopped again once the
    // in-memory map is gone: mark dead pids before anything else uses the table.
    reconcileWorkers(db);

    const { server, port, address } = await startMeshServer({
      db,
      port: options.port ?? DEFAULT_PORT,
      ...(options.bind !== undefined ? { bind: options.bind } : {}),
    });
    // Prefer an injected client (tests, hosts that pass one), then adapt the
    // 2.x in-process worktree domain to the REST-shaped WorktreeClient. The
    // domain resolves payloads directly, without the v1 `{ data }` envelope.
    const worktreeClient: WorktreeClient =
      options.worktreeClient ?? v2WorktreeDomainClient(ctx.worktree, ctx.location.project.id);
    const spawnFn: SpawnFn = options.spawnFn ?? nodeSpawn;
    // Instance binding key: the box stamped at mesh_register follows this
    // instance across restarts (TUI bind re-binds it to the live session).
    const bindKey = `${ctx.location.project.id}:${ctx.location.directory}`;

    const sessionRef: { sessionID: string | null } = { sessionID: null };

    let advertiseHandle: AdvertiseHandle | null = null;
    let browseHandle: { close(): void } | null = null;
    if (options.advertise !== false) {
      const bonjour = new Bonjour();
      advertiseHandle = advertiseMesh({
        bonjour,
        port,
        node_id: identity.node_id,
        fingerprint: identity.fingerprint,
        public_key: identity.public_key,
      });
      browseHandle = browseMesh({
        bonjour,
        onDiscovered: (peer) => {
          if (peer.node_id !== identity.node_id) {
            upsertDiscoveredPeer(db, peer);
          }
        },
      });
    }

    await ctx.tool.transform((editor) => {
      for (const spec of buildToolSpecs({
        db,
        identity,
        dataDir,
        serverAddress: address,
        port,
        bindKey,
        worktreeClient,
        spawnFn,
      })) {
        editor.add({
          name: spec.name,
          description: spec.description,
          input: jsonSchema(spec),
          async execute(args, context) {
            // The session id is only known once a tool runs: capture it so the
            // wake loop can find this session's mailbox (and prompt it).
            if (typeof context?.sessionID === "string" && context.sessionID.length > 0) {
              sessionRef.sessionID = context.sessionID;
            }
            return { content: await spec.execute(args as Record<string, unknown>, context) };
          },
        });
      }
    });

    // Sessions currently mid-turn, tracked from the host's durable execution
    // events: a queued wake prompt would fire with a stale unread count after
    // the turn acked the mail (the orchestrator's "false positives").
    const running = new Set<string>();
    const trackExecutions = async () => {
      try {
        for await (const event of ctx.event.subscribe()) {
          const type = (event as { type?: string }).type ?? "";
          const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID;
          if (typeof sessionID !== "string") continue;
          if (type === "session.execution.started") {
            running.add(sessionID);
          } else if (
            type === "session.execution.succeeded" ||
            type === "session.execution.failed" ||
            type === "session.execution.interrupted"
          ) {
            running.delete(sessionID);
          }
        }
      } catch {
        // Event stream unavailable: the wake loop then treats every existing
        // session as idle (pre-0.9.4 behavior).
      }
    };
    void trackExecutions();

    // Wake: when unread mail lands in a mailbox whose session lives on this
    // host, inject a prompt so the idle agent reacts without a human relaying.
    // Host-wide: one opencode process (e.g. `opencode serve`) hosts many
    // sessions, each with its own mailbox. Mid-turn sessions are skipped.
    const wake = startWakeLoop({
      db,
      ...(options.wake === false ? { intervalMs: 0 } : {}),
      ...(options.wakeIntervalMs !== undefined ? { intervalMs: options.wakeIntervalMs } : {}),
      sessionExists: async (sessionID) => {
        try {
          return (await ctx.session.get({ sessionID })) !== undefined;
        } catch {
          return false;
        }
      },
      sessionRunning: (sessionID) => running.has(sessionID),
      prompt: (sessionID, text) =>
        ctx.session.prompt({
          sessionID,
          text,
          delivery: "queue",
        }),
    });

    // Live snapshot for the TUI sidebar: one compact read over the mesh state.
    // Sidebar collapse state is persisted HERE (raw storage domain, escaped
    // key) because the TUI-side storage.store() throws for scoped plugin ids
    // (anomalyco/opencode#62634).
    const sidebarPersist = createDurableStore(ctx.storage, "@log0u7/opencode-mesh", "mesh-sidebar");
    const rpc = await ctx.rpc.register(MeshRpc, {
      snapshot: async (input: unknown) => {
        const sessionID =
          typeof input === "object" && input !== null && "sessionID" in input
            ? (input as { sessionID: unknown }).sessionID
            : undefined;
        const myBox =
          typeof sessionID === "string" && sessionID.length > 0
            ? mailboxBySession(db, sessionID)
            : null;
        const boxes = listMailboxes(db);
        const pools: Record<string, string[]> = {};
        for (const box of boxes) {
          for (const pool of box.pools) {
            const members = pools[pool] ?? [];
            members.push(box.name);
            pools[pool] = members;
          }
        }
        return snapshotFromMesh({
          identity,
          peers: listPeers(db),
          locks: listLocks(db, { now: Date.now() }),
          server: `${address}:${port}`,
          my: myBox
            ? {
                name: myBox.name,
                role: myBox.role,
                unread: unreadBoxCount(db, myBox.name),
              }
            : null,
          mailboxes: boxes.map((box) => ({
            name: box.name,
            role: box.role,
            pools: [...box.pools],
            age_s: Math.max(0, Math.round((Date.now() - box.last_seen) / 1000)),
          })),
          pools,
        });
      },
      bind: async (input: unknown) => {
        const sessionID =
          typeof input === "object" && input !== null && "sessionID" in input
            ? (input as { sessionID: unknown }).sessionID
            : undefined;
        if (typeof sessionID === "string" && sessionID.length > 0) {
          sessionRef.sessionID = sessionID;
          // Re-bind every mailbox this instance registered (same project key):
          // after a restart a box would otherwise stay bound to the dead
          // session id and the wake loop would never find it. Last binder
          // wins (handoff when two instances share one project key).
          for (const box of mailboxByBindKey(db, bindKey)) {
            registerMailbox(db, {
              name: box.name,
              session_id: sessionID,
              role: box.role,
              bind_key: bindKey,
              now: Date.now(),
            });
          }
          // Optional declarative mailbox: applied after the dynamic boxes, so
          // on a name collision the configuration wins (last act).
          if (options.mailbox !== undefined) {
            registerMailbox(db, {
              name: options.mailbox,
              session_id: sessionID,
              ...(options.mailboxRole !== undefined ? { role: options.mailboxRole } : {}),
              now: Date.now(),
            });
          }
        }
        return { bound: true };
      },
      sidebar: async () => {
        const state = await sidebarPersist.load<{ collapsed: boolean }>();
        return { collapsed: state?.collapsed === true };
      },
      set_sidebar: async (input: unknown) => {
        const collapsed =
          typeof input === "object" && input !== null && "collapsed" in input
            ? (input as { collapsed: unknown }).collapsed === true
            : false;
        await sidebarPersist.save({ collapsed });
        return { collapsed };
      },
    });

    const cleanup = async () => {
      wake.stop();
      stopAllWorkers(db);
      advertiseHandle?.close();
      browseHandle?.close();
      rpc.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    };
    return cleanup;
  },
});

function jsonSchema(spec: ToolSpec): {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
  additionalProperties: false;
} {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const field of spec.fields) {
    properties[field.name] = { type: field.type, description: field.description };
  }
  const required = spec.fields.filter((f) => f.required).map((f) => f.name);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
