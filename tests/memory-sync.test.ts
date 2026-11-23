import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb, type MeshDb } from "../src/lib/db.js";
import { loadOrCreateIdentity, pairingProof } from "../src/lib/identity.js";
import { createPairingToken, pairWithToken } from "../src/lib/peers.js";
import { startMeshServer } from "../src/lib/serve.js";
import {
  inboxDir,
  isInboxNodeName,
  outboxFile,
  pushOutbox,
  receiveMemorySync,
  startMemorySyncPusher,
  type SyncPushResult,
} from "../src/lib/memory-sync.js";
import type { SyncPost } from "../src/lib/memory-sync.js";

let dir: string;
let db: MeshDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-sync-"));
  db = openMeshDb(join(dir, "mesh.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedPeer(nodeId: string, token: string, publicKey?: string): void {
  pairWithToken(db, {
    node_id: nodeId,
    hostname: `host-${nodeId}`,
    fingerprint: "test",
    token,
    addresses: ["127.0.0.1:4399"],
    ...(publicKey !== undefined ? { public_key: publicKey } : {}),
  });
}

const JSONL = '{"id":"a1","scope":"/w"}\n{"id":"a2","scope":"/w"}\n';

// The outbox tree belongs to the memory plugin (its export creates it); the tests
// replicate that when they place a fixture.
function writeOutbox(dataDir: string, contents: string): string {
  const path = outboxFile(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe("paths and reception", () => {
  it("stores a peer's payload under inbox/<node id>.jsonl and replaces earlier ones", () => {
    const first = receiveMemorySync(dir, "0f8a-1", JSONL);
    expect(first).toBe(Buffer.byteLength(JSONL));
    const path = join(inboxDir(dir), "0f8a-1.jsonl");
    expect(readFileSync(path, "utf8")).toBe(JSONL);

    const second = receiveMemorySync(dir, "0f8a-1", '{"id":"b1"}\n');
    expect(second).toBe(12);
    expect(readFileSync(path, "utf8")).toBe('{"id":"b1"}\n');
    // The tmp file never survives the write.
    expect(readdirSync(inboxDir(dir))).toEqual(["0f8a-1.jsonl"]);
  });

  it("refuses node ids that could escape the inbox directory", () => {
    expect(isInboxNodeName("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isInboxNodeName("../evil")).toBe(false);
    expect(() => receiveMemorySync(dir, "../evil", JSONL)).toThrow(/refusing node id/);
    expect(readdirSync(dir)).not.toContain("evil.jsonl");
  });

  it("keeps outbox and inbox on the memory-sync convention", () => {
    expect(outboxFile(dir)).toBe(join(dir, "memory-sync", "outbox", "shareable.jsonl"));
    expect(inboxDir(dir)).toBe(join(dir, "memory-sync", "inbox"));
  });
});

describe("pushOutbox", () => {
  it("pushes a changed outbox to every paired peer and stamps when all accept", async () => {
    seedPeer("node-a", "tok-a");
    seedPeer("node-b", "tok-b");
    const outbox = writeOutbox(dir, JSONL);

    const seen: Array<{ from?: string; proof?: string }> = [];
    const post: SyncPost = vi.fn(async (target) => {
      seen.push(target);
      return "ok" as const;
    });
    const identity = loadOrCreateIdentity(join(dir, "identity"));
    const state = { lastPushedMtimeMs: -1 };
    const results = await pushOutbox({ dataDir: dir, db, identity, state, post });
    expect(results.map((r) => r.node_id).sort()).toEqual(["node-a", "node-b"]);
    expect(results.every((r) => r.outcome === "ok" && r.bytes === Buffer.byteLength(JSONL))).toBe(
      true,
    );
    // The push carries the sender identity and proof, like every mail.
    expect(seen[0]?.from).toBe(identity.node_id);
    expect(seen[0]?.proof).toContain(".");
    expect(state.lastPushedMtimeMs).toBeGreaterThan(0);

    // Unchanged outbox: no second push.
    expect(await pushOutbox({ dataDir: dir, db, identity, state, post })).toEqual([]);

    // A rewrite (new mtime) pushes again.
    writeFileSync(outbox, `${JSONL}{"id":"a3"}\n`);
    expect(await pushOutbox({ dataDir: dir, db, identity, state, post })).toHaveLength(2);
  });

  it("never stamps while a peer fails, so the next cycle catches it up", async () => {
    seedPeer("node-a", "tok-a");
    seedPeer("node-down", "tok-down");
    writeOutbox(dir, JSONL);

    const post: SyncPost = vi.fn(async (target: { token: string }) =>
      target.token === "tok-down" ? ("unreachable" as const) : ("ok" as const),
    );
    const identity = loadOrCreateIdentity(join(dir, "identity"));
    const state = { lastPushedMtimeMs: -1 };
    const results: SyncPushResult[] = await pushOutbox({ dataDir: dir, db, identity, state, post });
    expect(results.map((r) => r.outcome).sort()).toEqual(["ok", "unreachable"]);
    expect(state.lastPushedMtimeMs).toBe(-1);

    // The down peer recovers: the retry delivers to both (duplicate is harmless).
    const recovering: SyncPost = async () => "ok";
    const retry = await pushOutbox({ dataDir: dir, db, identity, state, post: recovering });
    expect(retry).toHaveLength(2);
    expect(state.lastPushedMtimeMs).toBeGreaterThan(0);
  });

  it("pushes nothing without an outbox, without peers, and skips unpaired rows", async () => {
    const identity = loadOrCreateIdentity(join(dir, "identity"));
    expect(
      await pushOutbox({ dataDir: dir, db, identity, state: { lastPushedMtimeMs: -1 } }),
    ).toEqual([]);

    writeOutbox(dir, JSONL);
    // Discovered but unpaired: not sendable, so no push and no stamp.
    db.conn.run(
      "INSERT INTO peers (node_id, hostname, fingerprint, addresses, paired, token, last_seen, tls) VALUES ('node-x', 'x', 'f', '[]', 0, NULL, 0, 1)",
    );
    const state = { lastPushedMtimeMs: -1 };
    expect(await pushOutbox({ dataDir: dir, db, identity, state })).toEqual([]);
    expect(state.lastPushedMtimeMs).toBe(-1);
  });
});

describe("startMemorySyncPusher", () => {
  it("is inert when the interval is 0 (off)", async () => {
    writeOutbox(dir, JSONL);
    const post: SyncPost = vi.fn(async () => "ok" as const);
    const pusher = startMemorySyncPusher({
      dataDir: dir,
      db,
      identity: loadOrCreateIdentity(join(dir, "identity")),
      intervalMs: 0,
      post,
    });
    pusher.stop();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });

  it("pushes once at boot (the stamp then mutes unchanged ticks), and stops cleanly", async () => {
    writeOutbox(dir, JSONL);
    seedPeer("node-a", "tok-a");
    const post: SyncPost = vi.fn(async () => "ok" as const);
    const pusher = startMemorySyncPusher({
      dataDir: dir,
      db,
      identity: loadOrCreateIdentity(join(dir, "identity")),
      intervalMs: 20,
      post,
    });
    const at = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await at(80);
    pusher.stop();
    // Exactly one boot push: after it is accepted, later ticks see an unchanged,
    // already-delivered outbox and stay silent.
    expect((post as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await at(60);
    expect((post as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe("POST /memory-sync endpoint", () => {
  it("stores the payload for the authenticated peer, 401 without a paired token", async () => {
    seedPeer("node-peer", "tok-peer");
    const { server, port } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      dataDir: dir,
      self: { node_id: "self-node", pk: "self-pk", hostname: "self-host" },
    });
    const url = `http://127.0.0.1:${port}`;

    const ok = await fetch(`${url}/memory-sync`, {
      method: "POST",
      headers: { authorization: "Bearer tok-peer" },
      body: JSONL,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accepted: Buffer.byteLength(JSONL) });
    expect(readFileSync(join(inboxDir(dir), "node-peer.jsonl"), "utf8")).toBe(JSONL);

    const bad = await fetch(`${url}/memory-sync`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSONL,
    });
    expect(bad.status).toBe(401);

    const anonymous = await fetch(`${url}/memory-sync`, { method: "POST", body: JSONL });
    expect(anonymous.status).toBe(401);
    server.close();
  });

  it("binds an asymmetric pairing token on the first accepted push, like the first mail", async () => {
    // The legacy/code pairings leave each side holding the OTHER's offer token.
    // The peer row exists (with its pinned key), and the sender's offer token still
    // sits in pending_tokens: the first proof-carrying push must rebind the row,
    // exactly as the first mail does.
    const peerIdentity = loadOrCreateIdentity(join(dir, "peer-identity"));
    seedPeer(peerIdentity.node_id, "tok-old", peerIdentity.public_key);
    const fresh = createPairingToken(db);
    const { server, port } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      dataDir: dir,
      self: { node_id: "self-node", pk: "self-pk", hostname: "self-host" },
    });

    const response = await fetch(`http://127.0.0.1:${port}/memory-sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fresh}`,
        "x-mesh-sender": peerIdentity.node_id,
        "x-mesh-proof": pairingProof(peerIdentity, fresh),
      },
      body: JSONL,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: Buffer.byteLength(JSONL) });
    expect(readFileSync(join(inboxDir(dir), `${peerIdentity.node_id}.jsonl`), "utf8")).toBe(JSONL);

    // A forged proof must not bind: the presented key differs from the pinned one.
    const forger = loadOrCreateIdentity(join(dir, "forger-identity"));
    const fresh2 = createPairingToken(db);
    const forged = await fetch(`http://127.0.0.1:${port}/memory-sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fresh2}`,
        "x-mesh-sender": peerIdentity.node_id,
        "x-mesh-proof": pairingProof(forger, fresh2),
      },
      body: JSONL,
    });
    expect(forged.status).toBe(401);
    server.close();
  });

  it("refuses a peer whose node id cannot name an inbox file", async () => {
    seedPeer("../evil", "tok-evil");
    const { server, port } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      dataDir: dir,
      self: { node_id: "self-node", pk: "self-pk", hostname: "self-host" },
    });
    const response = await fetch(`http://127.0.0.1:${port}/memory-sync`, {
      method: "POST",
      headers: { authorization: "Bearer tok-evil" },
      body: JSONL,
    });
    expect(response.status).toBe(500);
    server.close();
  });

  it("answers 503 when no dataDir was configured", async () => {
    const { server, port } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      self: { node_id: "self-node", pk: "self-pk", hostname: "self-host" },
    });
    const response = await fetch(`http://127.0.0.1:${port}/memory-sync`, {
      method: "POST",
      body: JSONL,
    });
    expect(response.status).toBe(503);
    server.close();
  });

  it("accepts exactly 1 MiB and rejects 1 MiB + 1 with 413 (boundary, 0.18.0)", async () => {
    seedPeer("node-peer", "tok-peer");
    const { server, port } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      dataDir: dir,
      self: { node_id: "self-node", pk: "self-pk", hostname: "self-host" },
    });
    const url = `http://127.0.0.1:${port}`;

    // Exactly at the limit: accepted (the checks are strict `>`).
    const at = await fetch(`${url}/memory-sync`, {
      method: "POST",
      headers: { authorization: "Bearer tok-peer" },
      body: "a".repeat(1024 * 1024),
    });
    expect(at.status).toBe(200);
    expect(await at.json()).toEqual({ accepted: 1024 * 1024 });

    // One byte over: 413 (rejected through the content-length pre-check).
    const over = await fetch(`${url}/memory-sync`, {
      method: "POST",
      headers: { authorization: "Bearer tok-peer" },
      body: "a".repeat(1024 * 1024 + 1),
    });
    expect(over.status).toBe(413);

    server.close();
  });
});
