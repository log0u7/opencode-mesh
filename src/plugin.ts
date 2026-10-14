import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Bonjour } from "bonjour-service";

import { openMeshDb, type MeshDb } from "./lib/db.js";
import { advertiseMesh, browseMesh, type AdvertiseHandle } from "./lib/discovery.js";
import { upsertDiscoveredPeer } from "./lib/peers.js";
import { loadOrCreateIdentity, type NodeIdentity } from "./lib/identity.js";
import { nodeSpawn, stopAllWorkers, type SpawnFn } from "./lib/spawn.js";
import { defaultWorktreeFactory, extractClientFetch, type WorktreeClient } from "./lib/worktree.js";
import { reconcileWorkers } from "./lib/workers.js";
import { startMeshServer } from "./lib/serve.js";
import { buildToolSpecs } from "./tools.js";

export type PluginOptions = {
  dataDir?: string;
  port?: number;
  bind?: "loopback" | "lan";
  advertise?: boolean;
  worktreeClient?: WorktreeClient;
  spawnFn?: SpawnFn;
};

const DEFAULT_PORT = 4399;

// A worker spawned by mesh_spawn inherits this marker: it must not boot its own
// mesh server, advertise over mDNS or register mesh tools. A pool of N workers
// then costs N worktrees, not N mesh nodes.
function isChildProcess(): boolean {
  return process.env.OPENCODE_MESH_CHILD === "1";
}

// The v1 adapter: OpenCode 1.x hosts call server(). Tool specs come from
// tools.ts; this file only maps them onto the v1 hook surface (zod args,
// string results).
export const MeshPlugin: Plugin = async (input, options?: PluginOptions) => {
  if (isChildProcess()) {
    return { dispose: async () => {} };
  }
  const dataDir = options?.dataDir ?? defaultDataDir();
  const identity: NodeIdentity = loadOrCreateIdentity(dataDir);
  const db: MeshDb = openMeshDb(`${dataDir}/mesh.db`);
  // Workers from a previous host process can never be stopped again once the
  // in-memory map is gone: mark dead pids before anything else uses the table.
  reconcileWorkers(db);

  const { server, port, address } = await startMeshServer({
    db,
    port: options?.port ?? DEFAULT_PORT,
    ...(options?.bind !== undefined ? { bind: options.bind } : {}),
  });
  const worktreeClient: WorktreeClient =
    options?.worktreeClient ??
    defaultWorktreeFactory(
      input.serverUrl.toString(),
      input.directory,
      extractClientFetch(input.client),
    );
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
          upsertDiscoveredPeer(db, peer);
        }
      },
    });
  }

  const hooks: Hooks = {
    tool: Object.fromEntries(
      buildToolSpecs({
        db,
        identity,
        dataDir,
        serverAddress: address,
        port,
        worktreeClient,
        spawnFn,
      }).map((spec) => [
        spec.name,
        tool({
          description: spec.description,
          args: zodShape(spec),
          execute: (args, context) => spec.execute(args as Record<string, unknown>, context),
        }),
      ]),
    ),
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

function zodShape(
  spec: ReturnType<typeof buildToolSpecs>[number],
): Parameters<typeof tool>[0]["args"] {
  // ZodRawShape is readonly: build via fromEntries instead of mutating a typed shape.
  return Object.fromEntries(
    spec.fields.map((field) => {
      const base =
        field.type === "number"
          ? tool.schema.number()
          : field.type === "boolean"
            ? tool.schema.boolean()
            : tool.schema.string();
      const described = base.describe(field.description);
      return [field.name, field.required ? described : described.optional()];
    }),
  );
}

export function defaultDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
  return `${dataHome}/opencode-mesh`;
}
