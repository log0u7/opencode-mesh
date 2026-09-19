import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Bonjour } from "bonjour-service";
import type { Server } from "node:http";

import { rememberPeer } from "./lib/discovery.js";
import { sendMail } from "./lib/client.js";
import { openMeshDb, type MeshDb } from "./lib/db.js";
import {
  advertiseMesh,
  browseMesh,
  tailnetAddresses,
  type AdvertiseHandle,
} from "./lib/discovery.js";
import { loadOrCreateIdentity, type NodeIdentity } from "./lib/identity.js";
import { ackMessages, unreadMessages } from "./lib/mail.js";
import { releaseLock, tryLock } from "./lib/locks.js";
import { createPairingToken, listPeers, pairWithToken } from "./lib/peers.js";
import { startMeshServer } from "./lib/serve.js";
import { nodeSpawn, runWorker, stopAllWorkers, stopWorker, type SpawnFn } from "./lib/spawn.js";
import {
  createWorkerWorktree,
  defaultWorktreeFactory,
  removeWorkerWorktree,
  type WorktreeClient,
} from "./lib/worktree.js";
import { deleteWorker, getWorker, listWorkers } from "./lib/workers.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type PluginOptions = {
  dataDir?: string;
  port?: number;
  advertise?: boolean;
  worktreeClient?: WorktreeClient;
  spawnFn?: SpawnFn;
};

const DEFAULT_PORT = 4399;

export const MeshPlugin: Plugin = async (input, options?: PluginOptions) => {
  const dataDir = options?.dataDir ?? defaultDataDir();
  const identity: NodeIdentity = loadOrCreateIdentity(dataDir);
  const db: MeshDb = openMeshDb(`${dataDir}/mesh.db`);

  const { server, port } = await startMeshServer({ db, port: options?.port ?? DEFAULT_PORT });
  const worktreeClient: WorktreeClient =
    options?.worktreeClient ?? defaultWorktreeFactory(input.serverUrl.toString(), input.directory);
  const spawnFn = options?.spawnFn ?? nodeSpawn;

  let advertiseHandle: AdvertiseHandle | null = null;
  let browseHandle: { close(): void } | null = null;
  if (options?.advertise !== false) {
    const bonjour = new Bonjour();
    advertiseHandle = advertiseMesh({
      bonjour,
      port,
      node_id: identity.node_id,
      fingerprint: identity.fingerprint,
    });
    browseHandle = browseMesh({
      bonjour,
      onDiscovered: (peer) => {
        if (peer.node_id !== identity.node_id) {
          rememberPeer(db, peer);
        }
      },
    });
  }

  const hooks: Hooks = {
    tool: {
      mesh_status: tool({
        description: "Show this node's identity, server address, and known peers.",
        args: {},
        execute: async () => {
          const peers = listPeers(db);
          const tailnet = await tailnetAddresses();
          return JSON.stringify(
            {
              node_id: identity.node_id,
              hostname: identity.hostname,
              fingerprint: identity.fingerprint,
              server: `127.0.0.1:${port}`,
              tailnet_addresses: tailnet,
              peers: peers.map((p) => ({
                node_id: p.node_id,
                hostname: p.hostname,
                paired: p.paired,
                addresses: p.addresses,
              })),
            },
            null,
            2,
          );
        },
      }),

      mesh_pair: tool({
        description:
          "Pair with a peer. With no args: emit a pairing offer (token, node id, server address) for the peer's mesh_pair. With node_id, token, and address: complete pairing started by the other side.",
        args: {
          node_id: tool.schema
            .string()
            .optional()
            .describe("Peer node id, from its mesh_pair output"),
          token: tool.schema.string().optional().describe("Pairing token from the peer's offer"),
          address: tool.schema.string().optional().describe("Peer server address as host:port"),
        },
        execute: async (args) => {
          if (typeof args.token === "string" && typeof args.node_id === "string") {
            pairWithToken(db, {
              node_id: args.node_id,
              hostname: "manual",
              fingerprint: "manual",
              token: args.token,
              addresses: args.address !== undefined ? [args.address] : [],
            });
            return `paired with ${args.node_id}`;
          }
          const token = createPairingToken(db);
          return `peer should run: mesh_pair(node_id="${identity.node_id}", token="${token}", address="127.0.0.1:${port}")`;
        },
      }),

      mesh_send: tool({
        description: "Send a message to a paired peer's mailbox.",
        args: {
          peer: tool.schema.string().describe("Peer node id or hostname"),
          subject: tool.schema.string().describe("Short subject"),
          body: tool.schema.string().describe("Message body"),
        },
        execute: async (args) => {
          const peer = findSendablePeer(db, args.peer);
          if (peer === null) {
            return `error: no paired peer matching ${args.peer}; run mesh_status`;
          }
          const address = peer.addresses[0];
          if (address === undefined) {
            return `error: peer ${peer.node_id} has no known address; share addresses manually or wait for discovery`;
          }
          const host = address.includes(":") ? address : `${address}:${port}`;
          const result = await sendMail({
            url: `http://${host}`,
            token: peer.token ?? "",
            from: identity.node_id,
            subject: args.subject,
            body: args.body,
          });
          return `sent to ${peer.node_id}: ${result}`;
        },
      }),

      mesh_inbox: tool({
        description: "List unread messages from peers and mark them read.",
        args: {
          ack: tool.schema.boolean().optional().describe("Mark messages read (default true)"),
        },
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
      }),

      mesh_lock: tool({
        description: "Claim exclusive ownership of a file or worktree path so other sessions wait.",
        args: {
          path: tool.schema.string().describe("Path to lock (relative to worktree or absolute)"),
          ttl: tool.schema
            .number()
            .optional()
            .describe("Seconds before the lock expires (default 600)"),
        },
        execute: async (args, context) => {
          const granted = tryLock(db, {
            path: args.path,
            owner_node: identity.node_id,
            owner_session: context.sessionID,
            ttl_ms: (args.ttl ?? 600) * 1000,
            now: Date.now(),
          });
          return granted
            ? `locked ${args.path}`
            : `error: ${args.path} is locked by another session; try later or run mesh_status`;
        },
      }),

      mesh_unlock: tool({
        description: "Release a claim made with mesh_lock.",
        args: {
          path: tool.schema.string().describe("Path to unlock"),
        },
        execute: async (args) => {
          const released = releaseLock(db, { path: args.path, owner_node: identity.node_id });
          return released
            ? `released ${args.path}`
            : `error: ${args.path} was not locked by this node`;
        },
      }),

      mesh_spawn: tool({
        description:
          "Run a task as a background worker in an isolated opencode worktree (headless, --auto permissions by default). Returns worker id, worktree, and branch.",
        args: {
          task: tool.schema.string().describe("Task description given to the worker"),
          name: tool.schema
            .string()
            .optional()
            .describe("Worktree/branch name (random by default)"),
          model: tool.schema.string().optional().describe("provider/model for the worker"),
          agent: tool.schema.string().optional().describe("Agent for the worker"),
          auto: tool.schema
            .boolean()
            .optional()
            .describe("Grant all permissions to the worker (default true)"),
        },
        execute: async (args) => {
          try {
            const info = await createWorkerWorktree(worktreeClient, {
              ...(args.name !== undefined ? { name: args.name } : {}),
            });
            const worker = runWorker(db, dataDir, {
              task: args.task,
              worktree_path: info.directory,
              branch: info.branch ?? info.name,
              ...(args.model !== undefined ? { model: args.model } : {}),
              ...(args.agent !== undefined ? { agent: args.agent } : {}),
              ...(args.auto !== undefined ? { auto: args.auto } : {}),
              spawnFn,
            });
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
            return `error: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }),

      mesh_workers: tool({
        description: "List spawned workers with their lifecycle state.",
        args: {},
        execute: async () => {
          const workers = listWorkers(db);
          if (workers.length === 0) {
            return "[]";
          }
          return JSON.stringify(workers, null, 2);
        },
      }),

      mesh_worker_logs: tool({
        description: "Show the tail of a worker's captured output.",
        args: {
          worker_id: tool.schema.string().describe("Worker id, from mesh_spawn or mesh_workers"),
          tail: tool.schema.number().optional().describe("Number of lines (default 50)"),
        },
        execute: async (args) => {
          const worker = getWorker(db, args.worker_id);
          if (!worker) {
            return `error: unknown worker ${args.worker_id}`;
          }
          const path = join(dataDir, "workers", `${worker.id}.log`);
          let content: string;
          try {
            content = readFileSync(path, "utf8");
          } catch {
            return "no log output yet";
          }
          const lines = content.split("\n");
          const limit = args.tail ?? 50;
          return lines.slice(-limit - 1, -1).join("\n") || "no log output yet";
        },
      }),

      mesh_worker_stop: tool({
        description: "Stop a running worker (SIGTERM).",
        args: {
          worker_id: tool.schema.string().describe("Worker id"),
        },
        execute: async (args) => {
          try {
            stopWorker(db, args.worker_id);
            return `stopped ${args.worker_id}`;
          } catch (error) {
            return `error: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }),

      mesh_worker_remove: tool({
        description:
          "Remove a finished worker: deletes the worktree (native API) and the registry row.",
        args: {
          worker_id: tool.schema.string().describe("Worker id"),
          force: tool.schema.boolean().optional().describe("Stop a running worker before removal"),
        },
        execute: async (args) => {
          const worker = getWorker(db, args.worker_id);
          if (!worker) {
            return `error: unknown worker ${args.worker_id}`;
          }
          if (worker.status === "running") {
            if (args.force !== true) {
              return `error: worker ${worker.id} is running; use force=true to stop and remove it`;
            }
            // force: terminate first so no process keeps writing into a deleted worktree.
            stopWorker(db, worker.id);
          }
          try {
            await removeWorkerWorktree(worktreeClient, { directory: worker.worktree_path });
          } catch (error) {
            return `error: worktree remove failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          deleteWorker(db, args.worker_id);
          return `removed ${worker.id} (worktree and registry row deleted)`;
        },
      }),
    },
  };

  return {
    ...hooks,
    dispose: async () => {
      stopAllWorkers(db);
      advertiseHandle?.close();
      browseHandle?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
};

function defaultDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
  return `${dataHome}/opencode-mesh`;
}

function findSendablePeer(
  db: MeshDb,
  query: string,
): { node_id: string; addresses: string[]; token: string | null } | null {
  const peers = listPeers(db).filter((p) => p.paired);
  return peers.find((p) => p.node_id === query) ?? peers.find((p) => p.hostname === query) ?? null;
}
