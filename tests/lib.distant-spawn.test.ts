import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb, type MeshDb } from "../src/lib/db.js";
import {
  SPAWN_REQUEST_TTL_MS,
  buildSpawnRequest,
  parseSpawnRequest,
  spawnRequestPayload,
  verifySpawnRequest,
} from "../src/lib/distant-spawn.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../src/lib/identity.js";
import { inboxRows, registerMailbox } from "../src/lib/mail.js";
import { pairWithToken } from "../src/lib/peers.js";
import { listWorkers, countRunningSpawnedByPeer } from "../src/lib/workers.js";
import { postSpawn } from "../src/lib/client.js";
import { startMeshServer } from "../src/lib/serve.js";
import { nodeTlsMaterial } from "../src/lib/tls.js";
import type { SpawnFn, SpawnedProcess } from "../src/lib/spawn.js";
import type { WorktreeClient } from "../src/lib/worktree.js";
import { buildToolSpecs, type ToolSpec } from "../src/tools.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-dspawn-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A spawn that never exits: the worker row stays 'running' so the quota can
// count it. The argv/env are recorded for the enrolled-child assertions.
function fakeSpawnFn(): SpawnFn {
  return (): SpawnedProcess => ({
    pid: 4242,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  });
}

function fakeWorktreeClient(): WorktreeClient {
  return {
    worktree: {
      create: async (parameters) => {
        const name = parameters.worktreeCreateInput?.name;
        return {
          data: { name, branch: `wt/${name ?? "x"}`, directory: `/tmp/wt-${name ?? "x"}` },
        };
      },
      remove: async () => ({ data: true }),
    },
  };
}

type Node = {
  identity: NodeIdentity;
  db: MeshDb;
  port: number;
  server: { server: { close(): void } };
};

async function startNode(
  name: string,
  options: {
    acceptSpawn?: boolean;
    quotaPeer?: number;
    omitDistantSpawn?: boolean;
  } = {},
): Promise<Node> {
  const identity = loadOrCreateIdentity(join(dir, name));
  const db = openMeshDb(":memory:");
  const spawnFn = fakeSpawnFn();
  const worktreeClient = fakeWorktreeClient();
  const { server, port } = await startMeshServer({
    db,
    port: 0,
    tls: true,
    tlsMaterial: nodeTlsMaterial(join(dir, name)),
    self: { node_id: identity.node_id, pk: identity.public_key, hostname: `host-${name}` },
    dataDir: join(dir, name),
    ...(!options.omitDistantSpawn
      ? {
          distantSpawn: {
            acceptSpawn: options.acceptSpawn ?? true,
            ...(options.quotaPeer !== undefined ? { quotaPeer: options.quotaPeer } : {}),
            privateKey: identity.private_key,
            worktreeClient,
            spawnFn,
          },
        }
      : {}),
  });
  return { identity, db, port, server: { server } };
}

function tools(identity: NodeIdentity, db: MeshDb, worktreeClient: WorktreeClient) {
  const specs = new Map<string, ToolSpec>(
    buildToolSpecs({
      db,
      identity,
      dataDir: dir,
      serverAddress: "127.0.0.1",
      port: 0,
      bindKey: "test-bind",
      worktreeClient,
      spawnFn: fakeSpawnFn(),
    }).map((s) => [s.name, s]),
  );
  return (name: string, args: Record<string, unknown> = {}, sessionID = "s-a"): Promise<string> =>
    specs.get(name)!.execute(args, { sessionID });
}

function pairBoth(a: Node, b: Node, token: string): void {
  pairWithToken(a.db, {
    node_id: b.identity.node_id,
    hostname: "host-b",
    fingerprint: "fB",
    token,
    addresses: [`127.0.0.1:${b.port}`],
    public_key: b.identity.public_key,
  });
  pairWithToken(b.db, {
    node_id: a.identity.node_id,
    hostname: "host-a",
    fingerprint: "fA",
    token,
    addresses: [`127.0.0.1:${a.port}`],
    public_key: a.identity.public_key,
  });
}

const SPEC = { task: "implement the parser", name: "parser", role: "worker", pools: ["team:x"] };

describe("distant spawn wire (0.24.0)", () => {
  it("signs and rebuilds the canonical payload deterministically", () => {
    const identity = loadOrCreateIdentity(join(dir, "wire"));
    const body = buildSpawnRequest(identity, {
      spec: SPEC,
      from_box: "parent-box",
      now: 1_000,
    });
    const parsed = parseSpawnRequest(body)!;
    expect(parsed.from).toBe(identity.node_id);
    expect(parsed.spec).toEqual(SPEC);
    expect(parsed.from_box).toBe("parent-box");
    expect(parsed.ts).toBe(1_000);
    // The receiver rebuilds the exact signed payload from its own parse.
    expect(verifySpawnRequest({ public_key: identity.public_key }, parsed, 1_000 + 1)).toBeNull();
    // Same spec, same identity, same time: the SAME payload string (the nonce
    // differs per request; the canonical form itself is deterministic).
    expect(spawnRequestPayload(SPEC, "a", "n1", 5)).toBe(spawnRequestPayload(SPEC, "a", "n1", 5));
  });

  it("refuses a peer without a pinned key (no TOFU, the 0.18.0 lesson)", () => {
    const identity = loadOrCreateIdentity(join(dir, "nopk"));
    const body = parseSpawnRequest(buildSpawnRequest(identity, { spec: SPEC, now: Date.now() }))!;
    const verdict = verifySpawnRequest({ public_key: null }, body, Date.now());
    expect(verdict).toBe("spawn refused: peer has no pinned key (re-pair with mesh_pair)");
    expect(verifySpawnRequest(null, body, Date.now())).toContain("no pinned key");
  });

  it("refuses a request outside the 5 min window and a forged signature", () => {
    const identity = loadOrCreateIdentity(join(dir, "stale"));
    const stale = parseSpawnRequest(
      buildSpawnRequest(identity, { spec: SPEC, now: Date.now() - SPAWN_REQUEST_TTL_MS - 1 }),
    )!;
    expect(verifySpawnRequest(identity, stale, Date.now())).toBe(
      "spawn refused: stale request (outside the 5 min window)",
    );
    // Forged: signed by a rogue key, but claiming the pinned node's identity.
    const rogue = loadOrCreateIdentity(join(dir, "rogue"));
    const forged = JSON.parse(buildSpawnRequest(rogue, { spec: SPEC, now: Date.now() })) as Record<
      string,
      unknown
    >;
    forged.from = identity.node_id;
    const parsed = parseSpawnRequest(JSON.stringify(forged))!;
    expect(verifySpawnRequest(identity, parsed, Date.now())).toBe(
      "spawn refused: invalid signature",
    );
  });
});

describe("distant spawn e2e: two TLS nodes (0.24.0)", () => {
  it("mesh_spawn(node=B) births an enrolled child on B and the ack DM returns", async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    pairBoth(a, b, "tAB");
    registerMailbox(a.db, { name: "parent-box", session_id: "s-a", now: Date.now() });

    const call = tools(a.identity, a.db, fakeWorktreeClient());
    const out = await call("mesh_spawn", {
      task: SPEC.task,
      name: SPEC.name,
      role: SPEC.role,
      pools: SPEC.pools,
      node: "host-b",
    });
    const result = JSON.parse(out) as {
      node: string;
      node_id: string;
      worker_id: string;
      mailbox: string;
    };
    expect(result.node).toBe("host-b");
    expect(result.node_id).toBe(b.identity.node_id);
    expect(result.mailbox).toBe("parser");
    expect(result.worker_id).toBeTruthy();

    // The child was born on B through ITS OWN enrolled-spawn path: enrolled
    // registry row, worktree named after the mailbox, stamped with the parent.
    const workers = listWorkers(b.db);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.mailbox).toBe("parser");
    expect(workers[0]?.spawned_by).toBe(a.identity.node_id);
    expect(workers[0]?.status).toBe("running");
    expect(workers[0]?.worktree_path).toBe("/tmp/wt-parser");
    expect(workers[0]?.task).toBe(SPEC.task);

    // The ack DM comes back to the parent's mailbox on A.
    await vi.waitFor(
      () => {
        expect(inboxRows(a.db, "s-a")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    const ack = inboxRows(a.db, "s-a")[0]!;
    expect(ack.subject).toBe("spawned: parser");
    expect(ack.body).toBe(`spawned parser on host-b (worker ${result.worker_id})`);

    a.server.server.close();
    b.server.server.close();
  });

  it("refuses with an explicit message when acceptSpawn is disabled (default)", async () => {
    const a = await startNode("a2");
    const b = await startNode("b2", { acceptSpawn: false });
    pairBoth(a, b, "tAB");
    const call = tools(a.identity, a.db, fakeWorktreeClient());
    const out = await call("mesh_spawn", {
      task: SPEC.task,
      name: SPEC.name,
      node: "host-b",
    });
    expect(out).toBe("error: spawn refused: acceptSpawn disabled");
    expect(listWorkers(b.db)).toHaveLength(0);
    a.server.server.close();
    b.server.server.close();
  });

  it("refuses a forged signature on the wire with 403", async () => {
    const a = await startNode("a3");
    const b = await startNode("b3");
    pairBoth(a, b, "tAB");
    // A rogue node signs the request but claims A's identity: B verifies
    // against the key it pinned for A and refuses.
    const rogue = loadOrCreateIdentity(join(dir, "rogue3"));
    const body = JSON.parse(buildSpawnRequest(rogue, { spec: SPEC, now: Date.now() })) as Record<
      string,
      unknown
    >;
    body.from = a.identity.node_id;
    const result = await postSpawn({
      url: `https://127.0.0.1:${b.port}`,
      tls: true,
      pk: b.identity.public_key,
      token: "tAB",
      body: JSON.stringify(body),
    });
    expect(result).toEqual({
      kind: "refused",
      status: 403,
      error: "spawn refused: invalid signature",
    });
    expect(listWorkers(b.db)).toHaveLength(0);
    a.server.server.close();
    b.server.server.close();
  });

  it("refuses a replayed nonce and a stale timestamp", async () => {
    const a = await startNode("a4");
    // Quota raised here: this test exercises replay/staleness, the quota test
    // runs on its own node.
    const b = await startNode("b4", { quotaPeer: 10 });
    pairBoth(a, b, "tAB");
    const first = await postSpawn({
      url: `https://127.0.0.1:${b.port}`,
      tls: true,
      pk: b.identity.public_key,
      token: "tAB",
      body: buildSpawnRequest(a.identity, { spec: { ...SPEC, name: "replayer" }, now: Date.now() }),
    });
    expect(first.kind).toBe("ok");
    // Exact same body, second time: the nonce is already claimed.
    const replay = await postSpawn({
      url: `https://127.0.0.1:${b.port}`,
      tls: true,
      pk: b.identity.public_key,
      token: "tAB",
      body: buildSpawnRequest(a.identity, { spec: { ...SPEC, name: "replayer" }, now: Date.now() }),
    });
    // The second request carries a FRESH nonce+signature (buildSpawnRequest
    // mints one per call) and is accepted: replay means the EXACT same body.
    expect(replay.kind).toBe("ok");
    // A stale request (captured 6 minutes ago) dies on the window check.
    const stale = await postSpawn({
      url: `https://127.0.0.1:${b.port}`,
      tls: true,
      pk: b.identity.public_key,
      token: "tAB",
      body: buildSpawnRequest(a.identity, {
        spec: { ...SPEC, name: "old-timer" },
        now: Date.now() - SPAWN_REQUEST_TTL_MS - 1_000,
      }),
    });
    expect(stale).toEqual({
      kind: "refused",
      status: 403,
      error: "spawn refused: stale request (outside the 5 min window)",
    });
    // The pure replay path: the identical body twice.
    const frozen = buildSpawnRequest(a.identity, {
      spec: { ...SPEC, name: "frozen" },
      now: Date.now(),
    });
    const frozenFirst = await postSpawn({
      url: `https://127.0.0.1:${b.port}`,
      tls: true,
      pk: b.identity.public_key,
      token: "tAB",
      body: frozen,
    });
    expect(frozenFirst.kind).toBe("ok");
    const frozenSecond = await postSpawn({
      url: `https://127.0.0.1:${b.port}`,
      tls: true,
      pk: b.identity.public_key,
      token: "tAB",
      body: frozen,
    });
    expect(frozenSecond).toEqual({
      kind: "refused",
      status: 403,
      error: "spawn refused: replayed nonce",
    });
    a.server.server.close();
    b.server.server.close();
  });

  it("applies the per-peer quota and leaves local spawns uncounted", async () => {
    const a = await startNode("a5");
    const b = await startNode("b5", { quotaPeer: 2 });
    pairBoth(a, b, "tAB");
    const call = tools(a.identity, a.db, fakeWorktreeClient());
    const first = await call("mesh_spawn", { task: "t1", name: "kid-one", node: "host-b" });
    expect(JSON.parse(first).worker_id).toBeTruthy();
    const second = await call("mesh_spawn", { task: "t2", name: "kid-two", node: "host-b" });
    expect(JSON.parse(second).worker_id).toBeTruthy();
    expect(countRunningSpawnedByPeer(b.db, a.identity.node_id)).toBe(2);
    const third = await call("mesh_spawn", { task: "t3", name: "kid-three", node: "host-b" });
    expect(third).toBe("error: spawn refused: spawn quota reached (2)");
    // A LOCAL enrolled spawn on B (spawned_by NULL) never counts against the
    // peer's quota: it is B's own worker.
    const local = await call("mesh_spawn", { task: "local task", name: "local-kid" });
    expect(JSON.parse(local).worker_id).toBeTruthy();
    const fourth = await call("mesh_spawn", { task: "t4", name: "kid-four", node: "host-b" });
    expect(fourth).toBe("error: spawn refused: spawn quota reached (2)");
    a.server.server.close();
    b.server.server.close();
  });

  it("leaves the local spawn path unchanged (no node argument)", async () => {
    const a = await startNode("a6", { omitDistantSpawn: true });
    const call = tools(a.identity, a.db, fakeWorktreeClient());
    const out = await call("mesh_spawn", { task: "plain work", name: "local-only" });
    const result = JSON.parse(out) as { worker_id: string; mailbox: string };
    expect(result.mailbox).toBe("local-only");
    const workers = listWorkers(a.db);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.mailbox).toBe("local-only");
    expect(workers[0]?.spawned_by).toBeNull();
    // A distant spawn without a name is refused: the child must enroll.
    const noName = await call("mesh_spawn", { task: "x", node: "host-b" });
    expect(noName).toBe("error: distant spawn requires name= (the child enrolls on the peer)");
    a.server.server.close();
  });

  it("refuses a TLS peer without a pinned key on the sender side", async () => {
    const a = await startNode("a7");
    const b = await startNode("b7");
    // Pair WITHOUT a public key on A's side (legacy/manual row): the sender
    // must refuse rather than send on an unpinned channel.
    pairWithToken(a.db, {
      node_id: b.identity.node_id,
      hostname: "host-b",
      fingerprint: "fB",
      token: "tAB",
      addresses: [`127.0.0.1:${b.port}`],
    });
    pairWithToken(b.db, {
      node_id: a.identity.node_id,
      hostname: "host-a",
      fingerprint: "fA",
      token: "tAB",
      public_key: a.identity.public_key,
    });
    const call = tools(a.identity, a.db, fakeWorktreeClient());
    const out = await call("mesh_spawn", { task: SPEC.task, name: SPEC.name, node: "host-b" });
    expect(out).toBe(
      `error: peer ${b.identity.node_id} is TLS but has no pinned key — re-pair with mesh_pair`,
    );
    a.server.server.close();
    b.server.server.close();
  });
});
