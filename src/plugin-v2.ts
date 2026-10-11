import { Plugin } from "@opencode/plugin";
import { Bonjour } from "bonjour-service";

import { sendMail } from "./lib/client.js";
import { openMeshDb, type MeshDb } from "./lib/db.js";
import {
  advertiseMesh,
  browseMesh,
  tailnetAddresses,
  type AdvertiseHandle,
} from "./lib/discovery.js";
import { upsertDiscoveredPeer } from "./lib/peers.js";
import { loadOrCreateIdentity, type NodeIdentity } from "./lib/identity.js";
import { ackMessages, unreadMessages } from "./lib/mail.js";
import { releaseLock, tryLock, listLocks } from "./lib/locks.js";
import { createPairingToken, listPeers, pairWithToken } from "./lib/peers.js";
import { startMeshServer } from "./lib/serve.js";
import { nodeSpawn, runWorker, stopAllWorkers, stopWorker, type SpawnFn } from "./lib/spawn.js";
import { createWorkerWorktree, removeWorkerWorktree, type WorktreeClient } from "./lib/worktree.js";
import { deleteWorker, getWorker, listWorkers } from "./lib/workers.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDataDir, findSendablePeer, type PluginOptions } from "./plugin.js";

const DEFAULT_PORT = 4399;

export const MeshV2 = Plugin.define({
  id: "@log0u7/opencode-mesh",
  async setup(ctx) {
    const options = ctx.options as PluginOptions;
    const dataDir = options?.dataDir ?? defaultDataDir();
    const identity: NodeIdentity = loadOrCreateIdentity(dataDir);
    const db: MeshDb = openMeshDb(`${dataDir}/mesh.db`);

    const { server, port } = await startMeshServer({ db, port: options?.port ?? DEFAULT_PORT });
    // The v2 worktree domain speaks the same worktree.create/remove shape the
    // plugin's WorktreeClient wraps over the v1 REST API.
    const worktreeClient = ctx.worktree as unknown as WorktreeClient;
    const spawnFn: SpawnFn = options?.spawnFn ?? nodeSpawn;

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
            upsertDiscoveredPeer(db, peer);
          }
        },
      });
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "mesh_status",
        description: "Show this node's identity, server address, and known peers.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const peers = listPeers(db);
          const tailnet = await tailnetAddresses();
          return {
            content: JSON.stringify(
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
                locks: listLocks(db, { now: Date.now() }),
              },
              null,
              2,
            ),
          };
        },
      });

      editor.add({
        name: "mesh_pair",
        description:
          "Pair with a peer. With no args: emit a pairing offer (token, node id, server address) for the peer's mesh_pair. With node_id, token, and address: complete pairing started by the other side.",
        input: {
          type: "object",
          properties: {
            node_id: { type: "string", description: "Peer node id, from its mesh_pair output" },
            token: { type: "string", description: "Pairing token from the peer's offer" },
            address: { type: "string", description: "Peer server address as host:port" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { node_id?: string; token?: string; address?: string };
          if (typeof a.token === "string" && typeof a.node_id === "string") {
            pairWithToken(db, {
              node_id: a.node_id,
              hostname: "manual",
              fingerprint: "manual",
              token: a.token,
              addresses: a.address !== undefined ? [a.address] : [],
            });
            return { content: `paired with ${a.node_id}` };
          }
          const token = createPairingToken(db);
          return {
            content: `peer should run: mesh_pair(node_id="${identity.node_id}", token="${token}", address="127.0.0.1:${port}")`,
          };
        },
      });

      editor.add({
        name: "mesh_send",
        description: "Send a message to a paired peer's mailbox.",
        input: {
          type: "object",
          properties: {
            peer: { type: "string", description: "Peer node id or hostname" },
            subject: { type: "string", description: "Short subject" },
            body: { type: "string", description: "Message body" },
          },
          required: ["peer", "subject", "body"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { peer: string; subject: string; body: string };
          const peer = findSendablePeer(db, a.peer);
          if (peer === null) {
            return { content: `error: no paired peer matching ${a.peer}; run mesh_status` };
          }
          const address = peer.addresses[0];
          if (address === undefined) {
            return {
              content: `error: peer ${peer.node_id} has no known address; share addresses manually or wait for discovery`,
            };
          }
          const host = address.includes(":") ? address : `${address}:${port}`;
          const result = await sendMail({
            url: `http://${host}`,
            token: peer.token ?? "",
            from: identity.node_id,
            subject: a.subject,
            body: a.body,
          });
          return { content: `sent to ${peer.node_id}: ${result}` };
        },
      });

      editor.add({
        name: "mesh_inbox",
        description: "List unread messages from peers and mark them read.",
        input: {
          type: "object",
          properties: {
            ack: { type: "boolean", description: "Mark messages read (default true)" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { ack?: boolean };
          const messages = unreadMessages(db);
          if (messages.length === 0) {
            return { content: "inbox empty" };
          }
          if (a.ack !== false) {
            ackMessages(
              db,
              messages.map((m) => m.id),
            );
          }
          return { content: JSON.stringify(messages, null, 2) };
        },
      });

      editor.add({
        name: "mesh_lock",
        description: "Claim exclusive ownership of a file or worktree path so other sessions wait.",
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to lock (relative to worktree or absolute)",
            },
            ttl: { type: "number", description: "Seconds before the lock expires (default 600)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const a = args as { path: string; ttl?: number };
          const granted = tryLock(db, {
            path: a.path,
            owner_node: identity.node_id,
            owner_session: context.sessionID,
            ttl_ms: (a.ttl ?? 600) * 1000,
            now: Date.now(),
          });
          return {
            content: granted
              ? `locked ${a.path}`
              : `error: ${a.path} is locked by another session; try later or run mesh_status`,
          };
        },
      });

      editor.add({
        name: "mesh_unlock",
        description: "Release a claim made with mesh_lock.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to unlock" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { path: string };
          const released = releaseLock(db, { path: a.path, owner_node: identity.node_id });
          return {
            content: released
              ? `released ${a.path}`
              : `error: ${a.path} was not locked by this node`,
          };
        },
      });

      editor.add({
        name: "mesh_spawn",
        description:
          "Run a task as a background worker in an isolated opencode worktree (headless, --auto permissions by default). Returns worker id, worktree, and branch.",
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task description given to the worker" },
            name: { type: "string", description: "Worktree/branch name (random by default)" },
            model: { type: "string", description: "provider/model for the worker" },
            agent: { type: "string", description: "Agent for the worker" },
            auto: {
              type: "boolean",
              description: "Grant all permissions to the worker (default true)",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as {
            task: string;
            name?: string;
            model?: string;
            agent?: string;
            auto?: boolean;
          };
          try {
            const info = await createWorkerWorktree(worktreeClient, {
              ...(a.name !== undefined ? { name: a.name } : {}),
            });
            const worker = runWorker(db, dataDir, {
              task: a.task,
              worktree_path: info.directory,
              branch: info.branch ?? info.name,
              ...(a.model !== undefined ? { model: a.model } : {}),
              ...(a.agent !== undefined ? { agent: a.agent } : {}),
              ...(a.auto !== undefined ? { auto: a.auto } : {}),
              spawnFn,
            });
            return {
              content: JSON.stringify(
                {
                  worker_id: worker.id,
                  worktree: info.directory,
                  branch: worker.branch,
                  pid: worker.pid,
                },
                null,
                2,
              ),
            };
          } catch (error) {
            return { content: `error: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
      });

      editor.add({
        name: "mesh_workers",
        description: "List spawned workers with their lifecycle state.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const workers = listWorkers(db);
          if (workers.length === 0) {
            return { content: "[]" };
          }
          return { content: JSON.stringify(workers, null, 2) };
        },
      });

      editor.add({
        name: "mesh_worker_logs",
        description: "Show the tail of a worker's captured output.",
        input: {
          type: "object",
          properties: {
            worker_id: {
              type: "string",
              description: "Worker id, from mesh_spawn or mesh_workers",
            },
            tail: { type: "number", description: "Number of lines (default 50)" },
          },
          required: ["worker_id"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { worker_id: string; tail?: number };
          const worker = getWorker(db, a.worker_id);
          if (!worker) {
            return { content: `error: unknown worker ${a.worker_id}` };
          }
          const path = join(dataDir, "workers", `${worker.id}.log`);
          let content: string;
          try {
            content = readFileSync(path, "utf8");
          } catch {
            return { content: "no log output yet" };
          }
          const lines = content.split("\n");
          const limit = a.tail ?? 50;
          return { content: lines.slice(-limit - 1, -1).join("\n") || "no log output yet" };
        },
      });

      editor.add({
        name: "mesh_worker_stop",
        description: "Stop a running worker (SIGTERM).",
        input: {
          type: "object",
          properties: {
            worker_id: { type: "string", description: "Worker id" },
          },
          required: ["worker_id"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { worker_id: string };
          try {
            stopWorker(db, a.worker_id);
            return { content: `stopped ${a.worker_id}` };
          } catch (error) {
            return { content: `error: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
      });

      editor.add({
        name: "mesh_worker_remove",
        description:
          "Remove a finished worker: deletes the worktree (native API) and the registry row.",
        input: {
          type: "object",
          properties: {
            worker_id: { type: "string", description: "Worker id" },
            force: { type: "boolean", description: "Stop a running worker before removal" },
          },
          required: ["worker_id"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { worker_id: string; force?: boolean };
          const worker = getWorker(db, a.worker_id);
          if (!worker) {
            return { content: `error: unknown worker ${a.worker_id}` };
          }
          if (worker.status === "running") {
            if (a.force !== true) {
              return {
                content: `error: worker ${worker.id} is running; use force=true to stop and remove it`,
              };
            }
            // force: terminate first so no process keeps writing into a deleted worktree.
            stopWorker(db, worker.id);
          }
          try {
            await removeWorkerWorktree(worktreeClient, { directory: worker.worktree_path });
          } catch (error) {
            return {
              content: `error: worktree remove failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          deleteWorker(db, a.worker_id);
          return { content: `removed ${worker.id} (worktree and registry row deleted)` };
        },
      });
    });

    const cleanup = async () => {
      stopAllWorkers(db);
      advertiseHandle?.close();
      browseHandle?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    };
    return cleanup;
  },
});
