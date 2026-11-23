import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb, type MeshDb } from "../src/lib/db.js";
import { createFanout } from "../src/lib/fanout.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../src/lib/identity.js";
import { inboxRows, joinPool, registerMailbox } from "../src/lib/mail.js";
import { pairWithToken, upsertDiscoveredPeer } from "../src/lib/peers.js";
import { sendMail } from "../src/lib/client.js";
import { startMeshServer } from "../src/lib/serve.js";
import { buildToolSpecs, type MeshContext, type ToolSpec } from "../src/tools.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-multihop-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tools(db: MeshDb, identity: NodeIdentity) {
  const specs = new Map<string, ToolSpec>(
    buildToolSpecs({
      db,
      identity,
      dataDir: dir,
      serverAddress: "127.0.0.1",
      port: 0,
      bindKey: "test-bind",
      fanout: createFanout({ db, identity }),
      worktreeClient: null as never,
      spawnFn: null as never,
    }).map((s) => [s.name, s]),
  );
  return (
    name: string,
    args: Record<string, unknown> = {},
    sessionID = "s-origin",
  ): Promise<string> => specs.get(name)!.execute(args, { sessionID });
}

// Plain-HTTP pairings: the real flow pairs TLS (pinned keys), the e2e wires
// the three nodes without TLS like the other transport tests do.
function pairPlain(
  db: MeshDb,
  peer: {
    node_id: string;
    hostname: string;
    fingerprint: string;
    token: string;
    addresses?: string[];
    public_key?: string;
  },
): void {
  upsertDiscoveredPeer(db, {
    node_id: peer.node_id,
    hostname: peer.hostname,
    fingerprint: peer.fingerprint,
    addresses: peer.addresses ?? [],
    ...(peer.public_key === undefined ? {} : { public_key: peer.public_key }),
  });
  pairWithToken(db, {
    node_id: peer.node_id,
    hostname: peer.hostname,
    fingerprint: peer.fingerprint,
    token: peer.token,
    ...(peer.addresses === undefined ? {} : { addresses: peer.addresses }),
    ...(peer.public_key === undefined ? {} : { public_key: peer.public_key }),
  });
  db.conn.run("UPDATE peers SET tls = 0");
}

describe("multi-hop fanout (0.18.0)", () => {
  // The 3-node regression: the origin broadcasts to team:x; only the relay
  // (B) is reachable from A. B must re-forward to C signing with ITS OWN
  // identity — the pre-0.18.0 relay forwarded `from: <origin>`, and C's
  // from===token-owner check 401'd the hop: the mail died at B.
  it("delivers an origin broadcast through a relay to the third node", async () => {
    const origin = loadOrCreateIdentity(join(dir, "a"));
    const relay = loadOrCreateIdentity(join(dir, "b"));
    const final = loadOrCreateIdentity(join(dir, "c"));
    const dbA = openMeshDb(":memory:");
    const dbB = openMeshDb(":memory:");
    const dbC = openMeshDb(":memory:");

    registerMailbox(dbA, { name: "origin-box", session_id: "s-origin", now: 1000 });
    registerMailbox(dbB, { name: "relay-member", session_id: "s-relay", now: 1000 });
    joinPool(dbB, "relay-member", "team:x");
    registerMailbox(dbC, { name: "final-member", session_id: "s-final", now: 1000 });
    joinPool(dbC, "final-member", "team:x");

    const serverB = await startMeshServer({
      db: dbB,
      port: 0,
      tls: false,
      fanout: createFanout({ db: dbB, identity: relay }),
      self: { node_id: relay.node_id, pk: relay.public_key, hostname: "relay" },
    });
    const serverC = await startMeshServer({
      db: dbC,
      port: 0,
      tls: false,
      fanout: createFanout({ db: dbC, identity: final }),
      self: { node_id: final.node_id, pk: final.public_key, hostname: "final" },
    });
    const addrB = `127.0.0.1:${serverB.port}`;
    const addrC = `127.0.0.1:${serverC.port}`;

    // A↔B and B↔C; A holds NO direct pairing with C.
    pairPlain(dbA, {
      node_id: relay.node_id,
      hostname: "relay",
      fingerprint: "fB",
      token: "tAB",
      addresses: [addrB],
      public_key: relay.public_key,
    });
    pairPlain(dbB, {
      node_id: origin.node_id,
      hostname: "origin",
      fingerprint: "fA",
      token: "tAB",
      public_key: origin.public_key,
    });
    pairPlain(dbB, {
      node_id: final.node_id,
      hostname: "final",
      fingerprint: "fC",
      token: "tBC",
      addresses: [addrC],
      public_key: final.public_key,
    });
    pairPlain(dbC, {
      node_id: relay.node_id,
      hostname: "relay",
      fingerprint: "fB",
      token: "tBC",
      public_key: relay.public_key,
    });

    // The origin broadcasts (no local team:x member on A: forwarded only).
    const out = await tools(dbA, origin)("mesh_send", {
      to: "team:x",
      subject: "status: go",
      body: "build is green",
    });
    const sent = JSON.parse(out) as { id: string; forwarded: string[] };
    expect(sent.forwarded).toEqual([relay.node_id]);

    // The relay delivered locally, then hopped to C signed as B.
    await vi.waitFor(
      () => {
        expect(inboxRows(dbC, "s-final")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    expect(inboxRows(dbC, "s-final")[0]?.subject).toBe("status: go");
    const onC = dbC.conn.get<{
      from_node: string;
      from_box: string | null;
      origin_id: string | null;
    }>("SELECT from_node, from_box, origin_id FROM messages")!;
    // The wire `from` is the relay (token/proof owner at that hop); the
    // origin stays traceable through origin_id + from_box.
    expect(onC.from_node).toBe(relay.node_id);
    expect(onC.from_box).toBe("origin-box");
    expect(onC.origin_id).toBe(sent.id);

    // The relay box got its copy too.
    expect(inboxRows(dbB, "s-relay")).toHaveLength(1);

    serverB.server.close();
    serverC.server.close();
  });

  // A mesh is a mesh: the same broadcast can reach C directly AND through the
  // relay. origin_id dedup must keep exactly one delivery (and the direct leg
  // must not wake-loop C's fanout back toward B).
  it("dedups a direct re-delivery of an already-relayed broadcast", async () => {
    const origin = loadOrCreateIdentity(join(dir, "a2"));
    const final = loadOrCreateIdentity(join(dir, "c2"));
    const dbC = openMeshDb(":memory:");
    registerMailbox(dbC, { name: "final-member", session_id: "s-final", now: 1000 });
    joinPool(dbC, "final-member", "team:x");
    const serverC = await startMeshServer({
      db: dbC,
      port: 0,
      tls: false,
      fanout: createFanout({ db: dbC, identity: final }),
      self: { node_id: final.node_id, pk: final.public_key, hostname: "final" },
    });
    pairPlain(dbC, {
      node_id: origin.node_id,
      hostname: "origin",
      fingerprint: "fA",
      token: "tAC",
      public_key: origin.public_key,
    });

    // First arrival stores the message under its origin id.
    const first = await sendMail({
      url: `http://127.0.0.1:${serverC.port}`,
      token: "tAC",
      from: origin.node_id,
      from_box: "origin-box",
      to: "team:x",
      subject: "status: go",
      body: "build is green",
      origin_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(first).toBe("ok");

    // Second arrival, same origin id (the relay path catching up): no-op.
    const second = await sendMail({
      url: `http://127.0.0.1:${serverC.port}`,
      token: "tAC",
      from: origin.node_id,
      from_box: "origin-box",
      to: "team:x",
      subject: "status: go",
      body: "build is green",
      origin_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(second).toBe("ok");

    expect(dbC.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages")?.n).toBe(1);
    expect(
      dbC.conn.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'final-member'",
      )?.n,
    ).toBe(1);

    serverC.server.close();
  });
});
