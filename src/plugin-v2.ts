import { Plugin } from "@opencode/plugin";
import { Bonjour } from "bonjour-service";

import { openMeshDb, type MeshDb } from "./lib/db.js";
import { advertiseMesh, browseMesh, type AdvertiseHandle } from "./lib/discovery.js";
import { listLocks } from "./lib/locks.js";
import {
  listMailboxes,
  mailboxByBindKey,
  mailboxByName,
  mailboxesBySession,
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
import { nodeTlsMaterial } from "./lib/tls.js";
import { startMemorySyncPusher } from "./lib/memory-sync.js";
import { createDurableStore } from "./lib/persist.js";
import { createFanout } from "./lib/fanout.js";
import { createHostCapa } from "./lib/capa.js";
import { startWakeLoop } from "./lib/wake.js";
import { startSessionLister } from "./lib/sessions.js";
import { MESH_GUIDANCE } from "./lib/guidance.js";
import { MeshRpc, snapshotFromMesh } from "./rpc.js";
import { buildToolSpecs, type ToolSpec } from "./tools.js";
import { defaultDataDir, parseOptions, addressingOptions, type PluginOptions } from "./options.js";

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

    // Pool federation: shared by the tools (local broadcasts) and the server
    // (relayed broadcasts arriving from peers).
    const fanout = createFanout({ db, identity });

    // Sessions currently mid-turn, tracked from the host's durable execution
    // events: a queued wake prompt would fire with a stale unread count after
    // the turn acked the mail (the orchestrator's "false positives"). Declared
    // before the server starts: /status and /metrics may be scraped as soon as
    // the listener binds, and the capa provider reads running.size.
    const running = new Set<string>();
    // Host capabilities: ONE 60 s cache shared by mesh_status, /status and
    // /metrics (a scrape never doubles the probes).
    const hostCapa = createHostCapa({ db, sessionsRunning: () => running.size });

    // TLS material is derived from the node identity: the cert presents the
    // very key peers already pin, so TLS adds zero new trust.
    const tlsMaterial = nodeTlsMaterial(dataDir);
    const { server, port, address, insecureServer } = await startMeshServer({
      db,
      port: options.port ?? DEFAULT_PORT,
      ...(options.bind !== undefined ? { bind: options.bind } : {}),
      fanout,
      self: { node_id: identity.node_id, pk: identity.public_key, hostname: identity.hostname },
      tlsMaterial,
      capa: hostCapa.get,
      ...(options.tls === false ? { tls: false } : {}),
      ...(options.insecureHttp === true ? { insecureHttp: true } : {}),
      dataDir,
    });
    // Outbound memory sync: push the shareable outbox to paired peers on a cadence.
    // Reception (the /memory-sync endpoint) is always on; this loop is the gated half.
    const memorySyncPusher =
      options.memorySync === false
        ? null
        : startMemorySyncPusher({
            dataDir,
            db,
            identity,
            intervalMs: (options.memorySyncInterval ?? 15) * 60_000,
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

    // Live sessions of THIS host, snapshotted from the host's paginated
    // session list (ctx.session.list, @opencode/plugin >= 2.3). This is the
    // wake loop's primary liveness signal: it works even when the TUI slot
    // fails to load (opencode 2.4.0 raises the @opentui requirement, which
    // used to leave sessionsSeen empty and starve the wake). On older hosts
    // the list is absent: log it once and rely on sessionsSeen alone.
    const liveSessions = startSessionLister({
      ...(typeof ctx.session.list === "function"
        ? { list: (input: { cursor?: string }) => ctx.session.list(input) }
        : {}),
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[opencode-mesh] live session list refresh failed: ${message}`);
      },
    });
    if (typeof ctx.session.list !== "function") {
      console.warn(
        "[opencode-mesh] host session list unavailable (< 2.4): wake liveness falls back to tool-call and TUI bind discovery",
      );
    }

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
        fanout,
        worktreeClient,
        spawnFn,
        addressing: addressingOptions(options),
        capa: hostCapa.get,
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
              sessionsSeen.add(context.sessionID);
            }
            return { content: await spec.execute(args as Record<string, unknown>, context) };
          },
        });
      }
    });

    // Sessions this instance has seen since boot (mesh tool calls + TUI
    // bind): a COMPLEMENT to the host session list (liveSessions) — a fresh
    // idle session is known through the list before its first tool call.
    // Session records outlive their process — ctx.session.get would call a
    // dead pre-restart session "alive".
    const sessionsSeen = new Set<string>();
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
      ...(options.wakePools !== undefined ? { wakePools: options.wakePools } : {}),
      sessionKnown: (sessionID) => sessionsSeen.has(sessionID) || liveSessions.has(sessionID),
      sessionRunning: (sessionID) => running.has(sessionID),
      prompt: (sessionID, text) =>
        ctx.session.prompt({
          sessionID,
          text,
          delivery: "queue",
        }),
    });

    // Standing anti-narration directive in every session's system prompt: the
    // v2 session context hook is the supported injection point (the context's
    // `system` parts are mutable). Disposed with the plugin so a hot-swapped
    // orphan cannot inject the line twice.
    const guidance = await ctx.session.hook("context", (input) => {
      input.system.push({ type: "text", text: MESH_GUIDANCE });
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
        const sessionBoxes =
          typeof sessionID === "string" && sessionID.length > 0
            ? mailboxesBySession(db, sessionID)
            : [];
        const boxes = listMailboxes(db);
        const pools: Record<string, string[]> = {};
        for (const box of boxes) {
          for (const pool of box.pools) {
            const members = pools[pool] ?? [];
            members.push(box.name);
            pools[pool] = members;
          }
        }
        const capa = await hostCapa.get().catch(() => undefined);
        return snapshotFromMesh({
          identity,
          ...(capa !== undefined ? { capa } : {}),
          peers: listPeers(db),
          locks: listLocks(db, { now: Date.now() }),
          server: `${address}:${port}`,
          hats: sessionBoxes.map((box) => ({
            name: box.name,
            role: box.role,
            unread: unreadBoxCount(db, box.name),
          })),
          mailboxes: boxes.map((box) => ({
            name: box.name,
            role: box.role,
            pools: [...box.pools],
            primary_pool: box.primary_pool,
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
          sessionsSeen.add(sessionID);
          // NO dynamic re-bind: opencode sessions are durable — they resume
          // with the same id after a restart, so stamped boxes stay
          // correctly bound to their registration session forever. Recovery
          // after a lost identity goes through the agent's first-turn
          // mesh_register (AGENTS.md check-in). Earlier versions re-bound on
          // every bind, which let the first rendered tab steal every hat at
          // boot. The OPTIONAL static mailbox still re-applies here: it is
          // explicit configuration, and it follows the window on purpose.
          if (options.mailbox !== undefined) {
            const existing = mailboxByName(db, options.mailbox);
            if (!existing || existing.session_id !== sessionID) {
              registerMailbox(db, {
                name: options.mailbox,
                session_id: sessionID,
                ...(options.mailboxRole !== undefined ? { role: options.mailboxRole } : {}),
                now: Date.now(),
              });
            }
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

    // Idempotent: a double dispose (host hot-swap racing a manual cleanup)
    // must not double-close the database or re-clear cleared timers.
    let disposed = false;
    const cleanup = async () => {
      if (disposed) return;
      disposed = true;
      wake.stop();
      memorySyncPusher?.stop();
      liveSessions.stop();
      stopAllWorkers(db);
      advertiseHandle?.close();
      browseHandle?.close();
      rpc.dispose();
      await guidance?.dispose();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        ...(insecureServer !== undefined
          ? [new Promise<void>((resolve) => insecureServer.close(() => resolve()))]
          : []),
      ]);
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
