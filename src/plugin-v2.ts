import { createHash } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import { Bonjour } from "bonjour-service";

import { openMeshDb, type MeshDb } from "./lib/db.js";
import { advertiseMesh, browseMesh, type AdvertiseHandle } from "./lib/discovery.js";
import { listLocks } from "./lib/locks.js";
import {
  deliverMessage,
  getTask,
  listMailboxes,
  mailboxByBindKey,
  mailboxByName,
  mailboxesBySession,
  boardGet,
  listLocalOnlyMailboxes,
  registerMailbox,
  replyTask,
  type TaskState,
  unreadBoxCount,
  unreadForBox,
} from "./lib/mail.js";
import {
  findSendablePeer,
  listPeers,
  resolvePeerTarget,
  upsertDiscoveredPeer,
} from "./lib/peers.js";
import { loadOrCreateIdentity, pairingProof, type NodeIdentity } from "./lib/identity.js";
import { sendMail } from "./lib/client.js";
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
import {
  handleTaskAsk,
  startOutboxSender,
  sweepOutbox,
  syncRegistryToPeers,
  type OutboxPayload,
} from "./lib/outbox.js";
import { ackEvent, openPeerStream } from "./lib/stream.js";
import { startWakeLoop, createExecutionTracker, type HostEvent } from "./lib/wake.js";
import { startSessionLister } from "./lib/sessions.js";
import { MESH_GUIDANCE } from "./lib/guidance.js";
import { MeshRpc, snapshotFromMesh } from "./rpc.js";
import { buildToolSpecs, WORKER_TOOL_BLOCKLIST, type ToolSpec } from "./tools.js";
import { defaultDataDir, parseOptions, addressingOptions, type PluginOptions } from "./options.js";

const DEFAULT_PORT = 4399;

// A worker spawned by mesh_spawn inherits this marker: a headless child ("1")
// must not boot its own mesh server, advertise over mDNS or register mesh
// tools — a pool of N workers then costs N worktrees, not N mesh nodes. An
// enrolled child ("enrolled", 0.23.0) is a fleet agent: no server and no mDNS
// either (the host's server on 4399 serves every session of the host), but it
// keeps the mesh tools and self-enrolls from its prompt header.
function childMode(): "headless" | "enrolled" | null {
  const value = process.env.OPENCODE_MESH_CHILD;
  if (value === "1") return "headless";
  if (value === "enrolled") return "enrolled";
  return null;
}

// The v2 adapter: OpenCode 2.x hosts call setup() (Plugin.define). Tool specs
// come from tools.ts; this file only maps them onto the v2 editor surface
// (JSON Schema inputs, {content} results).
export const MeshV2 = Plugin.define({
  id: "@log0u7/opencode-mesh",
  async setup(ctx) {
    const child = childMode();
    if (child === "headless") {
      return async () => {};
    }
    if (child === "enrolled") {
      // Enrolled child: tools only, over the SAME database the host server
      // serves — the mesh tools act locally, no server of its own is needed.
      // No wake loop, rpc, sidebar or guidance: a one-shot worker needs none,
      // and its prompt header carries its own instructions.
      const options = parseOptions(ctx.options as PluginOptions);
      const dataDir = options.dataDir ?? defaultDataDir();
      const db: MeshDb = openMeshDb(`${dataDir}/mesh.db`);
      const identity: NodeIdentity = loadOrCreateIdentity(dataDir);
      const worktreeClient: WorktreeClient =
        options.worktreeClient ?? v2WorktreeDomainClient(ctx.worktree, ctx.location.project.id);
      const bindKey = `${ctx.location.project.id}:${ctx.location.directory}`;
      // The orchestration tools stay off a worker's surface (0.30.0): an
      // enrolled child registers, drains, waits, replies and reads the
      // journal — it does not spawn, pair, or manage workers (about 4k
      // characters less on every request of every worker).
      await ctx.tool.transform((editor) => {
        for (const spec of buildToolSpecs({
          db,
          identity,
          dataDir,
          serverAddress: "127.0.0.1",
          port: options.port ?? DEFAULT_PORT,
          bindKey,
          fanout: createFanout({ db, identity }),
          worktreeClient,
          spawnFn: options.spawnFn ?? nodeSpawn,
          addressing: addressingOptions(options),
          projectID: ctx.location.project.id,
          ...(options.spawnMax !== undefined ? { spawnMax: options.spawnMax } : {}),
        })) {
          if (WORKER_TOOL_BLOCKLIST.has(spec.name)) continue;
          editor.add({
            name: spec.name,
            description: spec.description,
            input: jsonSchema(spec),
            async execute(args, context) {
              return { content: await spec.execute(args as Record<string, unknown>, context) };
            },
          });
        }
      });
      return async () => {
        db.close();
      };
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
    const fanout = createFanout({ db, identity, rebrowse: () => browseHandle?.refresh() });

    // Sessions currently mid-turn, tracked from the host's durable execution
    // events: a queued wake prompt would fire with a stale unread count after
    // the turn acked the mail (the orchestrator's "false positives"). Declared
    // before the server starts: /status and /metrics may be scraped as soon as
    // the listener binds, and the capa provider reads running.size.
    const running = new Set<string>();
    // Host capabilities: ONE 60 s cache shared by mesh_status, /status and
    // /metrics (a scrape never doubles the probes).
    const hostCapa = createHostCapa({ db, sessionsRunning: () => running.size });

    // Worktree client + spawn fn: shared by the local spawn tool and the
    // distant-spawn receiver (the peer executes its own enrolled-spawn path).
    const worktreeClient: WorktreeClient =
      options.worktreeClient ?? v2WorktreeDomainClient(ctx.worktree, ctx.location.project.id);
    const spawnFn: SpawnFn = options.spawnFn ?? nodeSpawn;

    // TLS material is derived from the node identity: the cert presents the
    // very key peers already pin, so TLS adds zero new trust.
    const tlsMaterial = nodeTlsMaterial(dataDir);
    const { server, port, address, insecureServer, hub } = await startMeshServer({
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
      distantSpawn: {
        acceptSpawn: options.acceptSpawn === true,
        ...(options.spawnQuotaPeer !== undefined ? { quotaPeer: options.spawnQuotaPeer } : {}),
        ...(options.spawnWorktreeBase !== undefined
          ? { spawnWorktreeBase: options.spawnWorktreeBase }
          : {}),
        privateKey: identity.private_key,
        worktreeClient,
        spawnFn,
        worktreeDomain: ctx.worktree,
      },
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
    let browseHandle: { close(): void; refresh(): void } | null = null;
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
        rebrowse: () => browseHandle?.refresh(),
        fanout,
        worktreeClient,
        spawnFn,
        addressing: addressingOptions(options),
        capa: hostCapa.get,
        projectID: ctx.location.project.id,
        ...(options.spawnMax !== undefined ? { spawnMax: options.spawnMax } : {}),
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
    const executions = createExecutionTracker(running);
    const trackExecutions = async () => {
      try {
        for await (const event of ctx.event.subscribe()) {
          executions.observe(event as HostEvent);
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
    // The outbox sender (refonte P2.6): the due rows are claimed and
    // delivered in the background — the peer conn is resolved FRESH at
    // delivery (a moved peer, a fresh mDNS announce, a re-paired token are
    // picked up without the asking agent ever knowing).
    // The stream client + the hub (refonte 3.1): the SSE streams per peer —
    // the receive side never polls; the outbox pushes over the open streams.
    const dispatch = (eventPeerNodeId: string) => (event: { type: string; data: unknown }) => {
      const d = event.data as {
        from?: string;
        from_box?: string;
        to?: string;
        subject?: string;
        body?: string;
        reply_to?: string;
        kind?: "notify" | "fyi";
        origin_id?: string;
        task?: {
          id: string;
          group_id?: string | null;
          deadline?: number | null;
          result?: string;
          state?: string;
        };
      };
      if (event.type === "registry") return; // the registry rides its own pusher
      // The spoof gate FIRST (the refonte2-C7): the stream is opened TO an
      // authenticated peer — its events carry ITS node id; a task event
      // claiming another sender is dropped (the owner checks below read
      // the AUTHENTICATED peer id, never the payload header).
      if (d.from !== undefined && d.from !== eventPeerNodeId) return;
      if (event.type === "task-reply" && d.task?.id) {
        const task = getTask(db, d.task.id);
        if (task) {
          // The owner check (the 0.33.3-C): the event must come from the
          // task's TARGET node (the responder) — the column filled at
          // mesh_ask, never a from_box parse.
          if (eventPeerNodeId !== task.target_node) return;
          const VALID_STATES = ["working", "input_required", "completed", "failed", "canceled"];
          const state = (d.task.state ?? "completed") as TaskState;
          if (!VALID_STATES.includes(state)) return;
          replyTask(db, d.task.id, task.to_box, d.task.result ?? "", state);
        }
        // The ACK (the 0.33.3-C): the push alone is at-most-once — the
        // applied origin_id flows back so the sender's row goes sent.
        return d.origin_id ?? null;
      }
      if (event.type === "task-ask" && d.task?.id) {
        handleTaskAsk(
          db,
          {
            node_id: eventPeerNodeId,
            to_box: d.to ?? "",
            from_box: d.from_box ?? null,
            subject: d.subject ?? "",
            body: d.body ?? "",
            origin_id: d.origin_id ?? "",
            type: "task-ask",
            task: {
              id: d.task.id,
              from_box: d.from_box ?? null,
              to_box: d.to ?? "",
              question: d.body ?? "",
              group_id: d.task.group_id ?? null,
              deadline: d.task.deadline ?? null,
              ...(d.task.result !== undefined ? { result: d.task.result } : {}),
              state: (d.task.state ?? "completed") as TaskState,
            },
          } as OutboxPayload,
          // The asking NODE from the authenticated stream (the 0.33.3-B).
          eventPeerNodeId,
        );
        // The ACK: idempotent — an already-mirrored ask acks too (the
        // resend of the same ask must not starve the sender's row).
        return d.origin_id ?? null;
      }
      // The SAME validation as /mail (the refonte2-C7) ran at the top: the
      // task branches already dropped a spoofed sender.
      // The applied origin_id returns: the stream client ACKs it (the
      // refonte2-P1 — the push alone is at-most-once).
      const applied = deliverMessage(db, {
        from: d.from ?? "",
        from_box: d.from_box ?? null,
        to_box: d.to ?? null,
        subject: d.subject ?? "",
        body: d.body ?? "",
        reply_to: d.reply_to ?? null,
        kind: d.kind ?? "notify",
        origin_id: d.origin_id ?? null,
      });
      return applied.ok ? (d.origin_id ?? null) : null;
    };
    // The client lifecycle (the refonte2-A3): ONE client per pair EVER —
    // the client manages its own reconnection; openStreams creates only if
    // absent AND never created (a dropped client keeps reconnecting alone:
    // a fresh client on the next tick would multiply the loops on an
    // unstable link). everClients holds EVERY handle ever created — the
    // dispose stops them all (the dropped ones are not in the live map).
    const everClients = new Map<string, { stop(): void }>();
    const streamClients = new Map<string, { stop(): void }>();
    // The client KEY (the refonte2-P5): node + url + pk + the token hash —
    // a RE-PAIRED peer (a new token) or a moved peer (a new url/key)
    // INVALIDATES the old client: stop it, create a fresh one (the old one
    // looped on 401/pin-mismatch forever until restart).
    const clientKey = (nodeId: string, conn: { url: string; pk: string | null }, token: string) =>
      `${nodeId}|${conn.url}|${conn.pk ?? ""}|${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
    const openStreams = (): void => {
      for (const peer of listPeers(db)) {
        if (!peer.paired) continue;
        const conn = resolvePeerTarget(db, peer.node_id);
        if (!conn) continue;
        const token = findSendablePeer(db, peer.node_id)?.token ?? "";
        const key = clientKey(peer.node_id, conn, token);
        const existing: { stop(): void; key?: string } | undefined = streamClients.get(
          peer.node_id,
        );
        if (existing && existing.key === key) continue;
        // The key CHANGED (a re-pair, a move): stop the stale client — its
        // reconnect loop would hit 401/pin-mismatch forever.
        if (existing) {
          existing.stop();
          streamClients.delete(peer.node_id);
        }
        const client: { stop(): void; key?: string } = openPeerStream(
          {
            url: conn.url,
            ...(conn.tls ? { tls: true } : {}),
            ...(conn.pk !== null ? { pk: conn.pk } : {}),
            token,
            from: identity.node_id,
            proof: pairingProof(identity, token),
          },
          {
            onEvent: dispatch(peer.node_id),
            ack: (originId: string) =>
              void ackEvent(
                {
                  url: conn.url,
                  ...(conn.tls ? { tls: true } : {}),
                  ...(conn.pk !== null ? { pk: conn.pk } : {}),
                  token,
                  from: identity.node_id,
                  proof: pairingProof(identity, token),
                },
                originId,
              ),
            onDrop: () => streamClients.delete(peer.node_id),
          },
        );
        client.key = key;
        // The registry re-push (the 0.33.3-F): a FRESH stream client (the
        // setup, a reconnect, a re-pair) pushes this node's COMPLETE local
        // registry to the peer — the post-reboot convergence needs no
        // drain, the federated rows refresh on the wire.
        void syncRegistryToPeers(db, identity);
        everClients.set(peer.node_id, client);
        streamClients.set(peer.node_id, client);
      }
    };
    openStreams();

    const outboxSender =
      options.wake === false
        ? undefined
        : startOutboxSender(
            db,
            identity,
            () => {
              browseHandle?.refresh();
              openStreams();
            },
            1_000,
            hub,
          );

    const wake = startWakeLoop({
      db,
      onTick: async () => {
        // The outbox sweep: GONE from the tick (the refonte2-B4 — the
        // background sender owns the delivery; the queueOutbox nudge wakes
        // it). The tick keeps: the streams for the new pairings.
        openStreams();
      },
      ...(options.wake === false ? { intervalMs: 0 } : {}),
      ...(options.wakeIntervalMs !== undefined ? { intervalMs: options.wakeIntervalMs } : {}),
      ...(options.wakePools !== undefined ? { wakePools: options.wakePools } : {}),
      ...(options.debugWake ? { debugWake: true } : {}),
      sessionKnown: (sessionID) => sessionsSeen.has(sessionID) || liveSessions.has(sessionID),
      sessionRunning: (sessionID) => running.has(sessionID),
      escalateTo: options.escalateTo ?? "orq",
      prompt: (sessionID, text, messageID, description, kind) => {
        // The refonte2-C4: the SYNTHETIC delivery when the host supports it
        // (opencode >= 2.4: a synthetic message, not a user one; the
        // transport-retry idempotency key = the explicit id, unchanged).
        // notify: delivery "steer" + resume true (the session wakes now);
        // fyi: resume FALSE (delivered at the next run, ZERO turns).
        if (typeof ctx.session.synthetic === "function") {
          return ctx.session.synthetic({
            sessionID,
            id: messageID,
            text,
            description: description ?? null,
            delivery: "steer",
            resume: kind !== "fyi",
          });
        }
        const input = { sessionID, id: messageID, text, delivery: "queue" as const };
        return ctx.session.prompt(input);
      },
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
        // Default folded (0.24.4): nothing persisted renders collapsed; the
        // user's toggle persists on top of that initial value.
        return { collapsed: state?.collapsed ?? true };
      },
      set_sidebar: async (input: unknown) => {
        const collapsed =
          typeof input === "object" && input !== null && "collapsed" in input
            ? (input as { collapsed: unknown }).collapsed === true
            : false;
        await sidebarPersist.save({ collapsed });
        return { collapsed };
      },
      // The /mesh board slice (0.34.0): the pool board through the same
      // boardGet read the mesh_board_get tool serves.
      board: async (input: unknown) => {
        const pool =
          typeof input === "object" && input !== null && "pool" in input
            ? (input as { pool?: unknown }).pool
            : undefined;
        return {
          rows: boardGet(db, typeof pool === "string" && pool.length > 0 ? pool : undefined).map(
            ({ box, line }) => ({ box, line }),
          ),
        };
      },
      // The /mesh inbox slice (0.34.0): the unread deliveries of one mailbox
      // (or every local mailbox), oldest first, capped at 10 rows.
      inbox: async (input: unknown) => {
        const box =
          typeof input === "object" && input !== null && "box" in input
            ? (input as { box?: unknown }).box
            : undefined;
        const boxes =
          typeof box === "string" && box.length > 0
            ? [box]
            : listLocalOnlyMailboxes(db).map((b) => b.name);
        const all = boxes.flatMap((name) =>
          unreadForBox(db, name).map((row) => ({
            box: name,
            from_box: row.from_box,
            subject: row.subject,
            age_s: Math.max(0, Math.round((Date.now() - row.created_at) / 1000)),
          })),
        );
        return { rows: all.slice(0, 10), total: all.length };
      },
    });

    // Idempotent: a double dispose (host hot-swap racing a manual cleanup)
    // must not double-close the database or re-clear cleared timers.
    let disposed = false;
    const cleanup = async () => {
      if (disposed) return;
      disposed = true;
      wake.stop();
      outboxSender?.stop();
      hub?.stop();
      // EVERY client ever created stops: the live ones AND the dropped ones
      // still reconnecting on their own loop.
      for (const s of everClients.values()) s.stop();
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
  properties: Record<string, { type: string; description: string; items?: { type: string } }>;
  required?: string[];
  additionalProperties: false;
} {
  const properties: Record<
    string,
    { type: string; description: string; items?: { type: string } }
  > = {};
  for (const field of spec.fields) {
    properties[field.name] =
      field.type === "array"
        ? { type: "array", items: { type: "string" }, description: field.description }
        : { type: field.type, description: field.description };
  }
  const required = spec.fields.filter((f) => f.required).map((f) => f.name);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
