import { existsSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { postPairCode, postRegistrySync, postSpawn, sendMail } from "./lib/client.js";
import { buildSpawnRequest, validateSpawnSpec, type SpawnSpec } from "./lib/distant-spawn.js";
import type { MeshDb } from "./lib/db.js";
import type { Fanout } from "./lib/fanout.js";
import { buildOfferBlob, parseOfferBlob } from "./lib/offer-blob.js";
import { listOwnAddresses, type AddressOptions } from "./lib/providers.js";
import { pluginVersion } from "./lib/version.js";
import { pairingProof, type NodeIdentity } from "./lib/identity.js";
import { queueOutbox, queueTaskAsk, queueTaskReply, sweepOutbox } from "./lib/outbox.js";
import { BOARD_KEYS, boardGet, boardSet, type BoardKey } from "./lib/mail.js";
import {
  deliverMessage,
  inboxRead,
  joinPool,
  leavePool,
  listMailboxes,
  mailboxesBySession,
  localRegistryRows,
  federatedByName,
  lastUnansweredFrom,
  mailboxByName,
  mailboxBySession,
  poolExists,
  registerMailbox,
  touchMailbox,
  unreadCount,
  unreadMessages,
  askTask,
  getTask,
  listTasks,
  replyTask,
  type TaskState,
} from "./lib/mail.js";
import { journalQuery } from "./lib/journal.js";
import { listLocks, releaseLock, tryLock } from "./lib/locks.js";
import {
  createPairingCode,
  createPairingToken,
  findPendingByCode,
  findSendablePeer,
  keyFingerprint,
  listPeers,
  pairWithToken,
  resolvePeerTarget,
} from "./lib/peers.js";
import {
  readLogTail,
  removeWorkerLog,
  runWorker,
  stopWorker,
  type EnrollIdentity,
  type SpawnFn,
} from "./lib/spawn.js";
import type { SpawnMode } from "./lib/workers.js";
import type { HostCapa } from "./lib/capa.js";
import {
  createWorkerWorktree,
  removeWorkerWorktree,
  type WorktreeClient,
  type WorktreeInfo,
} from "./lib/worktree.js";
import {
  deleteWorker,
  getWorker,
  listWorkers,
  countRunningEnrolled,
  reapEnrolledPools,
} from "./lib/workers.js";

// One definition of the mesh tools, consumed by both host adapters (plugin.ts
// for OpenCode 1.x, plugin-v2.ts for 2.x). Descriptions, argument shapes and
// behavior live here so the two entry points cannot drift apart.
export type ToolField = {
  name: string;
  type: "string" | "number" | "boolean" | "array";
  required: boolean;
  description: string;
};

export type ToolContext = { sessionID: string };

export type ToolSpec = {
  name: string;
  description: string;
  fields: ToolField[];
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>;
};

export type MeshContext = {
  db: MeshDb;
  identity: NodeIdentity;
  dataDir: string;
  serverAddress: string;
  port: number;
  /** Pool federation (optional): forwards local broadcasts to paired peers. */
  fanout?: Fanout;
  /** Instance binding key (project id + directory): mesh_register stamps it so
   * a later TUI bind from the same instance re-binds the box to its live
   * session (restart-proof wake). */
  bindKey: string;
  worktreeClient: WorktreeClient;
  spawnFn: SpawnFn;
  /** This instance's opencode project id (0.24.8, v2 hosts): signed into
   * distant spawn requests so the peer births the child under THIS project
   * (a git remote hash, stable across hosts). Absent on 1.x hosts. */
  projectID?: string;
  /** Address providers config + static tunnel addresses: the advertised
   * candidate IPs (mesh_status `tailnet_addresses`). */
  addressing?: AddressOptions;
  /** Shared host-capability provider (createHostCapa): mesh_status reads the
   * same 60 s cache as /status and /metrics. Absent = no capa field. */
  capa?: () => Promise<HostCapa>;
  /** Maximum concurrently running enrolled workers (default 4). */
  spawnMax?: number;
  /** Restart the mDNS browse: an unreachable send usually means a stale
   * address (DHCP churn), and a fresh browse re-hears the peer's announce. */
  rebrowse?: () => void;
};

function str(name: string, description: string, required = true): ToolField {
  return { name, type: "string", required, description };
}

function num(name: string, description: string): ToolField {
  return { name, type: "number", required: false, description };
}

function bool(name: string, description: string): ToolField {
  return { name, type: "boolean", required: false, description };
}

function strArr(name: string, description: string, required = false): ToolField {
  return { name, type: "array", required, description };
}

// The host normally always provides a session id; normalizing keeps tools
// usable in contexts without one (tests, exotic hosts) instead of crashing
// on a SQLite bind with undefined.
/** The session's most recently touched box: the natural default after a
 * mesh_register (CLI flows register then join/send on the same box). */
function defaultBoxName(db: MeshDb, sessionID: string): string | null {
  const boxes = mailboxesBySession(db, sessionID);
  if (boxes.length === 0) return null;
  return [...boxes].sort((a, b) => b.last_seen - a.last_seen)[0]?.name ?? null;
}

/** Resolve the sending/joining box: the named one, or the session's most
 * recently touched box (the natural default after a mesh_register). */
function resolveBox(db: MeshDb, sessionID: string, boxArg?: string): string | null {
  if (boxArg !== undefined && boxArg.length > 0) return boxArg;
  return defaultBoxName(db, sessionID);
}

function peerLabelShort(nodeId: string, hostname?: string | null): string {
  const host =
    hostname !== null && hostname !== undefined && hostname.length > 0 ? hostname : nodeId;
  return host === "manual" ? nodeId.slice(0, 8) : host;
}

function sessionID(context: ToolContext): string {
  return typeof context?.sessionID === "string" && context.sessionID.length > 0
    ? context.sessionID
    : "";
}

/** The registry federation push (0.30.0): the local mailbox rows travel to
 * every paired peer (best-effort — a failed push retries at the next
 * rebind). The counterpart lives at POST /registry-sync on each peer. */
function pushRegistryToPeers(db: MeshDb, identity: NodeIdentity): void {
  const rows = localRegistryRows(db);
  if (rows.length === 0) return;
  for (const peer of listPeers(db)) {
    const conn = resolvePeerTarget(db, peer.node_id);
    if (conn === null) continue;
    void postRegistrySync({
      url: conn.url,
      ...(conn.tls ? { tls: true } : {}),
      ...(conn.pk !== null ? { pk: conn.pk } : {}),
      token: peer.token ?? "",
      from: identity.node_id,
      proof: pairingProof(identity, peer.token ?? ""),
      registry: rows,
    }).catch(() => {});
  }
}

/** The orchestration tools stay off a WORKER's surface (0.30.0): an enrolled
 * child registers, drains, waits, replies and reads the journal — it does not
 * spawn, pair, or manage workers (about 4k characters less on every request
 * of every worker). Shared by the v1 and v2 plugin surfaces. */
export const WORKER_TOOL_BLOCKLIST = new Set([
  "mesh_spawn",
  "mesh_pair",
  "mesh_workers",
  "mesh_worker_logs",
  "mesh_worker_stop",
  "mesh_worker_remove",
]);

export function buildToolSpecs(mesh: MeshContext): ToolSpec[] {
  const {
    db,
    identity,
    dataDir,
    serverAddress,
    port,
    bindKey,
    fanout,
    worktreeClient,
    spawnFn,
    addressing,
    capa: capa_,
    spawnMax,
    projectID,
  } = mesh;
  return [
    {
      name: "mesh_status",
      description: "Show this node's identity, address, host capabilities and peers.",
      fields: [],
      execute: async (args, context) => {
        const peers = listPeers(db);
        const ownAddresses = await listOwnAddresses(addressing);
        const now = Date.now();
        const capa = capa_ ? await capa_().catch(() => null) : null;
        return JSON.stringify(
          {
            node_id: identity.node_id,
            session: sessionID(context),
            hostname: identity.hostname,
            fingerprint: identity.fingerprint,
            server: `${serverAddress}:${port}`,
            // Field name kept from the tailscale-only era (0.15.0 widened its
            // contents to every provider + static addresses).
            tailnet_addresses: ownAddresses,
            peers: peers.map((p) => ({
              node_id: p.node_id,
              hostname: p.hostname,
              paired: p.paired,
              addresses: p.addresses,
            })),
            plugin_version: pluginVersion(),
            ...(await sweepOutbox(db, identity, () => {})),
            outbox: {
              queued:
                db.conn.get<{ n: number }>(
                  "SELECT COUNT(*) AS n FROM outbox WHERE state = 'queued'",
                )?.n ?? 0,
              failed:
                db.conn.get<{ n: number }>(
                  "SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'",
                )?.n ?? 0,
            },
            mailboxes: listMailboxes(db).map((b) => ({
              name: b.name,
              role: b.role,
              pools: b.pools,
              ...(b.primary_pool ? { primary: b.primary_pool } : {}),
              last_seen: b.last_seen,
              age_s: Math.round((now - b.last_seen) / 1000),
            })),
            unread: unreadCount(db),
            locks: listLocks(db, { now: Date.now() }),
            ...(capa !== null ? { capa } : {}),
          },
          null,
          2,
        );
      },
    },

    {
      name: "mesh_pair",
      description:
        "Pair two nodes. Bare: emit a 6-digit code (30 min). code=: complete (LAN autodiscovers; cross-subnet: address=). offer=: complete a MESH1- blob. Legacy node_id/token.",
      fields: [
        str("code", "Code shown by the peer's mesh_pair()", false),
        str("address", "Peer host:port (cross-subnet; LAN autodiscovers)", false),
        str("offer", "MESH1- blob from the peer's output", false),
        str("node_id", "Peer node id (legacy)", false),
        str("token", "Pairing token (legacy)", false),
        str("pk", "Peer public key (legacy)", false),
      ],
      execute: async (args) => {
        // Code flow: one 6-digit code, both directions.
        if (typeof args.code === "string" && args.code.length > 0) {
          if (!/^\d{6}$/.test(args.code)) {
            return "error: the pairing code is 6 digits";
          }
          // Candidate targets: an explicit cross-subnet address (assumed TLS:
          // 0.11+ default), else every address we know per peer, honoring its
          // advertised tls flag (TOFU pin when the peer's key is already known).
          const candidates: { url: string; tls?: boolean; pk?: string }[] = [];
          if (typeof args.address === "string" && args.address.length > 0) {
            candidates.push({ url: `https://${args.address}`, tls: true });
          } else {
            for (const peer of listPeers(db)) {
              for (const address of peer.addresses) {
                candidates.push({
                  url: `${peer.tls ? "https" : "http"}://${address}`,
                  ...(peer.tls ? { tls: true } : {}),
                  ...(peer.tls && peer.public_key !== null ? { pk: peer.public_key } : {}),
                });
              }
            }
          }
          if (candidates.length === 0) {
            return 'error: no candidate address — pass address="host:port" (cross-subnet) or wait for mDNS discovery (LAN)';
          }
          for (const candidate of candidates) {
            const myOffer = buildOfferBlob(db, {
              node_id: identity.node_id,
              pk: identity.public_key,
              hostname: identity.hostname,
              address: `${serverAddress}:${port}`,
            });
            const result = await postPairCode({
              url: candidate.url,
              code: args.code,
              offer: myOffer,
              ...(candidate.tls !== undefined ? { tls: candidate.tls } : {}),
            });
            if (result === null) continue;
            const counter = parseOfferBlob(result.counter_offer);
            if (counter === null) continue;
            // TOFU pin: the cert presented at first contact must BE the node
            // key the counter-offer attests — otherwise someone terminated our
            // TLS and minted their own offer.
            if (result.peer_pk !== undefined && result.peer_pk !== counter.pk) continue;
            pairWithToken(db, {
              node_id: counter.node_id,
              hostname: counter.hostname ?? "manual",
              fingerprint: "code-pairing",
              token: counter.token,
              addresses: [counter.address ?? candidate.url.replace(/^https?:\/\//, "")],
              public_key: counter.pk,
            });
            pushRegistryToPeers(db, identity);
            return [
              `pairé des deux côtés avec ${peerLabelShort(counter.node_id, counter.hostname)}`,
              `peer fingerprint: ${keyFingerprint(counter.pk)} (TOFU pinning: check this fingerprint if you're paranoid)`,
            ].join("\n");
          }
          return "error: code refusé ou injoignable (expire au bout de 30 min; vérifie l'address= en cross-subnet)";
        }

        // Blob flow (agents): complete the peer's MESH1- offer, auto-emit our counter.
        if (typeof args.offer === "string" && args.offer.length > 0) {
          const parsed = parseOfferBlob(args.offer);
          if (parsed === null) {
            return "error: offer blob invalide (attendu MESH1-...)";
          }
          pairWithToken(db, {
            node_id: parsed.node_id,
            hostname: parsed.hostname ?? "manual",
            fingerprint: "code-pairing",
            token: parsed.token,
            addresses: parsed.address !== undefined ? [parsed.address] : [],
            public_key: parsed.pk,
          });
          const counter = buildOfferBlob(db, {
            node_id: identity.node_id,
            pk: identity.public_key,
            hostname: identity.hostname,
            address: `${serverAddress}:${port}`,
          });
          pushRegistryToPeers(db, identity);
          return [
            `pairé avec ${peerLabelShort(parsed.node_id, parsed.hostname)}. Contre-offre pour l'autre côté: mesh_pair(offer="${counter}")`,
            `peer fingerprint: ${keyFingerprint(parsed.pk)} (TOFU pinning: check this fingerprint if you're paranoid)`,
          ].join("\n");
        }

        // Legacy completion (older mesh versions).
        const node_id = args.node_id;
        const token = args.token;
        const hasNodeId = typeof node_id === "string";
        const hasToken = typeof token === "string";
        if (hasNodeId || hasToken) {
          if (!hasNodeId || !hasToken || node_id.length === 0 || token.length === 0) {
            return "error: mesh_pair needs a non-empty node_id and token to complete pairing (or neither to emit an offer)";
          }
          pairWithToken(db, {
            node_id,
            hostname: "manual",
            fingerprint: "manual",
            token,
            addresses: typeof args.address === "string" ? [args.address] : [],
            ...(typeof args.pk === "string" && args.pk.length > 0 ? { public_key: args.pk } : {}),
          });
          const paired = `paired with ${node_id}`;
          // Legacy pk is optional: no key attested, no fingerprint to show.
          return typeof args.pk === "string" && args.pk.length > 0
            ? `${paired}\npeer fingerprint: ${keyFingerprint(args.pk)} (TOFU pinning: check this fingerprint if you're paranoid)`
            : paired;
        }

        // Code offer.
        const pairing = createPairingCode(db, identity.hostname);
        const legacy = createPairingToken(db);
        return [
          `pairing code: ${pairing.code} (valable 30 min)`,
          `Sur l'autre machine: mesh_pair(code="${pairing.code}")  [même LAN]`,
          `ou: mesh_pair(code="${pairing.code}", address="${serverAddress}:${port}")  [cross-subnet]`,
          `Version plus ancienne: mesh_pair(node_id="${identity.node_id}", token="${legacy}", address="${serverAddress}:${port}", pk="${identity.public_key}")`,
        ].join("\n");
      },
    },

    {
      name: "mesh_register",
      description:
        "Register a mailbox for this session. primary: your primary group (pool id), auto-joined; its lead gets enrollment confirmation (orchestrator fallback when the lead is you or offline)",
      fields: [
        str("name", "Mailbox name: letters, digits, . _ - (max 64)"),
        str("role", "Role, e.g. manager", false),
        str("primary", "Primary pool id, e.g. team:infra (must exist; auto-joins)", false),
      ],
      execute: async (args, context) => {
        const name = String(args.name);
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
          return "error: mailbox name must be 1-64 chars of letters, digits, . _ -";
        }
        const primary = typeof args.primary === "string" ? args.primary : "";
        if (primary.length > 0 && !poolExists(db, primary)) {
          return `error: unknown pool ${primary} — join it first (mesh_join) or drop the primary argument`;
        }
        const sid = sessionID(context);
        if (sid.length === 0) {
          return "error: no session context; cannot register a mailbox";
        }
        registerMailbox(db, {
          name,
          session_id: sid,
          ...(typeof args.role === "string" && args.role.length > 0 ? { role: args.role } : {}),
          ...(primary.length > 0 ? { primary_pool: primary } : {}),
          bind_key: bindKey,
          now: Date.now(),
        });
        // A declared primary that the box has not joined yet is joined here:
        // one call settles the box, the role and the primary group (idempotent).
        if (primary.length > 0) joinPool(db, name, primary);
        pushRegistryToPeers(db, identity);
        return `mailbox ${name} registered for this session`;
      },
    },

    {
      name: "mesh_send",
      description:
        "Send a message: a mailbox, 'team:<pool>' or 'all' (local), or a paired peer (remote).",
      fields: [
        str("peer", "Peer node id or hostname (remote)", false),
        str("to", "Mailbox, 'team:<pool>' or 'all' (local)", false),
        str("subject", "Short subject"),
        str("body", "Message body"),
        str("reply_to", "Id this answers, from mesh_send output", false),
        str("box", "Your sending mailbox", false),
        bool("wake", "Wake all recipients (deliberate broadcast). Direct mail always wakes."),
        str(
          "kind",
          "notify (the DM default) wakes per the wake rules; fyi NEVER wakes — read at the next drain or flash. Pools default to fyi.",
          false,
        ),
      ],
      execute: async (args, context) => {
        const peer = typeof args.peer === "string" ? args.peer : null;
        const to = typeof args.to === "string" ? args.to : null;
        if (peer === null && to === null) {
          return "error: mesh_send needs a peer (remote) or a to (mailbox, team:<pool> or all)";
        }
        // P1.2 (refonte): the message kind. DMs default notify (they wake);
        // pools default fyi (silent — read at the next drain). An explicit
        // notify on a pool is the deliberate broadcast (wake).
        const targetIsPool = to !== null && (to === "all" || to.startsWith("team:"));
        const kind =
          args.kind === "notify" || args.kind === "fyi"
            ? args.kind
            : targetIsPool
              ? "fyi"
              : "notify";
        const wake = args.wake === true || (kind === "notify" && targetIsPool);
        const sessionBoxes = mailboxesBySession(db, sessionID(context));
        const from_box =
          typeof args.box === "string" && args.box.length > 0
            ? (sessionBoxes.find((b) => b.name === args.box)?.name ?? args.box)
            : (sessionBoxes[0]?.name ?? null);
        touchMailbox(db, sessionID(context), Date.now());
        // P3 (0.31.0): the reply correlation is server-side. An agent that
        // answers without reply_to (the storm root cause) gets the pending
        // question's id filled in automatically — explicit always wins,
        // pools/broadcasts never correlate.
        const replyToFor = (to: string): string | null => {
          if (typeof args.reply_to === "string" && args.reply_to.length > 0) return args.reply_to;
          if (to === "all" || to.startsWith("team:")) return null;
          return from_box === null ? null : lastUnansweredFrom(db, from_box, to);
        };
        const selfSendLocal = async (): Promise<string> => {
          // Narrowed once: the closure loses the outer non-null narrowing.
          const targetBox = to ?? "";
          const result = deliverMessage(db, {
            from: identity.node_id,
            from_box,
            to_box: targetBox,
            subject: String(args.subject),
            body: String(args.body),
            reply_to: to === null ? null : replyToFor(to),
            wake,
            kind,
          });
          // Federation: a broadcast with no LOCAL recipients (the sender is
          // often the only member of its team on this node) must still reach
          // the remote members — synthesize an origin id and forward.
          if (!result.ok && fanout && result.error === "empty_broadcast") {
            const origin = randomUUID();
            const forwardedOnly = await fanout.fanout({
              to_box: targetBox,
              origin_id: origin,
              from_box,
              subject: String(args.subject),
              body: String(args.body),
              via: [],
              ...(wake ? { wake: true } : {}),
            });
            pushRegistryToPeers(db, identity);
            return JSON.stringify(
              { id: origin, recipients: [], forwarded: forwardedOnly },
              null,
              2,
            );
          }
          if (!result.ok) {
            // The federated resolution (0.30.0): an unknown LOCAL box with a
            // FEDERATED registry row (node_id = the owning peer) routes the
            // DM to that peer — the same contract as peer + to, resolved by
            // name. The peer resolves its own box at arrival.
            if (result.error === "unknown_mailbox") {
              const federated = to === null ? null : federatedByName(db, to);
              if (federated && federated.node_id !== null) {
                const queued = queueOutbox(
                  db,
                  {
                    node_id: federated.node_id,
                    to_box: federated.name,
                    from_box,
                    subject: String(args.subject),
                    body: String(args.body),
                    reply_to: replyToFor(federated.name),
                    origin_id: randomUUID(),
                  },
                  Date.now(),
                );
                return `queued: ${queued.id.slice(0, 8)} — the background sender delivers it to the owning peer (retries with backoff)`;
              }
            }
            return result.error === "unknown_mailbox"
              ? `error: unknown mailbox/pool ${to}`
              : `error: broadcast ${to} has no recipients`;
          }
          // Federation: forward the broadcast to paired peers holding members.
          let forwarded: string[] = [];
          if (fanout && result.recipients.length > 0) {
            forwarded = await fanout.fanout({
              to_box: targetBox,
              origin_id: result.id,
              from_box,
              subject: String(args.subject),
              body: String(args.body),
              via: [],
              ...(wake ? { wake: true } : {}),
            });
          }
          return JSON.stringify(
            { id: result.id, recipients: result.recipients, forwarded },
            null,
            2,
          );
        };
        const extras = {
          ...(to !== null ? { to } : {}),
          ...(to !== null && replyToFor(to) !== null ? { reply_to: replyToFor(to)! } : {}),
          ...(from_box !== null ? { from_box } : {}),
        };
        if (peer !== null) {
          // Same-machine sessions share this node: a "peer" send to the own
          // node id is a local delivery in disguise. Route by mailbox instead
          // of letting the mail fall into the global feed unread.
          if (peer === identity.node_id) {
            if (to === null) {
              return `error: ${peer} is THIS node — use to=<mailbox> (see mesh_status mailboxes) for a local delivery`;
            }
            return await selfSendLocal();
          }
          const target = findSendablePeer(db, peer);
          if (target === null) {
            return `error: no paired peer matching ${peer}; run mesh_status`;
          }
          // The one NON-healable config error stays immediate: a TLS peer
          // whose pinned key is missing accepts ANY certificate (a MITM
          // could steal the bearer token). Everything else is the outbox's
          // job — a stale address, a rebooted peer, a network blip: the
          // background sender resolves the conn FRESH at delivery and
          // retries with backoff; the agent sees "queued", never a failure.
          const connNow = resolvePeerTarget(db, peer);
          if (connNow?.tls && connNow.pk === null) {
            return `error: peer ${target.node_id} is TLS but has no pinned key — re-pair with mesh_pair`;
          }
          // The outbox (refonte P2.6): write and return. The delivery dedup
          // rides origin_id (effectively-once at the receiver).
          const queued = queueOutbox(
            db,
            {
              node_id: target.node_id,
              to_box: to ?? "",
              from_box,
              subject: String(args.subject),
              body: String(args.body),
              reply_to: to !== null ? replyToFor(to) : null,
              kind,
              origin_id: randomUUID(),
            },
            Date.now(),
          );
          // The first delivery attempt is INLINE: a reachable peer gets the
          // mail in the same call; the unreachable case falls back to the
          // background sender + the retries.
          return `queued: ${queued.id.slice(0, 8)} — the background sender delivers it (retries with backoff; the state rides mesh_status)`;
        }
        return await selfSendLocal();
      },
    },

    {
      name: "mesh_inbox",
      description:
        "List this session's unread mail (unregistered: legacy global feed) and mark it read.",
      fields: [bool("ack", "Mark read (default true)")],
      execute: async (args, context) => {
        // The lazy outbox sweep (refonte P2.6): the delivery happens when
        // someone looks — the background timer is a convenience, not the
        // contract.
        await sweepOutbox(db, identity, () => {});

        const sid = sessionID(context);
        touchMailbox(db, sid, Date.now());
        // Fetch + ack in one transaction: a process killed between them used
        // to leave deliveries read but never served (hot-swap race, 0.16.1).
        const rows = inboxRead(db, sid, args.ack !== false);
        if (rows.length === 0) {
          return "inbox empty";
        }
        // Compact JSON (0.29.0): the pretty-print cost bytes on every drain,
        // and delivery_id is an internal key the agent never uses (the
        // reply correlation is reply_to; tasks correlate by task_id
        // server-side).
        return JSON.stringify(
          rows.map((r) => ({
            id: r.id,
            ...(r.box !== undefined && r.box !== null ? { box: r.box } : {}),
            from: r.from,
            from_box: r.from_box,
            subject: r.subject,
            body: r.body,
            reply_to: r.reply_to,
            created_at: r.created_at,
          })),
        );
      },
    },

    {
      name: "mesh_ask",
      description:
        "Ask another mailbox a question and get a task id immediately (NEVER blocks). The answer arrives as a wake on the terminal or input_required state; a group notifies ONCE when fully answered. Replaces mesh_wait.",
      fields: [
        str("to", "The target mailbox (same host — cross-host tasks land with the outbox)"),
        str("body", "The question"),
        str("group", "Group id: batch several asks, ONE digest when all are answered", false),
        num("deadline", "Seconds from now; past it the task fails on its own"),
      ],
      execute: async (args, context) => {
        const sid = sessionID(context);
        const sessionBoxes = mailboxesBySession(db, sid);
        const from_box = sessionBoxes[0]?.name ?? null;
        touchMailbox(db, sid, Date.now());
        const to = typeof args.to === "string" ? args.to : "";
        if (!to) return "error: mesh_ask needs a target mailbox";
        const deadline =
          typeof args.deadline === "number" && args.deadline > 0
            ? Date.now() + args.deadline * 1000
            : null;
        // The federated resolution BEFORE the row insert: an unknown target
        // must not leave an orphan submitted row (never swept, no deadline).
        const isLocal = mailboxByName(db, to);
        const fed = isLocal ? null : federatedByName(db, to);
        if (!isLocal && (!fed || fed.node_id === null)) {
          return `error: unknown mailbox/pool ${to}`;
        }
        const task = askTask(db, {
          from_box,
          to_box: to,
          question: String(args.body ?? ""),
          group_id: typeof args.group === "string" && args.group.length > 0 ? args.group : null,
          deadline,
        });
        // A FEDERATED target (refonte P2.5): the ask crosses via the outbox;
        // the reply comes back through /task-reply.
        if (!isLocal) {
          const fed = federatedByName(db, to);
          queueTaskAsk(db, task, Date.now());
          const fedNodeId = fed?.node_id ?? "";
          return JSON.stringify(
            { task_id: task.id, group: task.group_id, queued_for: fedNodeId.slice(0, 8) },
            null,
            2,
          );
        }
        return JSON.stringify(
          { task_id: task.id, group: task.group_id, delivered_to: task.to_box },
          null,
          2,
        );
      },
    },
    {
      name: "mesh_reply",
      description:
        "Answer a task received in your box. The asker is notified on terminal and input_required states; a group notifies once, fully answered, as a digest.",
      fields: [
        str("task_id", "The task id from the task message in your box"),
        str("result", "The answer"),
        str("state", "completed (default) | failed | input_required | working", false),
      ],
      execute: async (args, context) => {
        const sid = sessionID(context);
        const sessionBoxes = mailboxesBySession(db, sid).map((b) => b.name);
        touchMailbox(db, sid, Date.now());
        const taskId = typeof args.task_id === "string" ? args.task_id : "";
        const state = (typeof args.state === "string" ? args.state : "completed") as TaskState;
        if (!taskId) return "error: mesh_reply needs a task_id";
        const task = getTask(db, taskId);
        if (!task) return "error: unknown task";
        const replyingBox = sessionBoxes.find((b) => b === task.to_box);
        if (!replyingBox)
          return "error: only the task's target mailbox may reply — run mesh_register with that box";
        const res = replyTask(db, taskId, replyingBox, String(args.result ?? ""), state);
        if (!res.ok) return `error: ${res.error}`;
        // The MIRROR reply (refonte P2.5): the asker is on another node —
        // the reply crosses back through the outbox.
        if (res.cross) {
          queueTaskReply(db, taskId, String(args.result ?? ""), state, Date.now());
          return JSON.stringify({ task_id: taskId.slice(0, 8), state, queued_back: true });
        }
        return JSON.stringify({ task_id: taskId.slice(0, 8), state, notified: res.notified });
      },
    },
    {
      name: "mesh_tasks",
      description: "List your tasks (asked or received), newest first. Read-only, never blocks.",
      fields: [str("group", "Filter by group id", false)],
      execute: async (args, context) => {
        const sid = sessionID(context);
        const sessionBoxes = mailboxesBySession(db, sid).map((b) => b.name);
        touchMailbox(db, sid, Date.now());
        const rows = listTasks(
          db,
          sessionBoxes,
          typeof args.group === "string" && args.group.length > 0 ? args.group : undefined,
        );
        return `tasks: ${rows.length}\n${JSON.stringify(
          rows.map((t) => ({
            id: t.id.slice(0, 8),
            from: t.from_box,
            to: t.to_box,
            state: t.state,
            group: t.group_id,
            question: t.question.slice(0, 60),
            result: t.result?.slice(0, 120),
            deadline: t.deadline,
          })),
          null,
          2,
        )}`;
      },
    },
    {
      name: "mesh_board_set",
      description:
        "Write ONE status key for your box (task | blocker | state | eta). NO wake — the board is shared state: update it instead of DMing a status.",
      fields: [str("key", "task | blocker | state | eta"), str("value", "The value (short)")],
      execute: async (args, context) => {
        const sid = sessionID(context);
        const sessionBoxes = mailboxesBySession(db, sid);
        const box = sessionBoxes[0]?.name;
        touchMailbox(db, sid, Date.now());
        if (!box) return "error: run mesh_register first";
        const key = typeof args.key === "string" ? args.key : "";
        if (!(BOARD_KEYS as readonly string[]).includes(key))
          return `error: key must be one of ${BOARD_KEYS.join(" | ")}`;
        boardSet(
          db,
          box ?? "",
          key as BoardKey,
          String(args.value ?? "").slice(0, 200),
          Date.now(),
        );
        return `board set: ${box} ${key}=${String(args.value ?? "").slice(0, 200)}`;
      },
    },
    {
      name: "mesh_board_get",
      description:
        "Read the board: ONE line per box (the fixed keys). pool filters to the boxes carrying it. Nobody is woken by a read.",
      fields: [str("pool", "Filter: the boxes carrying this pool", false)],
      execute: async (args, context) => {
        touchMailbox(db, sessionID(context), Date.now());
        const pool = typeof args.pool === "string" && args.pool.length > 0 ? args.pool : undefined;
        const rows = boardGet(db, pool);
        return `board (${rows.length} boxes):\n${rows.map((r) => `${r.box}: ${r.line}`).join("\n") || "(empty)"}`;
      },
    },
    {
      name: "mesh_journal",
      description:
        "Read-only journal of mesh traffic: who said what to whom, when. Consult on demand instead of narrating ops.",
      fields: [
        str("since", "Entries at or after this time: ISO date or epoch ms", false),
        str("mailbox", "Filter: sender or recipient mailbox", false),
        num("limit", "Max entries, newest first (default 50, max 200)"),
        bool("pool", "Only pool/broadcast traffic"),
      ],
      execute: async (args) => {
        let since: number | undefined;
        if (typeof args.since === "string" && args.since.trim().length > 0) {
          const raw = args.since.trim();
          // Epoch ms first (Date.parse on bare digits is unreliable), ISO next.
          const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
          if (!Number.isFinite(parsed)) {
            return "error: since must be an ISO date or epoch ms";
          }
          since = parsed;
        }
        const rows = journalQuery(db, {
          ...(since !== undefined ? { since } : {}),
          ...(typeof args.mailbox === "string" && args.mailbox.length > 0
            ? { mailbox: args.mailbox }
            : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(args.pool === true ? { pool: true } : {}),
        });
        const oldest = rows.length > 0 ? new Date(rows[rows.length - 1]!.ts).toISOString() : "now";
        return `journal: ${rows.length} entries (from ${oldest} — machine-local)\n${JSON.stringify(rows)}`;
      },
    },

    {
      name: "mesh_join",
      description:
        "Join a pool (e.g. team:x) so its broadcasts reach this mailbox. Defaults to the last touched box.",
      fields: [
        str("pool", "Pool id, e.g. team:x"),
        str("box", "Which of your mailboxes joins", false),
      ],
      execute: async (args, context) => {
        const boxName = resolveBox(
          db,
          sessionID(context),
          typeof args.box === "string" ? args.box : undefined,
        );
        const box = mailboxByName(db, boxName ?? "");
        if (!box) {
          return "error: run mesh_register first";
        }
        const pool = String(args.pool);
        joinPool(db, box.name, pool);
        pushRegistryToPeers(db, identity);
        return `joined ${pool}`;
      },
    },

    {
      name: "mesh_leave",
      description: "Leave a pool joined with mesh_join. Defaults to the last touched box.",
      fields: [
        str("pool", "Pool id, e.g. team:x"),
        str("box", "Which of your mailboxes leaves", false),
      ],
      execute: async (args, context) => {
        const boxName = resolveBox(
          db,
          sessionID(context),
          typeof args.box === "string" ? args.box : undefined,
        );
        const box = mailboxByName(db, boxName ?? "");
        if (!box) {
          return "error: run mesh_register first";
        }
        const pool = String(args.pool);
        leavePool(db, box.name, pool);
        return `left ${pool}`;
      },
    },

    {
      name: "mesh_pools",
      description: "List pools and their member mailboxes.",
      fields: [],
      execute: async () => {
        const pools: Record<string, string[]> = {};
        for (const box of listMailboxes(db)) {
          for (const pool of box.pools) {
            if (!pools[pool]) {
              pools[pool] = [];
            }
            pools[pool].push(box.name);
          }
        }
        return JSON.stringify(pools, null, 2);
      },
    },

    {
      name: "mesh_lock",
      description:
        "Claim a path: other sessions on THIS MACHINE wait. Not distributed (other nodes do not see it).",
      fields: [
        str("path", "Path to lock (worktree-relative or absolute)"),
        num("ttl", "Seconds before expiry (default 600)"),
      ],
      execute: async (args, context) => {
        const path = String(args.path);
        const granted = tryLock(db, {
          path,
          owner_node: identity.node_id,
          owner_session: context.sessionID,
          ttl_ms: (typeof args.ttl === "number" ? args.ttl : 600) * 1000,
          now: Date.now(),
        });
        return granted
          ? `locked ${path}`
          : `error: ${path} is locked by another session; try later or run mesh_status`;
      },
    },

    {
      name: "mesh_unlock",
      description: "Release a claim made with mesh_lock.",
      fields: [str("path", "Path to unlock")],
      execute: async (args) => {
        const path = String(args.path);
        const released = releaseLock(db, { path, owner_node: identity.node_id });
        return released ? `released ${path}` : `error: ${path} was not locked by this node`;
      },
    },

    {
      name: "mesh_spawn",
      description:
        "Run a task as a headless background worker. Modes: session (default, this host's context), project (project=<dir>, git or not), worktree (worktree=true + project=<dir>, git isolation). " +
        "name= births an ENROLLED fleet agent: it keeps the mesh tools, self-enrolls on its first turn and joins pools; a name collision hands the mailbox over (last binder wins); refused past spawnMax (default 4 running). " +
        "node=<paired peer> births the enrolled agent ON that peer: signed request, same modes (project must exist there), ack by DM; it lives in the peer's registry (reap it there) and local spawnMax does not apply.",
      fields: [
        str("task", "Task for the worker"),
        str(
          "name",
          "Enrolled: mailbox name ([A-Za-z0-9._-], max 64); also names the worktree branch",
          false,
        ),
        str("role", "Enrolled: fleet role (default worker)", false),
        strArr("pools", "Enrolled: pools to join, first = primary", false),
        str("node", "Paired peer (node id or hostname) to spawn on", false),
        str(
          "project",
          "Directory on the target host (git or not); with worktree=true, the source repo",
          false,
        ),
        bool("worktree", "Isolate in a git worktree (requires project)"),
        str("model", "provider/model (local only)", false),
        str("agent", "Agent (local only)", false),
        bool("auto", "Grant all permissions (default true, local only)"),
      ],
      execute: async (args, context) => {
        const name = typeof args.name === "string" && args.name.length > 0 ? args.name : undefined;
        if (name !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
          return "error: mailbox name must be 1-64 chars of letters, digits, . _ -";
        }
        const pools = Array.isArray(args.pools)
          ? args.pools.filter((p): p is string => typeof p === "string" && p.length > 0)
          : [];
        const enroll =
          name !== undefined
            ? {
                name,
                role: typeof args.role === "string" && args.role.length > 0 ? args.role : "worker",
                pools,
              }
            : undefined;
        const project =
          typeof args.project === "string" && args.project.length > 0 ? args.project : undefined;
        const wantsWorktree = args.worktree === true;
        if (wantsWorktree && project === undefined) {
          return "error: worktree requires project (pass project=<directory>)";
        }
        // Mode resolution (0.25.0): explicit args win; with neither, an
        // enrolled child defaults to session (the host's natural context)
        // while the legacy headless spawn keeps its worktree (back-compat).
        const mode: SpawnMode = wantsWorktree
          ? "worktree"
          : project !== undefined
            ? "project"
            : "session";
        const node = typeof args.node === "string" && args.node.length > 0 ? args.node : undefined;
        if (node !== undefined) {
          return await distantSpawn(mesh, {
            task: String(args.task),
            node,
            mode,
            ...(project !== undefined ? { project } : {}),
            ...(enroll !== undefined ? { enroll } : {}),
            sessionID: sessionID(context),
          });
        }
        const localMode: SpawnMode = enroll === undefined && mode === "session" ? "worktree" : mode;
        if (enroll !== undefined) {
          const max = spawnMax ?? 4;
          if (countRunningEnrolled(db) >= max) {
            return `error: spawn limit ${max} reached, reap one first`;
          }
        }
        let info: WorktreeInfo | undefined;
        try {
          if (localMode === "worktree") {
            info = await createWorkerWorktree(worktreeClient, {
              ...(typeof args.name === "string" ? { name: args.name } : {}),
            });
            const worker = runWorker(db, dataDir, {
              task: String(args.task),
              worktree_path: info.directory,
              // The 2.x domain reports only the directory; fall back to its
              // basename (git's branch name for the worktree) for the NOT NULL
              // branch column.
              branch: info.branch ?? info.name ?? basename(info.directory),
              spawn_mode: "worktree",
              ...(typeof args.model === "string" ? { model: args.model } : {}),
              ...(typeof args.agent === "string" ? { agent: args.agent } : {}),
              ...(typeof args.auto === "boolean" ? { auto: args.auto } : {}),
              ...(enroll !== undefined ? { enroll } : {}),
              spawnFn,
            });
            if (worker.status === "failed") {
              // The child never ran: do not leak the worktree. Only drop the row
              // once the worktree is gone, so an unclean removal stays visible.
              const cleaned = await removeWorkerWorktree(worktreeClient, {
                directory: info.directory,
              }).catch(() => false);
              info = undefined;
              if (!cleaned) {
                return `error: worker ${worker.id} failed to start; worktree ${worker.worktree_path} may be stranded`;
              }
              deleteWorker(db, worker.id);
              removeWorkerLog(dataDir, worker.id);
              return `error: worker ${worker.id} failed to start`;
            }
            return JSON.stringify(
              {
                worker_id: worker.id,
                worktree: info.directory,
                branch: worker.branch,
                pid: worker.pid,
                ...(enroll !== undefined ? { mailbox: enroll.name } : {}),
              },
              null,
              2,
            );
          }
          // Session/project: NO worktree machinery runs — nothing touches the
          // worktree table or discovery, and the 0.24.7
          // SourceDirectoryNotFoundError path is unreachable here.
          if (localMode === "project" && !existsSync(project!)) {
            return `error: spawn refused: project directory ${project} does not exist`;
          }
          const worker = runWorker(db, dataDir, {
            task: String(args.task),
            ...(localMode === "project" && project !== undefined ? { worktree_path: project } : {}),
            spawn_mode: localMode,
            ...(typeof args.model === "string" ? { model: args.model } : {}),
            ...(typeof args.agent === "string" ? { agent: args.agent } : {}),
            ...(typeof args.auto === "boolean" ? { auto: args.auto } : {}),
            ...(enroll !== undefined ? { enroll } : {}),
            spawnFn,
          });
          if (worker.status === "failed") {
            // The child never ran and no worktree was created: only the row
            // and the log need cleaning.
            deleteWorker(db, worker.id);
            removeWorkerLog(dataDir, worker.id);
            return `error: worker ${worker.id} failed to start`;
          }
          return JSON.stringify(
            {
              worker_id: worker.id,
              mode: localMode,
              ...(localMode === "project" ? { dir: project } : {}),
              pid: worker.pid,
              ...(enroll !== undefined ? { mailbox: enroll.name } : {}),
            },
            null,
            2,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (info) {
            // A worktree was created before the failure: clean it up so a
            // thrown runWorker does not strand a directory.
            const cleaned = await removeWorkerWorktree(worktreeClient, {
              directory: info.directory,
            }).catch(() => false);
            if (!cleaned) {
              return `error: ${message}; worktree ${info.directory} may be stranded`;
            }
          }
          return `error: ${message}`;
        }
      },
    },

    {
      name: "mesh_workers",
      description: "List workers with their lifecycle state.",
      fields: [],
      execute: async () => {
        const workers = listWorkers(db);
        if (workers.length === 0) {
          return "[]";
        }
        return JSON.stringify(workers, null, 2);
      },
    },

    {
      name: "mesh_worker_logs",
      description: "Show the tail of a worker's output.",
      fields: [str("worker_id", "Worker id"), num("tail", "Number of lines (default 50)")],
      execute: async (args) => {
        const worker_id = String(args.worker_id);
        const worker = getWorker(db, worker_id);
        if (!worker) {
          return `error: unknown worker ${worker_id}`;
        }
        const tail = readLogTail(
          dataDir,
          worker.id,
          typeof args.tail === "number" ? args.tail : 50,
        );
        return tail.length > 0 ? tail : "no log output yet";
      },
    },

    {
      name: "mesh_worker_stop",
      description: "Stop a running worker (SIGTERM).",
      fields: [str("worker_id", "Worker id")],
      execute: async (args) => {
        const worker_id = String(args.worker_id);
        try {
          stopWorker(db, worker_id);
          return `stopped ${worker_id}`;
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },

    {
      name: "mesh_worker_remove",
      description: "Remove a finished worker: deletes the worktree and registry row.",
      fields: [
        str("worker_id", "Worker id"),
        bool("force", "Stop a running worker before removal"),
      ],
      execute: async (args) => {
        const worker_id = String(args.worker_id);
        const worker = getWorker(db, worker_id);
        if (!worker) {
          return `error: unknown worker ${worker_id}`;
        }
        if (worker.status === "running") {
          if (args.force !== true) {
            return `error: worker ${worker.id} is running; use force=true to stop and remove it`;
          }
          // force: terminate first so no process keeps writing into a deleted
          // worktree. A row can be 'running' with no live process left (host
          // restart, pid not yet reconciled): removal must still proceed.
          try {
            stopWorker(db, worker.id);
          } catch {
            // Nothing live to signal; the registry row is what gets cleaned up.
          }
        }
        // Session/project spawns (0.25.0) run in a directory the mesh did not
        // create: there is nothing to remove, and a project dir is the user's
        // own tree — NEVER hand it to the worktree API.
        if (worker.spawn_mode !== "worktree") {
          const rowDeleted = deleteWorker(db, worker_id);
          if (!rowDeleted) {
            return `error: worker row ${worker_id} was already gone`;
          }
          reapEnrolledPools(db, worker);
          removeWorkerLog(dataDir, worker.id);
          return `removed ${worker.id} (registry row and log deleted; spawn mode ${worker.spawn_mode} keeps its directory)`;
        }
        let removed: boolean;
        try {
          removed = await removeWorkerWorktree(worktreeClient, {
            directory: worker.worktree_path,
          });
        } catch (error) {
          return `error: worktree remove failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (!removed) {
          // Keep the row so the unremoved worktree stays discoverable.
          return `error: worktree ${worker.worktree_path} was not removed; worker ${worker_id} kept`;
        }
        const rowDeleted = deleteWorker(db, worker_id);
        if (!rowDeleted) {
          return `error: worktree removed but worker row ${worker_id} was already gone`;
        }
        // A deliberate removal of an enrolled spawn leaves its pools (0.23.0);
        // the mailbox row itself survives for the next binder of the same name.
        reapEnrolledPools(db, worker);
        removeWorkerLog(dataDir, worker.id);
        return `removed ${worker.id} (worktree, registry row and log deleted)`;
      },
    },
  ];
}

// Distant spawn (0.24.0): send the signed spawn request to a paired peer and
// surface its verdict. The peer runs its own enrolled-spawn path; the worker
// lives on the peer's registry and the ack comes back as a DM. The spawn mode
// (0.25.0) rides in the signed spec: worktree = the peer's worktree machinery
// (the 0.24.8 projectID retarget stays on this path only), project = an
// existing directory on the peer, session = the peer's natural context.
async function distantSpawn(
  mesh: MeshContext,
  input: {
    task: string;
    node: string;
    mode: SpawnMode;
    project?: string;
    enroll?: EnrollIdentity;
    sessionID: string;
  },
): Promise<string> {
  const { db, identity } = mesh;
  if (input.enroll === undefined) {
    return "error: distant spawn requires name= (the child enrolls on the peer)";
  }
  const spec: SpawnSpec = {
    task: input.task,
    name: input.enroll.name,
    role: input.enroll.role,
    pools: input.enroll.pools,
    // Key order is part of the canonical signed payload: the receiver rebuilds
    // the spec in exactly this order (task, name, role, pools, project,
    // worktree).
    ...(input.project !== undefined ? { project: input.project } : {}),
    ...(input.mode === "worktree" ? { worktree: true } : {}),
  };
  const specError = validateSpawnSpec(spec);
  if (specError !== null) {
    return `error: ${specError}`;
  }
  const target = findSendablePeer(db, input.node);
  if (target === null) {
    return `error: no paired peer matching ${input.node}; run mesh_status`;
  }
  const conn = resolvePeerTarget(db, input.node);
  if (conn === null) {
    return `error: peer ${target.node_id} has no known address with a port; have it run mesh_pair to share its address, or wait for discovery`;
  }
  // No silent TOFU on a token-authenticated channel (the mesh_send rule): a
  // TLS peer without a pinned key would accept ANY certificate, so the signed
  // request could be stolen by a MITM. Refuse; TOFU stays pairing-only.
  if (conn.tls && conn.pk === null) {
    return `error: peer ${target.node_id} is TLS but has no pinned key — re-pair with mesh_pair`;
  }
  const fromBox = resolveBox(db, input.sessionID);
  const body = buildSpawnRequest(identity, {
    spec,
    ...(fromBox !== null ? { from_box: fromBox } : {}),
    // The projectID rides along ONLY on a project opt-in (0.27.0): the
    // default (session) payload is the spec alone, verifiable by a legacy
    // receiver; the worktree retarget (0.24.8) still authenticates on its
    // path since worktree requires project.
    ...(input.project !== undefined && mesh.projectID !== undefined
      ? { projectID: mesh.projectID }
      : {}),
  });
  const result = await postSpawn({
    url: conn.url,
    ...(conn.tls ? { tls: true } : {}),
    ...(conn.pk !== null ? { pk: conn.pk } : {}),
    token: target.token ?? "",
    body,
  });
  if (result.kind === "unreachable") {
    const hint =
      result.error === "pin-mismatch"
        ? " — the peer's identity changed: re-pair with mesh_pair to refresh the pin"
        : result.error === "plaintext-peer"
          ? " — the peer answered in plaintext: version skew, it needs opencode-mesh >= 0.24 (distant spawn)"
          : "";
    return `error: spawn on ${input.node} failed: ${result.error}${hint}`;
  }
  if (result.kind === "refused") {
    return `error: ${result.error}`;
  }
  return JSON.stringify(
    {
      node: result.hostname ?? input.node,
      node_id: target.node_id,
      worker_id: result.worker_id,
      mailbox: input.enroll.name,
      ack: "the peer DMs `spawned <name> on <hostname> (worker <id>)` to your mailbox; the worker lives on the peer's registry — reap it there (mesh_worker_stop on the peer)",
    },
    null,
    2,
  );
}
