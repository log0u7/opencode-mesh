import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

// Validate the host-supplied options once, at the boundary. A typo'd port or
// bind used to surface as a late, cryptic failure (EADDRINUSE, a bind on the
// wrong interface, or a data dir at the filesystem root); fail clearly here.
export function parseOptions(raw: PluginOptions | undefined): PluginOptions {
  const options: PluginOptions = {};
  // `null` is treated as "no options" (the old code tolerated it); a non-object
  // is a programming error. Unknown keys are ignored on purpose: a host may pass
  // its own option bag, and forward-compat beats rejecting a typo'd `datadir`.
  if (raw === undefined || raw === null) {
    return options;
  }
  if (typeof raw !== "object") {
    throw new Error("opencode-mesh: options must be an object");
  }
  if (raw.dataDir !== undefined) {
    if (typeof raw.dataDir !== "string" || raw.dataDir.length === 0) {
      throw new Error("opencode-mesh: options.dataDir must be a non-empty string");
    }
    options.dataDir = raw.dataDir;
  }
  if (raw.port !== undefined) {
    if (
      typeof raw.port !== "number" ||
      !Number.isInteger(raw.port) ||
      raw.port < 0 ||
      raw.port > 65535
    ) {
      throw new Error("opencode-mesh: options.port must be an integer between 0 and 65535");
    }
    options.port = raw.port;
  }
  if (raw.bind !== undefined) {
    if (raw.bind !== "loopback" && raw.bind !== "lan") {
      throw new Error('opencode-mesh: options.bind must be "loopback" or "lan"');
    }
    options.bind = raw.bind;
  }
  if (raw.advertise !== undefined) {
    if (typeof raw.advertise !== "boolean") {
      throw new Error("opencode-mesh: options.advertise must be a boolean");
    }
    options.advertise = raw.advertise;
  }
  // Opaque collaborators are passed through untouched: the plugin cannot
  // validate a client or spawn function beyond its nominal type.
  if (raw.worktreeClient !== undefined) {
    options.worktreeClient = raw.worktreeClient;
  }
  if (raw.spawnFn !== undefined) {
    options.spawnFn = raw.spawnFn;
  }
  return options;
}

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
  const dataHome = process.env.XDG_DATA_HOME || join(homeDir(), ".local", "share");
  return join(dataHome, "opencode-mesh");
}

// `os.homedir()` / `os.tmpdir()` replace the old empty-string fallback, which
// produced a path at the filesystem root (`/.local/share/...`) when HOME was
// unset or blank.
function homeDir(): string {
  return process.env.HOME || homedir() || tmpdir();
}
