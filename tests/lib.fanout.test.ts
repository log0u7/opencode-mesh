import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openMeshDb, type MeshDb } from "../src/lib/db.js";
import { createFanout } from "../src/lib/fanout.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../src/lib/identity.js";
import { deliverMessage, inboxRows, registerMailbox, joinPool } from "../src/lib/mail.js";
import { pairWithToken as pairPeer } from "../src/lib/peers.js";

type PeerServer = { node_id: string; url: string; received: Array<Record<string, unknown>> };

// A fake peer: an HTTP server answering GET /pools and POST /mail.
async function startFakePeer(
  node_id: string,
  pools: Record<string, string[]>,
): Promise<PeerServer> {
  const { createServer } = await import("node:http");
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/pools") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ pools }));
        return;
      }
      if (req.url === "/mail") {
        received.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    node_id,
    url: `http://127.0.0.1:${port}`,
    received,
    // expose close via symbol
    ...({ server } as object),
  } as PeerServer & { server: import("node:http").Server };
}

function db(): MeshDb {
  return openMeshDb(":memory:");
}

describe("createFanout", () => {
  it("forwards a pool broadcast only to peers holding members", async () => {
    const local = db();
    const identity = loadOrCreateIdentity(join(tmpdir(), "fanout-id-1")) as NodeIdentity;
    registerMailbox(local, { name: "ops", session_id: "s0", now: 1000 });
    joinPool(local, "ops", "team:infra");

    const withMember = await startFakePeer("peer-with", { "team:infra": ["sre"] });
    const withoutMember = await startFakePeer("peer-without", { "team:qa": ["test"] });
    for (const peer of [withMember, withoutMember]) {
      pairPeer(local, {
        node_id: peer.node_id,
        hostname: peer.node_id,
        fingerprint: peer.node_id,
        token: "tok",
        addresses: [peer.url.replace("http://", "")],
      });
      // The fake peers are plain-HTTP: pairing flags tls=1 (0.11+ default),
      // downgraded here to exercise the legacy fanout path.
      local.conn.run("UPDATE peers SET tls = 0");
    }

    const fanout = createFanout({
      db: local,
      identity,
      poolsCacheTtlMs: 60_000,
    });
    const forwarded = await fanout.fanout({
      to_box: "team:infra",
      origin_id: "11111111-1111-4111-8111-111111111111",
      from_box: "ops",
      subject: "status: go",
      body: "...",
      via: [],
    });

    expect(forwarded).toEqual(["peer-with"]);
    expect(withMember.received).toHaveLength(1);
    expect(withoutMember.received).toHaveLength(0);
    const mail = withMember.received[0] as Record<string, unknown>;
    expect(mail.to).toBe("team:infra");
    expect(mail.origin_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(mail.via).toEqual([identity.node_id]);
    expect(mail.from_box).toBe("ops");

    (withMember as unknown as { server: { close(): void } }).server.close();
    (withoutMember as unknown as { server: { close(): void } }).server.close();
    local.close();
  });

  it("skips a TLS peer with no pinned key — no silent TOFU (0.18.0)", async () => {
    const local = db();
    const peer = await startFakePeer("peer-tls", { "team:x": ["a"] });
    pairPeer(local, {
      node_id: peer.node_id,
      hostname: peer.node_id,
      fingerprint: peer.node_id,
      token: "tok",
      addresses: [peer.url.replace("http://", "")],
    });
    // The dangerous shape: TLS on (the pairing default) with NO pinned key —
    // the transport would accept any certificate on a token-authenticated
    // channel. The fanout must not hand the mail (and its bearer token) there.
    local.conn.run("UPDATE peers SET tls = 1, public_key = NULL");

    const identity = loadOrCreateIdentity(join(tmpdir(), "fanout-id-tlspk")) as NodeIdentity;
    const fanout = createFanout({ db: local, identity, poolsCacheTtlMs: 60_000 });
    const forwarded = await fanout.fanout({
      to_box: "team:x",
      origin_id: "66666666-6666-4666-8666-666666666666",
      from_box: "ops",
      subject: "status: go",
      body: "...",
      via: [],
    });

    expect(forwarded).toEqual([]);
    expect(peer.received).toHaveLength(0);

    (peer as unknown as { server: { close(): void } }).server.close();
    local.close();
  });

  it("calls rebrowse when a forward lands unreachable (stale address heal)", async () => {
    const local = db();
    const identity = loadOrCreateIdentity(join(tmpdir(), "fanout-id-rebrowse")) as NodeIdentity;
    registerMailbox(local, { name: "ops", session_id: "s0", now: 1000 });
    joinPool(local, "ops", "team:infra");

    // A paired peer whose address is dead (DHCP churn: the peer moved).
    pairPeer(local, {
      node_id: "peer-moved",
      hostname: "peer-moved",
      fingerprint: "peer-moved",
      token: "tok",
      addresses: ["127.0.0.1:1"],
    });
    local.conn.run("UPDATE peers SET tls = 0");

    const rebrowse = vi.fn();
    const fanout = createFanout({ db: local, identity, rebrowse });
    const forwarded = await fanout.fanout({
      to_box: "team:infra",
      origin_id: "22222222-2222-4222-8222-222222222222",
      from_box: "ops",
      subject: "status: go",
      body: "...",
      via: [],
    });

    expect(forwarded).toEqual([]);
    expect(rebrowse).toHaveBeenCalled();

    local.close();
  });

  it("never forwards to a peer listed in via", async () => {
    const local = db();
    const peer = await startFakePeer("peer-a", { "team:x": ["a"] });
    pairPeer(local, {
      node_id: "peer-a",
      hostname: "peer-a",
      fingerprint: "f",
      token: "tok",
      addresses: [peer.url.replace("http://", "")],
    });

    const fanout = createFanout({
      db: local,
      identity: loadOrCreateIdentity(join(tmpdir(), "fanout-id-2")) as NodeIdentity,
    });
    const forwarded = await fanout.fanout({
      to_box: "team:x",
      origin_id: "22222222-2222-4222-8222-222222222222",
      from_box: null,
      subject: "s",
      body: "b",
      via: ["self-1", "peer-a"],
    });

    expect(forwarded).toEqual([]);
    expect(peer.received).toHaveLength(0);
    (peer as unknown as { server: { close(): void } }).server.close();
    local.close();
  });

  it("forwards all-broadcasts to every paired peer", async () => {
    const local = db();
    const p1 = await startFakePeer("p1", {});
    const p2 = await startFakePeer("p2", {});
    for (const peer of [p1, p2]) {
      pairPeer(local, {
        node_id: peer.node_id,
        hostname: peer.node_id,
        fingerprint: peer.node_id,
        token: "tok",
        addresses: [peer.url.replace("http://", "")],
      });
      // Plain-HTTP fake peers: downgrade the pairing flag (0.11+ default TLS).
      local.conn.run("UPDATE peers SET tls = 0");
    }

    const fanout = createFanout({
      db: local,
      identity: loadOrCreateIdentity(join(tmpdir(), "fanout-id-2")) as NodeIdentity,
    });
    const forwarded = await fanout.fanout({
      to_box: "all",
      origin_id: "33333333-3333-4333-8333-333333333333",
      from_box: "ops",
      subject: "org change",
      body: "...",
      via: [],
    });

    expect(forwarded.sort()).toEqual(["p1", "p2"]);
    (p1 as unknown as { server: { close(): void } }).server.close();
    (p2 as unknown as { server: { close(): void } }).server.close();
    local.close();
  });

  it("forwards the wake flag to peers (0.17.0)", async () => {
    const local = db();
    const p1 = await startFakePeer("p1w", { "team:infra": ["sre"] });
    pairPeer(local, {
      node_id: p1.node_id,
      hostname: p1.node_id,
      fingerprint: p1.node_id,
      token: "tok",
      addresses: [p1.url.replace("http://", "")],
    });
    local.conn.run("UPDATE peers SET tls = 0");

    const fanout = createFanout({
      db: local,
      identity: loadOrCreateIdentity(join(tmpdir(), "fanout-id-wake")) as NodeIdentity,
    });
    const forwarded = await fanout.fanout({
      to_box: "team:infra",
      origin_id: "55555555-5555-4555-8555-555555555555",
      from_box: "ops",
      subject: "r8 go",
      body: "...",
      via: [],
      wake: true,
    });

    expect(forwarded).toEqual(["p1w"]);
    const mail = p1.received[0] as Record<string, unknown>;
    expect(mail.wake).toBe(true);

    (p1 as unknown as { server: { close(): void } }).server.close();
    local.close();
  });

  it("deliverMessage dedups by origin_id: second arrival is a no-op", () => {
    const d = db();
    registerMailbox(d, { name: "sre", session_id: "s1", now: 1000 });
    const origin = "44444444-4444-4444-8444-444444444444";

    const first = deliverMessage(d, {
      from: "n",
      to_box: "sre",
      subject: "s",
      body: "b",
      origin_id: origin,
      created_at: 2000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.recipients).toEqual(["sre"]);

    const second = deliverMessage(d, {
      from: "n2",
      to_box: "sre",
      subject: "s",
      body: "b",
      origin_id: origin,
      created_at: 3000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.recipients).toEqual([]);
    expect(second.id).toBe(first.id);

    // Exactly one unread delivery for sre.
    expect(inboxRows(d, "s1")).toHaveLength(1);
    d.close();
  });
});
