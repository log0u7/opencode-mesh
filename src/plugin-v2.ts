import { Plugin } from "@opencode/plugin";
import { Bonjour } from "bonjour-service";

import { openMeshDb, type MeshDb } from "./lib/db.js";
import { advertiseMesh, browseMesh, type AdvertiseHandle } from "./lib/discovery.js";
import { upsertDiscoveredPeer } from "./lib/peers.js";
import { loadOrCreateIdentity, type NodeIdentity } from "./lib/identity.js";
import { nodeSpawn, stopAllWorkers, type SpawnFn } from "./lib/spawn.js";
import type { WorktreeClient } from "./lib/worktree.js";
import { v2WorktreeDomainClient } from "./lib/worktree.js";
import { reconcileWorkers } from "./lib/workers.js";
import { startMeshServer } from "./lib/serve.js";
import { buildToolSpecs, type ToolSpec } from "./tools.js";
import { defaultDataDir, parseOptions, type PluginOptions } from "./options.js";

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

    const { server, port, address } = await startMeshServer({
      db,
      port: options.port ?? DEFAULT_PORT,
      ...(options.bind !== undefined ? { bind: options.bind } : {}),
    });
    // Prefer an injected client (tests, hosts that pass one), then adapt the
    // 2.x in-process worktree domain to the REST-shaped WorktreeClient. The
    // domain resolves payloads directly, without the v1 `{ data }` envelope.
    const worktreeClient: WorktreeClient =
      options.worktreeClient ?? v2WorktreeDomainClient(ctx.worktree, ctx.location.project.id);
    const spawnFn: SpawnFn = options.spawnFn ?? nodeSpawn;

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
        worktreeClient,
        spawnFn,
      })) {
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
