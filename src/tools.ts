import { basename } from "node:path";
import { sendMail } from "./lib/client.js";
import type { MeshDb } from "./lib/db.js";
import { tailnetAddresses } from "./lib/discovery.js";
import type { NodeIdentity } from "./lib/identity.js";
import { ackMessages, unreadMessages } from "./lib/mail.js";
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

export function buildToolSpecs(mesh: MeshContext): ToolSpec[] {
  const { db, identity, dataDir, serverAddress, port, worktreeClient, spawnFn } = mesh;
  return [
    {
      name: "mesh_status",
      description: "Show this node's identity, server address, and known peers.",
      fields: [],
      execute: async () => {
        const peers = listPeers(db);
        const tailnet = await tailnetAddresses();
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
        "Pair with a peer. With no args: emit a pairing offer (token, node id, server address) for the peer's mesh_pair. With node_id, token, and address: complete pairing started by the other side.",
      fields: [
        str("node_id", "Peer node id, from its mesh_pair output", false),
        str("token", "Pairing token from the peer's offer", false),
        str("address", "Peer server address as host:port", false),
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
          });
          return `paired with ${node_id}`;
        }
        const offer = createPairingToken(db);
        return `peer should run: mesh_pair(node_id="${identity.node_id}", token="${offer}", address="${serverAddress}:${port}")`;
      },
    },

    {
      name: "mesh_send",
      description: "Send a message to a paired peer's mailbox.",
      fields: [
        str("peer", "Peer node id or hostname"),
        str("subject", "Short subject"),
        str("body", "Message body"),
      ],
      execute: async (args) => {
        const peer = String(args.peer);
        const target = findSendablePeer(db, peer);
        if (target === null) {
          return `error: no paired peer matching ${peer}; run mesh_status`;
        }
        const url = resolvePeerUrl(db, peer);
        if (url === null) {
          return `error: peer ${target.node_id} has no known address with a port; have it run mesh_pair to share its address, or wait for discovery`;
        }
        const result = await sendMail({
          url,
          token: target.token ?? "",
          from: identity.node_id,
          subject: String(args.subject),
          body: String(args.body),
        });
        return `sent to ${target.node_id}: ${result}`;
      },
    },

    {
      name: "mesh_inbox",
      description: "List unread messages from peers and mark them read.",
      fields: [bool("ack", "Mark messages read (default true)")],
      execute: async (args) => {
        const messages = unreadMessages(db);
        if (messages.length === 0) {
          return "inbox empty";
        }
        if (args.ack !== false) {
          ackMessages(
            db,
            messages.map((m) => m.id),
          );
        }
        return JSON.stringify(messages, null, 2);
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
