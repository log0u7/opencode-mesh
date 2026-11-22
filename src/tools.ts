import { basename } from "node:path";
import { sendMail } from "./lib/client.js";
import type { MeshDb } from "./lib/db.js";
import { tailnetAddresses } from "./lib/discovery.js";
import { pairingProof, type NodeIdentity } from "./lib/identity.js";
import {
  ackInbox,
  ackMessages,
  ackReply,
  deliverMessage,
  firstReply,
  inboxRows,
  joinPool,
  leavePool,
  listMailboxes,
  mailboxBySession,
  registerMailbox,
  touchMailbox,
  unreadCount,
  unreadMessages,
} from "./lib/mail.js";
import { listLocks, releaseLock, tryLock } from "./lib/locks.js";
import {
  createPairingToken,
  findSendablePeer,
  listPeers,
  pairWithToken,
  resolvePeerUrl,
} from "./lib/peers.js";
import { readLogTail, removeWorkerLog, runWorker, stopWorker, type SpawnFn } from "./lib/spawn.js";
import {
  createWorkerWorktree,
  removeWorkerWorktree,
  type WorktreeClient,
  type WorktreeInfo,
} from "./lib/worktree.js";
import { deleteWorker, getWorker, listWorkers } from "./lib/workers.js";

// One definition of the mesh tools, consumed by both host adapters (plugin.ts
// for OpenCode 1.x, plugin-v2.ts for 2.x). Descriptions, argument shapes and
// behavior live here so the two entry points cannot drift apart.
export type ToolField = {
  name: string;
  type: "string" | "number" | "boolean";
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
  /** Instance binding key (project id + directory): mesh_register stamps it so
   * a later TUI bind from the same instance re-binds the box to its live
   * session (restart-proof wake). */
  bindKey: string;
  worktreeClient: WorktreeClient;
  spawnFn: SpawnFn;
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

// The host normally always provides a session id; normalizing keeps tools
// usable in contexts without one (tests, exotic hosts) instead of crashing
// on a SQLite bind with undefined.
function sessionID(context: ToolContext): string {
  return typeof context?.sessionID === "string" && context.sessionID.length > 0
    ? context.sessionID
    : "";
}

export function buildToolSpecs(mesh: MeshContext): ToolSpec[] {
  const { db, identity, dataDir, serverAddress, port, bindKey, worktreeClient, spawnFn } = mesh;
  return [
    {
      name: "mesh_status",
      description: "Show this node's identity, server address, and known peers.",
      fields: [],
      execute: async () => {
        const peers = listPeers(db);
        const tailnet = await tailnetAddresses();
        const now = Date.now();
        return JSON.stringify(
          {
            node_id: identity.node_id,
            hostname: identity.hostname,
            fingerprint: identity.fingerprint,
            server: `${serverAddress}:${port}`,
            tailnet_addresses: tailnet,
            peers: peers.map((p) => ({
              node_id: p.node_id,
              hostname: p.hostname,
              paired: p.paired,
              addresses: p.addresses,
            })),
            mailboxes: listMailboxes(db).map((b) => ({
              name: b.name,
              role: b.role,
              pools: b.pools,
              last_seen: b.last_seen,
              age_s: Math.round((now - b.last_seen) / 1000),
            })),
            unread: unreadCount(db),
            locks: listLocks(db, { now: Date.now() }),
          },
          null,
          2,
        );
      },
    },

    {
      name: "mesh_pair",
      description:
        "Pair with a peer. With no args: emit a pairing offer (token, node id, public key, server address) for the peer's mesh_pair. With node_id, token, and address (pk from the offer): complete pairing started by the other side.",
      fields: [
        str("node_id", "Peer node id, from its mesh_pair output", false),
        str("token", "Pairing token from the peer's offer", false),
        str("address", "Peer server address as host:port", false),
        str("pk", "Peer public key from the peer's offer (pins its signing key)", false),
      ],
      execute: async (args) => {
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
          return `paired with ${node_id}`;
        }
        const offer = createPairingToken(db);
        return `peer should run: mesh_pair(node_id="${identity.node_id}", token="${offer}", address="${serverAddress}:${port}", pk="${identity.public_key}")`;
      },
    },

    {
      name: "mesh_register",
      description:
        "Register this session's mailbox under a name so other sessions and pools can route mail to it.",
      fields: [
        str("name", "Mailbox name: letters, digits, . _ - (max 64 chars)"),
        str("role", "Informational role, e.g. manager", false),
      ],
      execute: async (args, context) => {
        const name = String(args.name);
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
          return "error: mailbox name must be 1-64 chars of letters, digits, . _ -";
        }
        const sid = sessionID(context);
        if (sid.length === 0) {
          return "error: no session context; cannot register a mailbox";
        }
        registerMailbox(db, {
          name,
          session_id: sid,
          ...(typeof args.role === "string" && args.role.length > 0 ? { role: args.role } : {}),
          bind_key: bindKey,
          now: Date.now(),
        });
        return `mailbox ${name} registered for this session`;
      },
    },

    {
      name: "mesh_send",
      description:
        "Send a message: to a mailbox name, 'team:<pool>' or 'all' on this node, or to a paired peer on another node.",
      fields: [
        str("peer", "Peer node id or hostname (remote send)", false),
        str("to", "Mailbox name, 'team:<pool>' or 'all' (local delivery)", false),
        str("subject", "Short subject"),
        str("body", "Message body"),
        str("reply_to", "Message id this message answers, from mesh_send output", false),
      ],
      execute: async (args, context) => {
        const peer = typeof args.peer === "string" ? args.peer : null;
        const to = typeof args.to === "string" ? args.to : null;
        if (peer === null && to === null) {
          return "error: mesh_send needs a peer (remote) or a to (mailbox, team:<pool> or all)";
        }
        const from_box = mailboxBySession(db, sessionID(context))?.name ?? null;
        touchMailbox(db, sessionID(context), Date.now());
        const extras = {
          ...(to !== null ? { to } : {}),
          ...(typeof args.reply_to === "string" ? { reply_to: args.reply_to } : {}),
          ...(from_box !== null ? { from_box } : {}),
        };
        if (peer !== null) {
          const target = findSendablePeer(db, peer);
          if (target === null) {
            return `error: no paired peer matching ${peer}; run mesh_status`;
          }
          const url = resolvePeerUrl(db, peer);
          if (url === null) {
            return `error: peer ${target.node_id} has no known address with a port; have it run mesh_pair to share its address, or wait for discovery`;
          }
          // Every mail carries a pairing proof signed by this node's key: it is
          // what lets the receiving side bind (or rotate) a pairing to us without
          // trusting the bearer token alone.
          const result = await sendMail({
            url,
            token: target.token ?? "",
            from: identity.node_id,
            subject: String(args.subject),
            body: String(args.body),
            proof: pairingProof(identity, target.token ?? ""),
            ...extras,
          });
          return `sent to ${target.node_id}: ${result}`;
        }
        const result = deliverMessage(db, {
          from: identity.node_id,
          from_box,
          to_box: to!,
          subject: String(args.subject),
          body: String(args.body),
          reply_to: typeof args.reply_to === "string" ? args.reply_to : null,
        });
        if (!result.ok) {
          return result.error === "unknown_mailbox"
            ? `error: unknown mailbox/pool ${to}`
            : `error: broadcast ${to} has no recipients`;
        }
        return JSON.stringify({ id: result.id, recipients: result.recipients }, null, 2);
      },
    },

    {
      name: "mesh_inbox",
      description:
        "List unread messages for this session's mailbox (unregistered sessions see the legacy global feed) and mark them read.",
      fields: [bool("ack", "Mark messages read (default true)")],
      execute: async (args, context) => {
        const sid = sessionID(context);
        touchMailbox(db, sid, Date.now());
        const rows = inboxRows(db, sid);
        if (rows.length === 0) {
          return "inbox empty";
        }
        if (args.ack !== false) {
          ackInbox(
            db,
            rows.map((r) => r.delivery_id),
          );
          // Legacy global rows have no delivery: ack the message rows instead.
          ackMessages(
            db,
            rows.filter((r) => r.delivery_id === "").map((r) => r.id),
          );
        }
        return JSON.stringify(
          rows.map((r) => ({
            id: r.id,
            delivery_id: r.delivery_id,
            from: r.from,
            from_box: r.from_box,
            subject: r.subject,
            body: r.body,
            reply_to: r.reply_to,
            created_at: r.created_at,
          })),
          null,
          2,
        );
      },
    },

    {
      name: "mesh_wait",
      description:
        "Wait for a reply to one of your sent messages (matching its reply_to) and return it. Blocks the agent turn by design: request/response completes within one turn.",
      fields: [
        str("id", "Message id to wait a reply for, from mesh_send output"),
        num("timeout", "Seconds to wait (default 120)"),
      ],
      execute: async (args, context) => {
        const sid = sessionID(context);
        touchMailbox(db, sid, Date.now());
        const seconds = typeof args.timeout === "number" ? args.timeout : 120;
        const deadline = Date.now() + seconds * 1000;
        while (Date.now() < deadline) {
          const row = firstReply(db, String(args.id), sid);
          if (row) {
            ackReply(db, row);
            return JSON.stringify(row, null, 2);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return `timeout: no reply to ${String(args.id)} within ${seconds}s`;
      },
    },

    {
      name: "mesh_join",
      description: "Join a pool (e.g. team:x) so broadcasts to that pool reach this mailbox.",
      fields: [str("pool", "Pool id, e.g. team:x")],
      execute: async (args, context) => {
        const box = mailboxBySession(db, sessionID(context));
        if (!box) {
          return "error: run mesh_register first";
        }
        const pool = String(args.pool);
        joinPool(db, box.name, pool);
        return `joined ${pool}`;
      },
    },

    {
      name: "mesh_leave",
      description: "Leave a pool joined with mesh_join.",
      fields: [str("pool", "Pool id, e.g. team:x")],
      execute: async (args, context) => {
        const box = mailboxBySession(db, sessionID(context));
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
        "Claim exclusive ownership of a file or path so other sessions on THIS MACHINE wait. Not distributed: a peer on another node does not see this lock.",
      fields: [
        str("path", "Path to lock (relative to worktree or absolute)"),
        num("ttl", "Seconds before the lock expires (default 600)"),
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
        "Run a task as a background worker in an isolated opencode worktree (headless, --auto permissions by default). Returns worker id, worktree, and branch.",
      fields: [
        str("task", "Task description given to the worker"),
        str("name", "Worktree/branch name (random by default)", false),
        str("model", "provider/model for the worker", false),
        str("agent", "Agent for the worker", false),
        bool("auto", "Grant all permissions to the worker (default true)"),
      ],
      execute: async (args) => {
        let info: WorktreeInfo | undefined;
        try {
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
            ...(typeof args.model === "string" ? { model: args.model } : {}),
            ...(typeof args.agent === "string" ? { agent: args.agent } : {}),
            ...(typeof args.auto === "boolean" ? { auto: args.auto } : {}),
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
      description: "List spawned workers with their lifecycle state.",
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
      description: "Show the tail of a worker's captured output.",
      fields: [
        str("worker_id", "Worker id, from mesh_spawn or mesh_workers"),
        num("tail", "Number of lines (default 50)"),
      ],
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
      description:
        "Remove a finished worker: deletes the worktree (native API) and the registry row.",
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
        removeWorkerLog(dataDir, worker.id);
        return `removed ${worker.id} (worktree, registry row and log deleted)`;
      },
    },
  ];
}
