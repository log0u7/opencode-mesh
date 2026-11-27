import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import type { MeshDb } from "./db.js";
import { authenticateToken, findPeerById } from "./peers.js";
import type { HostCapa } from "./capa.js";
import type { TlsMaterial } from "./tls.js";
import type { SpawnFn } from "./spawn.js";
import type { WorktreeClient, WorktreeDomain } from "./worktree.js";
import {
  DEFAULT_SPAWN_QUOTA_PEER,
  ackSpawned,
  createDbSpawnReplayStore,
  parseSpawnRequest,
  runDistantSpawn,
  spawnCause,
  verifySpawnRequest,
  type SpawnReplayStore,
} from "./distant-spawn.js";
import { countRunningSpawnedByPeer } from "./workers.js";
import {
  handleTaskAsk,
  markOutboxSentByOrigin,
  queueBounce,
  type OutboxPayload,
} from "./outbox.js";
import { StreamHub } from "./stream.js";
import {
  deliverMessage,
  federatedByName,
  getTask,
  listMailboxes,
  mailboxByName,
  MESSAGE_TTL_MS,
  purgeExpired,
  receiveMessage,
  mergeFederatedRegistry,
  replyTask,
  unreadCount,
  withTransaction,
  type TaskState,
} from "./mail.js";
import type { Fanout } from "./fanout.js";
import { receiveMemorySync } from "./memory-sync.js";
import {
  ensurePairingCodeSchema,
  findPendingByCode,
  pairWithToken,
  prunePendingTokens,
} from "./peers.js";
import { buildOfferBlob, parseOfferBlob, type OfferPayload } from "./offer-blob.js";

const BODY_LIMIT = 64 * 1024;

// Memory sync payloads are opaque JSONL snapshots of a peer's shareable entries:
// a large store legitimately exceeds the mail limit, so this endpoint reads up to
// 1 MiB. Everything above stays a 413, and the sender retries on its next cycle.
const MEMORY_SYNC_BODY_LIMIT = 1024 * 1024;

// Loopback by default: the mesh HTTP API must not be reachable from the
// network unless the operator explicitly opted into a LAN pool.
const DEFAULT_BIND = "127.0.0.1";

export type MeshServerOptions = {
  /** The stream hub (the refonte 3.1): the open peer streams — set at
   * creation, read by the /stream route inside handle(). */
  hub?: StreamHub;

  db: MeshDb;
  port: number;
  bind?: "loopback" | "lan";
  /** Pool federation: forwards local broadcasts to paired peers. */
  fanout?: Fanout;
  /** This node's identity, for pairing counter-offers. */
  self: { node_id: string; pk: string; hostname: string };
  /** Resolved by startMeshServer: "host:port" the caller reached us on. */
  selfAddress?: string;
  /** Resolved by startMeshServer: the actually-bound port (differs from
   * `port` when the requested one was taken and we fell back to ephemeral). */
  resolvedPort?: number;
  /** TLS material (identity-derived key + cert), from nodeTlsMaterial().
   * Required unless tls is explicitly disabled. */
  tlsMaterial?: TlsMaterial;
  /** Serve HTTPS on `port` (default true): all mesh traffic is encrypted and
   * the cert is pinned by the peer's Ed25519 key. */
  tls?: boolean;
  /** Documented escape hatch: an extra PLAIN-HTTP server on port+1 (default
   * off). Peers that cannot speak TLS yet may target it explicitly. */
  insecureHttp?: boolean;
  /** Where /memory-sync stores peers' pushed JSONL (the inbox tree). Absent =
   * the endpoint answers 503: the plugin always passes its dataDir. */
  dataDir?: string;
  /** Distant spawn (0.24.0): accept signed mesh_spawn(node=…) requests from
   * paired peers. acceptSpawn defaults to FALSE (deny-by-default): the
   * endpoint answers 403 with an explicit refusal until the operator opts in.
   * quotaPeer caps the enrolled workers ONE requesting peer may keep running
   * here (default 2). The peer executes its own enrolled-spawn path and acks
   * the parent by DM. */
  distantSpawn?: {
    acceptSpawn: boolean;
    quotaPeer?: number;
    /** Destination base for the worktrees of spawned children (0.24.7). */
    spawnWorktreeBase?: string;
    /** This node's private key: the ack DM carries a standard pairing proof. */
    privateKey: string;
    worktreeClient: WorktreeClient;
    /** The host's in-process worktree domain (0.24.8, v2 hosts): lets a
     * signed request retarget the create to the parent's project. */
    worktreeDomain?: WorktreeDomain;
    spawnFn: SpawnFn;
  };
  /** Shared host-capability provider (createHostCapa): /status and /metrics
   * read the SAME 60 s cache, so a scrape never doubles the probes. Absent =
   * /metrics renders only the db counters. */
  capa?: () => Promise<HostCapa>;
};

export type MeshServer = {
  server: Server;
  port: number;
  address: string;
  hub?: StreamHub;
  /** The insecure side channel, when insecureHttp was requested. */
  insecureServer?: Server;
  insecurePort?: number;
};
// Bind the mesh HTTP(S) server and resolve the actual port. When the requested
// port is taken (two mesh nodes on one machine, e.g. a spawned worker loading
// the same plugin), fall back to an ephemeral port instead of crashing.
export async function startMeshServer(options: MeshServerOptions): Promise<MeshServer> {
  ensurePairingCodeSchema(options.db);
  // Messages older than 7 days are swept at boot.
  purgeExpired(options.db, MESSAGE_TTL_MS, Date.now());

  const host = options.bind === "lan" ? "0.0.0.0" : DEFAULT_BIND;
  const tls = options.tls !== false;
  if (tls && options.tlsMaterial === undefined) {
    throw new Error(
      "startMeshServer: TLS is on by default; pass tlsMaterial (nodeTlsMaterial(dataDir)) or tls: false",
    );
  }
  // One replay store per server, persisted in the mesh db: a claimed nonce
  // stays claimed across a restart (0.24.1), so the 5 min replay window never
  // re-opens, and nonces never leak across servers in the same process.
  const spawnReplay = createDbSpawnReplayStore(options.db);
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    handle(options, req, res, spawnReplay).catch((error: unknown) => {
      // Any uncaught throw in a route answers 500 JSON: an unhandled
      // rejection would crash the host process (opencode itself).
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[opencode-mesh] handler failed: ${message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, 500, { error: "internal error" });
    });
  };
  options.hub = new StreamHub();
  const server = tls
    ? createHttpsServer(
        { key: options.tlsMaterial!.keyPem, cert: options.tlsMaterial!.certPem },
        handler,
      )
    : createServer(handler);
  const port = await listenWithFallback(server, options.port, host);

  let insecureServer: Server | undefined;
  let insecurePort: number | undefined;
  if (options.insecureHttp === true) {
    insecureServer = createServer(handler);
    insecurePort = await listenWithFallback(insecureServer, port + 1, host);
  }

  options.selfAddress = `${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  options.resolvedPort = port;
  return {
    server,
    port,
    address: host,
    hub: options.hub,
    ...(insecureServer !== undefined && insecurePort !== undefined
      ? { insecureServer, insecurePort }
      : {}),
  };
}

function listenWithFallback(server: Server, requested: number, host: string): Promise<number> {
  let onListen: () => void = () => {};
  return new Promise<number>((resolve, reject) => {
    const attempt = (port: number): void => {
      onListen = () => {
        server.removeListener("error", onError);
        resolve(serverAddressPort(server, port));
      };
      server.once("listening", onListen);
      server.once("error", onError);
      server.listen(port, host);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListen);
      if (err.code === "EADDRINUSE" && server.listening === false) {
        attempt(0);
        return;
      }
      reject(err);
    };
    attempt(requested);
  });
}

function serverAddressPort(server: Server, fallback: number): number {
  const address = server.address();
  return address !== null && typeof address !== "string" ? address.port : fallback;
}

function consumePairingOffer(
  options: MeshServerOptions,
  pendingToken: string,
  offer: string,
  remote: string,
  localAddress: string,
): string | null {
  const parsed = parseOfferBlob(offer) as OfferPayload | null;
  if (parsed === null) return null;
  options.db.conn.run("DELETE FROM pending_tokens WHERE token = ?", [pendingToken]);
  pairWithToken(options.db, {
    node_id: parsed.node_id,
    hostname: (parsed.hostname ?? "").length > 0 ? (parsed.hostname ?? "") : "manual",
    fingerprint: "code-pairing",
    token: parsed.token,
    addresses: remote.startsWith("::ffff:") ? [remote.slice(7)] : [remote],
    public_key: parsed.pk,
  });
  // Counter-offer: our fresh pending offer, addressed to the interface the
  // caller actually reached.
  const address = localAddress.startsWith("::ffff:") ? localAddress.slice(7) : localAddress;
  return buildOfferBlob(options.db, {
    node_id: options.self.node_id,
    pk: options.self.pk,
    hostname: options.self.hostname,
    address: `${address}:${options.resolvedPort ?? options.port}`,
  });
}

async function handle(
  options: MeshServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
  spawnReplay: SpawnReplayStore,
): Promise<void> {
  const { db, fanout } = options;
  const url = new URL(req.url ?? "/", "http://localhost");

  const contentLength = Number(req.headers["content-length"] ?? "0");
  if (req.method === "POST" && contentLength > MEMORY_SYNC_BODY_LIMIT) {
    json(res, 413, { error: "body too large" });
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/memory-sync") {
    // Cross-host memory sync: the body is the peer's shareable JSONL, stored
    // verbatim under inbox/<peer node id>.jsonl. The payload stays opaque, so the
    // sender identity and pairing proof travel in headers (x-mesh-sender carries
    // the mail `from`, x-mesh-proof the same pairing proof) and authentication
    // runs through the same machinery as /mail — including the pending-token
    // bind, so the first accepted push symmetric-tokenizes the pair exactly like
    // the first mail does. The authenticated peer's node id names the file; no
    // identity fields travel inside the payload.
    if (options.dataDir === undefined) {
      json(res, 503, { error: "memory-sync storage not configured" });
      return;
    }
    const body = await readBody(req, MEMORY_SYNC_BODY_LIMIT);
    if ("error" in body) {
      json(res, body.error === "too_large" ? 413 : 400, {
        error: body.error === "too_large" ? "body too large" : "malformed request body",
      });
      return;
    }
    const peer = authenticate(
      db,
      req,
      typeof req.headers["x-mesh-sender"] === "string" ? req.headers["x-mesh-sender"] : null,
      typeof req.headers["x-mesh-proof"] === "string" ? req.headers["x-mesh-proof"] : undefined,
    );
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const accepted = receiveMemorySync(options.dataDir, peer.node_id, body.body);
      json(res, 200, { accepted });
    } catch {
      json(res, 500, { error: "memory-sync storage failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ack") {
    // Refonte2-C6: the receiver APPLIED an event and acks its origin — the
    // outbox row goes sent (the push alone is at-most-once; the ack makes
    // it effectively-once).
    const from = String(req.headers["x-mesh-sender"] ?? "");
    const proof = String(req.headers["x-mesh-proof"] ?? "");
    const peer = authenticate(db, req, from, proof);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readBody(req, 64 * 1024);
    if ("error" in body) {
      json(res, 400, { error: "body too large" });
      return;
    }
    try {
      const parsed = JSON.parse(body.body) as { origin_id?: string };
      if (!parsed.origin_id) {
        json(res, 400, { error: "origin_id required" });
        return;
      }
      const applied = markOutboxSentByOrigin(db, parsed.origin_id, Date.now());
      json(res, 200, { ok: true, applied });
    } catch {
      json(res, 500, { error: "ack failed" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/stream") {
    // The persistent stream (refonte 3.1, SSE): the peer holds ONE
    // connection per direction; the server pushes the mail / the task
    // states / the registry the moment they exist. The auth: the pairing
    // headers (a GET has no body).
    const from = String(req.headers["x-mesh-sender"] ?? "");
    const proof = String(req.headers["x-mesh-proof"] ?? "");
    const peer = authenticate(db, req, from, proof);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    options.hub?.add(peer.node_id, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/task-ask") {
    // Refonte P2.5: a peer's ask creates a MIRROR task row (the same id —
    // the reply correlation is the id) and delivers the task message to the
    // local responder's box. The auth = the pairing machinery like /mail.
    const body = await readBody(req, 256 * 1024);
    if ("error" in body) {
      json(res, body.error === "too_large" ? 413 : 400, { error: "body too large" });
      return;
    }
    // The auth rides the HEADERS (the task payloads carry no mail-shaped
    // proof field — postTaskWire signs the headers like /mail does).
    const from = String(req.headers["x-mesh-sender"] ?? "");
    const proof = String(req.headers["x-mesh-proof"] ?? "");
    const peer = authenticate(db, req, from, proof);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const parsed = JSON.parse(body.body) as {
        from_box?: string;
        task?: {
          id: string;
          to_box: string;
          question: string;
          group_id?: string | null;
          deadline?: number | null;
        };
      };
      if (!parsed.task?.id || !parsed.task.to_box) {
        json(res, 400, { error: "task payload malformed" });
        return;
      }
      // The OWNER gate (the 0.33.5): the asked box must be LOCAL here — an
      // ask routed to the WRONG node never reaches a responder (the mirror
      // would sink into the legacy global inbox and the ask would die at
      // the deadline in silence). Bounce instead: the asker learns NOW.
      if (!mailboxByName(db, parsed.task.to_box)) {
        queueBounce(db, {
          nodeId: peer.node_id,
          toBox: parsed.from_box ?? "",
          hostname: options.self.hostname,
          subject: `task ${parsed.task.id.slice(0, 8)}`,
          body: `la task n'a pas été créée ici — la boîte cible n'est pas locale à ce nœud`,
          missingBox: parsed.task.to_box,
        });
        json(res, 200, { ok: true, bounced: true });
        return;
      }
      // The asker's remote reference (the 0.33.3-B): the bare box rides in
      // from_box, the authenticated peer's node id is the asker_node —
      // no composite, the columns drive the reply routing.
      handleTaskAsk(
        db,
        {
          node_id: peer.node_id,
          to_box: parsed.task.to_box,
          from_box: parsed.from_box ?? null,
          subject: `task ${parsed.task.id.slice(0, 8)}`,
          body: parsed.task.question ?? "",
          origin_id: parsed.task.id,
          type: "task-ask",
          task: {
            id: parsed.task.id,
            from_box: parsed.from_box ?? null,
            to_box: parsed.task.to_box,
            question: parsed.task.question,
            group_id: parsed.task.group_id ?? null,
            deadline: parsed.task.deadline ?? null,
          },
        } as OutboxPayload,
        peer.node_id,
      );
      json(res, 200, { ok: true });
    } catch {
      json(res, 500, { error: "task-ask failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/task-reply") {
    // Refonte P2.5: a peer's reply applies to the ORIGINAL task row (the
    // source of truth) and notifies the local asker (the group digest rules).
    const body = await readBody(req, 256 * 1024);
    if ("error" in body) {
      json(res, body.error === "too_large" ? 413 : 400, { error: "body too large" });
      return;
    }
    const from = String(req.headers["x-mesh-sender"] ?? "");
    const proof = String(req.headers["x-mesh-proof"] ?? "");
    const peer = authenticate(db, req, from, proof);
    if (!peer) {
      // The token/proof VALUES never hit the log: the presence and the
      // length only (a valid token with a bad proof must not leak its
      // prefix onto disk).
      console.warn(
        `[task-reply 401] from present=${from.length > 0} proof.len=${proof.length} auth present=${"authorization" in req.headers}`,
      );
      json(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const parsed = JSON.parse(body.body) as {
        task?: { id: string; result?: string; state?: string };
      };
      if (!parsed.task?.id) {
        json(res, 400, { error: "task payload malformed" });
        return;
      }
      const task = getTask(db, parsed.task.id);
      if (!task) {
        json(res, 404, { error: "unknown task" });
        return;
      }
      // The owner check (the 0.33.3-D): the authenticated peer must be the
      // task's TARGET node (the responder, filled at mesh_ask) — no box
      // resolution at reply time, a third-party node mismatched = 403.
      if ((task.target_node ?? null) !== peer.node_id) {
        json(res, 403, { error: "only the task's owning node may reply" });
        return;
      }
      // The state enum (the refonte2-P3): a bogus state would block the
      // task open-and-terminal forever (the sweeper ignores it).
      const VALID_STATES = ["working", "input_required", "completed", "failed", "canceled"];
      if (!VALID_STATES.includes(parsed.task.state ?? "completed")) {
        json(res, 400, { error: `state must be one of ${VALID_STATES.join(" | ")}` });
        return;
      }
      replyTask(
        db,
        parsed.task.id,
        task.to_box,
        parsed.task.result ?? "",
        (parsed.task.state ?? "completed") as TaskState,
      );
      json(res, 200, { ok: true });
    } catch {
      json(res, 500, { error: "task-reply failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/registry-sync") {
    // Registry federation (0.30.0): a paired peer pushes its LOCAL mailbox
    // rows at rebind (mesh_register/mesh_join). Authentication runs through
    // the same pairing machinery as /mail (the token + the proof headers);
    // the authenticated peer's node id owns every row it pushes. The merge
    // is the LWW single-writer: this node's own names never lose to an
    // inbound row (the ownership transfers only through a strictly newer
    // registration — an explicit rebind on the other side).
    const body = await readBody(req, 256 * 1024);
    if ("error" in body) {
      json(res, body.error === "too_large" ? 413 : 400, {
        error: body.error === "too_large" ? "body too large" : "malformed request body",
      });
      return;
    }
    const peer = authenticate(
      db,
      req,
      typeof req.headers["x-mesh-sender"] === "string" ? req.headers["x-mesh-sender"] : null,
      typeof req.headers["x-mesh-proof"] === "string" ? req.headers["x-mesh-proof"] : undefined,
    );
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    let rows: unknown;
    try {
      const parsed = JSON.parse(body.body) as { registry?: unknown };
      rows = parsed.registry;
    } catch {
      json(res, 400, { error: "malformed request body" });
      return;
    }
    if (!Array.isArray(rows)) {
      json(res, 400, { error: "registry must be an array" });
      return;
    }
    // mergeFederatedRegistry wraps its own body in withTransaction (0.31.0):
    // a nested one here would trip the leak guard (inTransaction true at
    // entry) and 500 every push.
    try {
      const applied = mergeFederatedRegistry(
        db,
        rows as Parameters<typeof mergeFederatedRegistry>[1],
        peer.node_id,
      );
      json(res, 200, { applied });
    } catch {
      json(res, 500, { error: "registry merge failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/mail") {
    const body = await readBody(req);
    if ("error" in body) {
      // A body over the limit is 413; a read failure (client aborted mid-body)
      // is a malformed request, not an oversized one.
      json(res, body.error === "too_large" ? 413 : 400, {
        error: body.error === "too_large" ? "body too large" : "malformed request body",
      });
      return;
    }
    const parsed = parseMail(body.body);
    if (!parsed) {
      json(res, 400, { error: "invalid mail body" });
      return;
    }
    // Authenticate with the claimed sender so a pending pairing token can only
    // bind to a node this host already knows. The pairing proof (sender-signed
    // over node_id+token) is what authorizes binding a pairing to that node.
    const mailPeer = authenticate(db, req, parsed.from, parsed.proof);
    if (!mailPeer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (parsed.from !== mailPeer.node_id) {
      json(res, 401, { error: "from does not match token" });
      return;
    }
    // Addressed mail first: a known box routes to per-box deliveries, an
    // unknown box falls back to the legacy global inbox so remote mail is
    // never lost, and a broadcast with no local members is not an error.
    const kind: "notify" | "fyi" = parsed.kind === "fyi" ? "fyi" : "notify";
    const result = deliverMessage(db, {
      from: parsed.from,
      from_box: parsed.from_box ?? null,
      to_box: parsed.to ?? null,
      subject: parsed.subject,
      body: parsed.body,
      reply_to: parsed.reply_to ?? null,
      origin_id: parsed.origin_id ?? null,
      kind,
      // The addressed DM wakes (0.34.1): POST /mail used to drop the kind and
      // wake on everything but the deliberate broadcasts, so a cross-host DM
      // never reached the pool gate as wakeable (the wake-dead incident).
      wake: parsed.wake === true || addressedNotifyWake(kind, parsed.to ?? null),
    });
    // The BOUNCE (the 0.33.5): an ADDRESSED mail for a box this node does
    // not own is not silently sunk into the legacy global inbox — the
    // sender's box gets a bounce (the wrong-peer class: the ack said
    // "queued" while the mail was invisible to every agent).
    if (!result.ok && result.error === "unknown_mailbox" && parsed.to && parsed.from_box) {
      queueBounce(db, {
        nodeId: mailPeer.node_id,
        toBox: parsed.from_box,
        hostname: options.self.hostname,
        subject: parsed.subject,
        body: parsed.body,
        missingBox: parsed.to,
      });
    }
    let delivered = 0;
    if (!result.ok && result.error === "unknown_mailbox") {
      receiveMessage(db, {
        from: parsed.from,
        subject: parsed.subject,
        body: parsed.body,
        ...(parsed.from_box !== undefined ? { from_box: parsed.from_box } : {}),
        ...(parsed.reply_to !== undefined ? { reply_to: parsed.reply_to } : {}),
      });
    } else if (result.ok) {
      delivered = result.recipients.length;
    }
    // Federation: a broadcast that produced local deliveries is forwarded to
    // the paired peers that also hold members (dedup via origin_id + via).
    if (
      fanout &&
      result.ok &&
      delivered > 0 &&
      parsed.to !== undefined &&
      (parsed.to === "all" || parsed.to.startsWith("team:"))
    ) {
      void fanout
        .fanout({
          to_box: parsed.to,
          origin_id: parsed.origin_id ?? result.id,
          from_box: parsed.from_box ?? null,
          subject: parsed.subject,
          body: parsed.body,
          via: parsed.via ?? null,
          ...(parsed.wake === true ? { wake: true } : {}),
        })
        .catch(() => {});
    }
    json(res, 200, {
      ok: true,
      unread: unreadCount(db) + unreadDeliveries(db),
      delivered,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/spawn") {
    // Distant spawn (0.24.0): a paired peer births an enrolled fleet agent
    // HERE. Authentication is two-layer: the pairing token (bearer, with the
    // standard proof so a pending token can bind), then an Ed25519 signature
    // over the canonical body payload, verified against the PINNED key of the
    // requesting peer (no TOFU). Replay defense: the request ts must sit
    // inside a 5 min window and its nonce must be unseen.
    const body = await readBody(req);
    if ("error" in body) {
      console.error("[mesh] spawn: refused malformed request body");
      json(res, body.error === "too_large" ? 413 : 400, {
        error: body.error === "too_large" ? "body too large" : "malformed request body",
      });
      return;
    }
    const parsed = parseSpawnRequest(body.body);
    if (!parsed) {
      console.error("[mesh] spawn: refused invalid spawn request");
      json(res, 400, { error: "invalid spawn request" });
      return;
    }
    // One server-side line per POST /spawn (the 0.24.5 lesson): the mesh
    // server used to log NOTHING between nonce validation and worker
    // creation, so a live failure left no trace on the peer at all.
    const spawnLog = (outcome: string): void => {
      console.error(`[mesh] spawn from ${parsed.from} (name=${parsed.spec.name}): ${outcome}`);
    };
    const peer = authenticate(db, req, parsed.from, parsed.proof);
    if (!peer || parsed.from !== peer.node_id) {
      spawnLog("refused: unauthorized");
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const distant = options.distantSpawn;
    // Deny-by-default: the operator opts in with acceptSpawn.
    if (!distant || distant.acceptSpawn !== true) {
      spawnLog("refused: acceptSpawn disabled");
      json(res, 403, { error: "spawn refused: acceptSpawn disabled" });
      return;
    }
    if (options.dataDir === undefined) {
      spawnLog("refused: spawn storage not configured");
      json(res, 503, { error: "spawn storage not configured" });
      return;
    }
    const peerRow = findPeerById(db, parsed.from);
    const verifyError = verifySpawnRequest(peerRow, parsed, Date.now());
    if (verifyError !== null) {
      spawnLog(`refused: ${verifyError}`);
      json(res, 403, { error: verifyError });
      return;
    }
    try {
      if (!spawnReplay.claim(parsed.from, parsed.nonce, Date.now())) {
        spawnLog("refused: replayed nonce");
        json(res, 403, { error: "spawn refused: replayed nonce" });
        return;
      }
      const quota = distant.quotaPeer ?? DEFAULT_SPAWN_QUOTA_PEER;
      if (countRunningSpawnedByPeer(db, parsed.from) >= quota) {
        spawnLog(`refused: spawn quota reached (${quota})`);
        json(res, 403, { error: `spawn refused: spawn quota reached (${quota})` });
        return;
      }
      const dsDeps = {
        db,
        dataDir: options.dataDir,
        identity: {
          node_id: options.self.node_id,
          hostname: options.self.hostname,
          public_key: options.self.pk,
          private_key: distant.privateKey,
        },
        worktreeClient: distant.worktreeClient,
        spawnFn: distant.spawnFn,
        ...(distant.worktreeDomain !== undefined ? { worktreeDomain: distant.worktreeDomain } : {}),
        ...(distant.spawnWorktreeBase !== undefined
          ? { spawnWorktreeBase: distant.spawnWorktreeBase }
          : {}),
      };
      const result = await runDistantSpawn(dsDeps, parsed);
      if (!result.ok) {
        // A spec refusal is the caller's fault (403); a spawn failure is ours.
        const refusal = result.error.startsWith("spawn refused:");
        spawnLog(`${refusal ? "refused" : "failed"}: ${result.error}`);
        json(res, refusal ? 403 : 500, { error: result.error });
        return;
      }
      // Ack DM to the parent's mailbox (best effort, never blocks the verdict).
      void ackSpawned(dsDeps, parsed, result.worker.id).catch(() => {});
      spawnLog(`ok: worker ${result.worker.id}`);
      json(res, 200, {
        ok: true,
        worker_id: result.worker.id,
        hostname: options.self.hostname,
        name: parsed.spec.name,
      });
      return;
    } catch (cause) {
      // From the claimed nonce onward a silent failure would leave the parent
      // with an empty verdict and the peer without a trace (the 0.24.5 live
      // failure). Answer 500 with the REAL cause, never an empty string.
      const message = spawnCause(cause);
      spawnLog(`failed: ${message}`);
      json(res, 500, { error: `spawn failed: ${message}` });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/pair-code") {
    // Pairing bootstrap: the 6-digit code is the capability. Rate-limited per
    // source address (5 consumed attempts per 5 minutes) to blunt brute force.
    const body = await readBody(req);
    if ("error" in body) {
      json(res, 400, { error: "malformed request body" });
      return;
    }
    let parsed: { code?: string; offer?: string } = {};
    try {
      parsed = JSON.parse(body.body) as { code?: string; offer?: string };
    } catch {}
    const code = typeof parsed.code === "string" ? parsed.code : "";
    const offer = typeof parsed.offer === "string" ? parsed.offer : "";
    if (!/^\d{6}$/.test(code) || !offer.startsWith("MESH1-")) {
      json(res, 400, { error: "invalid pairing request" });
      return;
    }
    const remote = req.socket.remoteAddress ?? "unknown";
    if (pairCodeThrottled(remote)) {
      json(res, 429, { error: "too many pairing attempts" });
      return;
    }
    const pending = findPendingByCode(db, code);
    if (pending === null) {
      json(res, 404, { error: "unknown pairing code" });
      return;
    }
    const counter = consumePairingOffer(
      options,
      pending.token,
      offer,
      remote,
      req.socket.localAddress ?? "",
    );
    if (counter === null) {
      json(res, 400, { error: "invalid offer" });
      return;
    }
    json(res, 200, { ok: true, counter_offer: counter });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pools") {
    const peer = authenticate(db, req);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const pools: Record<string, string[]> = {};
    for (const box of listMailboxes(db)) {
      for (const pool of box.pools) {
        const members = pools[pool] ?? [];
        members.push(box.name);
        pools[pool] = members;
      }
    }
    json(res, 200, { pools });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const peer = authenticate(db, req);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    json(res, 200, {
      node_id: peer.node_id,
      unread: unreadCount(db),
      ...(options.capa ? { capa: await options.capa() } : {}),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    // Prometheus text format (the lingua franca: VictoriaMetrics ingests it
    // natively). Same bearer-token auth as /status — Prometheus sends the
    // Authorization header natively.
    const peer = authenticate(db, req);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; version=1.0.0; charset=utf-8" });
    res.end(await renderMetrics(db, options.capa));
    return;
  }

  json(res, 404, { error: "not found" });
}

function authenticate(
  db: MeshDb,
  req: IncomingMessage,
  from: string | null = null,
  proof?: string,
): { node_id: string } | null {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) {
    return null;
  }
  const peer = authenticateToken(db, match[1], from, proof);
  return peer ? { node_id: peer.node_id } : null;
}

type BodyResult = { body: string } | { error: "too_large" | "read" };

function readBody(req: IncomingMessage, limit: number = BODY_LIMIT): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let limited = false;

    req.on("data", (chunk: Buffer) => {
      if (limited) return;
      size += chunk.length;
      if (size > limit) {
        // Resolve at once and let the HTTP layer tear the connection down
        // with the 413: an explicit socket destroy here would race the
        // response (the client would see a reset instead of the 413), while
        // node drops an unconsumed request body as soon as the response ends.
        // Buffering stops here, so a lying content-length or an endless
        // stream cannot grow memory.
        limited = true;
        chunks.length = 0;
        resolve({ error: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(limited ? { error: "too_large" } : { body: Buffer.concat(chunks).toString("utf8") }),
    );
    // A socket error, an aborted request, or a bare close all end the read
    // without `end`. `close` is the last-resort fallback; resolving twice is a
    // no-op, so a normal request that already ended is unaffected.
    req.on("error", () => resolve({ error: "read" }));
    req.on("aborted", () => resolve({ error: "read" }));
    req.on("close", () => resolve({ error: "read" }));
  });
}

// Unread deliveries across every box, added to the legacy global count for
// the /mail and /status unread totals.
function unreadDeliveries(db: MeshDb): number {
  return (
    db.conn.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM deliveries WHERE status = 'unread'",
    )?.count ?? 0
  );
}

// Prometheus text exposition: HELP + TYPE + one sample line per metric. The
// capa gauges render only when the shared provider answered with them (a
// CPU-only machine has no gpu metric); the db counters always render.
async function renderMetrics(db: MeshDb, capa?: () => Promise<HostCapa>): Promise<string> {
  const lines: string[] = [];
  const push = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
  };
  push(
    "opencode_mesh_messages_total",
    "Messages stored on this node (all statuses)",
    db.conn.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages")?.count ?? 0,
  );
  push(
    "opencode_mesh_deliveries_unread",
    "Unread box deliveries across every mailbox",
    unreadDeliveries(db),
  );
  if (capa) {
    const s = await capa();
    push("opencode_mesh_cpu_load_avg", "One-minute load average", s.cpu.loadAvg);
    push("opencode_mesh_ram_used_mb", "Resident memory in use, MB", s.ram.usedMb);
    push("opencode_mesh_ram_total_mb", "Total resident memory, MB", s.ram.totalMb);
    if (s.gpu) {
      push("opencode_mesh_gpu_vram_used_mb", "GPU VRAM in use, MB", s.gpu.vramUsedMb);
    }
    push(
      "opencode_mesh_workers_in_flight",
      "mesh_workers rows in running state",
      s.workersInFlight,
    );
    push("opencode_mesh_sessions_running", "Sessions currently mid-turn", s.sessionsRunning);
  }
  return `${lines.join("\n")}\n`;
}

/** An addressed notify wakes its single box: `all` and pool ids (`team:*`)
 * are broadcasts, they only wake when the sender flags them. */
export function addressedNotifyWake(kind: string, to: string | null): boolean {
  return (
    kind === "notify" &&
    typeof to === "string" &&
    to.length > 0 &&
    to !== "all" &&
    !to.startsWith("team:")
  );
}

function parseMail(raw: string): MailBody | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MailBody>;
    if (
      typeof parsed.from !== "string" ||
      typeof parsed.subject !== "string" ||
      typeof parsed.body !== "string"
    ) {
      return null;
    }
    return {
      from: parsed.from,
      subject: parsed.subject,
      body: parsed.body,
      ...(typeof parsed.proof === "string" ? { proof: parsed.proof } : {}),
      ...(typeof parsed.origin_id === "string" ? { origin_id: parsed.origin_id } : {}),
      ...(Array.isArray(parsed.via)
        ? { via: parsed.via.filter((v): v is string => typeof v === "string") }
        : {}),
      ...(typeof parsed.to === "string" ? { to: parsed.to } : {}),
      ...(typeof parsed.from_box === "string" ? { from_box: parsed.from_box } : {}),
      ...(typeof parsed.reply_to === "string" ? { reply_to: parsed.reply_to } : {}),
      ...(parsed.wake === true ? { wake: true } : {}),
      ...(typeof parsed.kind === "string" ? { kind: parsed.kind } : {}),
    };
  } catch {
    return null;
  }
}

type MailBody = {
  from: string;
  subject: string;
  body: string;
  proof?: string;
  to?: string;
  from_box?: string;
  reply_to?: string;
  via?: string[];
  origin_id?: string;
  wake?: boolean;
  kind?: string;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---- pairing-code bootstrap ----

// Bounded LRU (0.18.0): a flood of spoofed source addresses (e.g. behind a
// proxy that forwards X-Forwarded-For-like values) must not grow the map
// without limit. Oldest entry evicted at the cap.
const PAIR_ATTEMPTS_MAX = 1000;
const PAIR_ATTEMPTS = new Map<string, { count: number; windowStart: number }>();

// Exported for the LRU-bound unit test; production callers go through the
// /pair-code route only.
export function pairCodeThrottled(remote: string): boolean {
  const now = Date.now();
  const entry = PAIR_ATTEMPTS.get(remote);
  if (entry === undefined || now - entry.windowStart > 5 * 60_000) {
    if (PAIR_ATTEMPTS.size >= PAIR_ATTEMPTS_MAX && !PAIR_ATTEMPTS.has(remote)) {
      const oldest = PAIR_ATTEMPTS.keys().next().value;
      if (oldest !== undefined) PAIR_ATTEMPTS.delete(oldest);
    }
    PAIR_ATTEMPTS.set(remote, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > 5;
}

/** Consume the code's pending offer, bind the caller from its offer blob, and
 * mint a counter-offer blob so the caller can bind us back. */
