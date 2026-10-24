import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Bonjour } from "bonjour-service";

import { openMeshDb, type MeshDb } from "./lib/db.js";
import { advertiseMesh, browseMesh, type AdvertiseHandle } from "./lib/discovery.js";
import { upsertDiscoveredPeer } from "./lib/peers.js";
import { loadOrCreateIdentity, type NodeIdentity } from "./lib/identity.js";
import { nodeSpawn, stopAllWorkers, type SpawnFn } from "./lib/spawn.js";
import { defaultDataDir, parseOptions, type PluginOptions } from "./options.js";
import { extractClientFetch, type WorktreeClient, type WorktreeFactory } from "./lib/worktree.js";
import { reconcileWorkers } from "./lib/workers.js";
import { startMeshServer } from "./lib/serve.js";
import { buildToolSpecs } from "./tools.js";

export { defaultDataDir, parseOptions } from "./options.js";
export type { PluginOptions } from "./options.js";

// The v1 worktree REST factory lives HERE, not in lib/worktree.ts: it is only
// reachable from v1 hosts, and it imports `@opencode-ai/sdk/v2`, which only
// hosts that bundle the v1-era SDK resolve. Keeping it in the lazily loaded v1
// adapter keeps the SDK out of the package's static import graph, which v2
// hosts reject at load time (see scripts/smoke-dist.mjs).
export const defaultWorktreeFactory: WorktreeFactory = (baseUrl, directory, fetchOverride) =>
  createOpencodeClient({
    baseUrl,
    directory,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  }) as unknown as WorktreeClient;

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
export const MeshPlugin: Plugin = async (input, rawOptions?: PluginOptions) => {
  if (isChildProcess()) {
    return { dispose: async () => {} };
  }
  const options = parseOptions(rawOptions);
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
  const worktreeClient: WorktreeClient =
    options.worktreeClient ??
    defaultWorktreeFactory(
      input.serverUrl.toString(),
      input.directory,
      extractClientFetch(input.client),
    );
  const spawnFn = options.spawnFn ?? nodeSpawn;

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
