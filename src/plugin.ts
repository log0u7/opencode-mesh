import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Bonjour } from "bonjour-service";

import { appendFileSync } from "node:fs";
import { startOutboxSender } from "./lib/outbox.js";
import { openMeshDb, type MeshDb } from "./lib/db.js";
import { advertiseMesh, browseMesh, type AdvertiseHandle } from "./lib/discovery.js";
import { upsertDiscoveredPeer } from "./lib/peers.js";
import { loadOrCreateIdentity, type NodeIdentity } from "./lib/identity.js";
import { createFanout } from "./lib/fanout.js";
import { nodeSpawn, stopAllWorkers } from "./lib/spawn.js";
import { defaultDataDir, parseOptions, addressingOptions, type PluginOptions } from "./options.js";
import { extractClientFetch, type WorktreeClient, type WorktreeFactory } from "./lib/worktree.js";
import { reconcileWorkers } from "./lib/workers.js";
import { startMeshServer } from "./lib/serve.js";
import { nodeTlsMaterial } from "./lib/tls.js";
import { startMemorySyncPusher } from "./lib/memory-sync.js";
import { buildToolSpecs, WORKER_TOOL_BLOCKLIST } from "./tools.js";
import { createHostCapa } from "./lib/capa.js";

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

// A worker spawned by mesh_spawn inherits this marker: a headless child ("1")
// must not boot its own mesh server, advertise over mDNS or register mesh
// tools — a pool of N workers then costs N worktrees, not N mesh nodes. An
// enrolled child ("enrolled", 0.23.0) is a fleet agent: no server and no mDNS
// either (the host's server on 4399 serves every session of the host), but it
// keeps the mesh tools and self-enrolls from its prompt header.
function childMode(): "headless" | "enrolled" | null {
  const value = process.env.OPENCODE_MESH_CHILD;
  if (value === "1") return "headless";
  if (value === "enrolled") return "enrolled";
  return null;
}

// The v1 adapter: OpenCode 1.x hosts call server(). Tool specs come from
// tools.ts; this file only maps them onto the v1 hook surface (zod args,
// string results).
export const MeshPlugin: Plugin = async (input, rawOptions?: PluginOptions) => {
  const child = childMode();
  if (child === "headless") {
    return { dispose: async () => {} };
  }
  if (child === "enrolled") {
    // Enrolled child: tools only, over the SAME database the host server
    // serves — the mesh tools act locally, no server of its own is needed.
    const options = parseOptions(rawOptions);
    const dataDir = options.dataDir ?? defaultDataDir();
    const db: MeshDb = openMeshDb(`${dataDir}/mesh.db`);
    const identity: NodeIdentity = loadOrCreateIdentity(dataDir);
    const worktreeClient: WorktreeClient =
      options.worktreeClient ??
      defaultWorktreeFactory(
        input.serverUrl.toString(),
        input.directory,
        extractClientFetch(input.client),
      );
    const hooks: Hooks = {
      tool: Object.fromEntries(
        buildToolSpecs({
          db,
          identity,
          dataDir,
          serverAddress: "127.0.0.1",
          port: options.port ?? DEFAULT_PORT,
          bindKey: `v1:${dataDir}`,
          fanout: createFanout({ db, identity }),
          worktreeClient,
          spawnFn: options.spawnFn ?? nodeSpawn,
          addressing: addressingOptions(options),
          ...(options.spawnMax !== undefined ? { spawnMax: options.spawnMax } : {}),
        })
          // The 0.30.0 worker surface: the v1 enrolled child drops the
          // orchestration tools too (the same blocklist as the v2).
          .filter((spec) => child !== "enrolled" || !WORKER_TOOL_BLOCKLIST.has(spec.name))
          .map((spec) => [
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
        db.close();
      },
    };
  }
  const options = parseOptions(rawOptions);
  const dataDir = options.dataDir ?? defaultDataDir();
  const identity: NodeIdentity = loadOrCreateIdentity(dataDir);
  const db: MeshDb = openMeshDb(`${dataDir}/mesh.db`);
  // Workers from a previous host process can never be stopped again once the
  // in-memory map is gone: mark dead pids before anything else uses the table.
  reconcileWorkers(db);

  // The outbox sender (refonte P2.6): the background delivery of the queued
  // remote sends — both plugins host the same mesh store.
  const outboxSender = startOutboxSender(db, identity, () => {});
  appendFileSync("/tmp/opencode/sender.log", "v1 main path atteint\n");
  setInterval(() => appendFileSync("/tmp/opencode/sender.log", "v1 raw interval\n"), 1000);

  // Host capabilities: ONE 60 s cache shared by mesh_status, /status and
  // /metrics (a scrape never doubles the probes). No v1 running-set signal:
  // the execution event stream is a v2 host feature, sessionsRunning stays 0.
  const hostCapa = createHostCapa({ db });

  // Worktree client + spawn fn: shared by the local spawn tool and the
  // distant-spawn receiver (the peer executes its own enrolled-spawn path).
  const worktreeClient: WorktreeClient =
    options.worktreeClient ??
    defaultWorktreeFactory(
      input.serverUrl.toString(),
      input.directory,
      extractClientFetch(input.client),
    );
  const spawnFn = options.spawnFn ?? nodeSpawn;

  // TLS material is derived from the node identity: the cert presents the
  // very key peers already pin, so TLS adds zero new trust.
  const { server, port, address, insecureServer } = await startMeshServer({
    db,
    port: options.port ?? DEFAULT_PORT,
    ...(options.bind !== undefined ? { bind: options.bind } : {}),
    self: { node_id: identity.node_id, pk: identity.public_key, hostname: identity.hostname },
    tlsMaterial: nodeTlsMaterial(dataDir),
    capa: hostCapa.get,
    ...(options.tls === false ? { tls: false } : {}),
    ...(options.insecureHttp === true ? { insecureHttp: true } : {}),
    dataDir,
    distantSpawn: {
      acceptSpawn: options.acceptSpawn === true,
      ...(options.spawnQuotaPeer !== undefined ? { quotaPeer: options.spawnQuotaPeer } : {}),
      ...(options.spawnWorktreeBase !== undefined
        ? { spawnWorktreeBase: options.spawnWorktreeBase }
        : {}),
      privateKey: identity.private_key,
      worktreeClient,
      spawnFn,
    },
  });
  // Outbound memory sync: push the shareable outbox to paired peers on a cadence.
  // Reception (the /memory-sync endpoint) is always on; this loop is the gated half.
  const memorySyncPusher =
    options.memorySync === false
      ? null
      : startMemorySyncPusher({
          dataDir,
          db,
          identity,
          intervalMs: (options.memorySyncInterval ?? 15) * 60_000,
        });

  let advertiseHandle: AdvertiseHandle | null = null;
  let browseHandle: { close(): void; refresh(): void } | null = null;
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
        bindKey: `v1:${dataDir}`,
        fanout: createFanout({ db, identity, rebrowse: () => browseHandle?.refresh() }),
        worktreeClient,
        spawnFn,
        addressing: addressingOptions(options),
        capa: hostCapa.get,
        ...(options.spawnMax !== undefined ? { spawnMax: options.spawnMax } : {}),
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
      outboxSender?.stop();
      memorySyncPusher?.stop();
      stopAllWorkers(db);
      advertiseHandle?.close();
      browseHandle?.close();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        ...(insecureServer !== undefined
          ? [new Promise<void>((resolve) => insecureServer.close(() => resolve()))]
          : []),
      ]);
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
            : field.type === "array"
              ? tool.schema.array(tool.schema.string())
              : tool.schema.string();
      const described = base.describe(field.description);
      return [field.name, field.required ? described : described.optional()];
    }),
  );
}
