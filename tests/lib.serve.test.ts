import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { connect } from "node:net";

import { openMeshDb } from "../src/lib/db.js";
import {
  inboxRows,
  MESSAGE_TTL_MS,
  receiveMessage,
  registerMailbox,
  unreadMessages,
} from "../src/lib/mail.js";
import { pairingProof, pairingProofPayload, signPairingProof } from "../src/lib/identity.js";
import { pairWithToken, upsertDiscoveredPeer, createPairingToken } from "../src/lib/peers.js";
import { pairCodeThrottled, startMeshServer } from "../src/lib/serve.js";
import type { HostCapa } from "../src/lib/capa.js";

let dir: string;

const SELF = { node_id: "self", pk: "test-pk", hostname: "localhost" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-serve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function start() {
  const db = openMeshDb(join(dir, "mesh.db"));
  const { server, port } = await startMeshServer({ db, port: 0, tls: false, self: SELF });
  const url = `http://127.0.0.1:${port}`;
  return { db, server, url };
}

async function post(url: string, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("mesh server bind", () => {
  it("binds loopback by default and reports the address it bound", async () => {
    const db = openMeshDb(":memory:");
    const { server, port, address } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      self: SELF,
    });

    expect(address).toBe("127.0.0.1");
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });

    server.close();
    db.close();
  });

  it("binds every interface only when explicitly asked for lan", async () => {
    const db = openMeshDb(":memory:");
    const { server, address } = await startMeshServer({
      db,
      port: 0,
      bind: "lan",
      tls: false,
      self: SELF,
    });

    expect(address).not.toBe("127.0.0.1");

    server.close();
    db.close();
  });

  it("serves mail on the non-loopback interface when lan is opted into", async () => {
    const db = openMeshDb(":memory:");
    const { server, port, address } = await startMeshServer({
      db,
      port: 0,
      bind: "lan",
      tls: false,
      self: SELF,
    });

    const lanIp = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface?.family === "IPv4" && !iface.internal)?.address;

    if (lanIp !== undefined) {
      pairWithToken(db, {
        node_id: "peer1",
        hostname: "laptop",
        fingerprint: "ff00",
        token: "tok-peer1",
      });
      const response = await post(
        `http://${lanIp}:${port}`,
        "/mail",
        {
          subject: "x",
          body: "y",
          from: "peer1",
        },
        "tok-peer1",
      );
      expect(response.status).toBe(200);
    }
    expect(address).not.toBe("127.0.0.1");

    server.close();
    db.close();
  });
});

describe("mesh server", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { db, server, url } = await start();

    const noToken = await post(url, "/mail", { subject: "x", body: "y", from: "n1" });
    expect(noToken.status).toBe(401);

    const badToken = await post(url, "/mail", { subject: "x", body: "y", from: "n1" }, "wrong");
    expect(badToken.status).toBe(401);

    server.close();
    db.close();
  });

  it("rejects oversized bodies with 413", async () => {
    const { db, server, url } = await start();

    const response = await post(url, "/mail", {
      subject: "x",
      body: "y".repeat(70_000),
      from: "n1",
    });
    expect(response.status).toBe(413);

    server.close();
    db.close();
  });

  it("accepts mail from a paired peer token and stores it", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    const response = await post(
      url,
      "/mail",
      { subject: "handoff", body: "api is done", from: "peer1" },
      token,
    );
    expect(response.status).toBe(200);

    server.close();
    db.close();
  });

  it("stores the wake flag carried by POST /mail (0.17.0)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";
    registerMailbox(db, { name: "ops", session_id: "sess-ops", now: Date.now() });

    const flagged = await post(
      url,
      "/mail",
      { subject: "r8 go", body: "b", from: "peer1", to: "ops", wake: true },
      token,
    );
    expect(flagged.status).toBe(200);
    const plain = await post(
      url,
      "/mail",
      { subject: "status", body: "b", from: "peer1", to: "ops" },
      token,
    );
    expect(plain.status).toBe(200);

    const wakes = db.conn
      .all<{ subject: string; wake: number }>(
        "SELECT subject, wake FROM messages ORDER BY created_at",
      )
      .map((r) => `${r.subject}:${r.wake}`);
    expect(wakes).toEqual(["r8 go:1", "status:0"]);

    server.close();
    db.close();
  });

  it("returns 401 for a paired token from a different node id", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    const response = await post(
      url,
      "/mail",
      { subject: "spoof", body: "x", from: "other-node" },
      token,
    );
    expect(response.status).toBe(401);

    server.close();
    db.close();
  });
});

describe("mesh server routes", () => {
  it("answers 500 JSON when a route throws instead of crashing the host (0.18.0)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff",
      token: "tok-peer1",
    });
    // Any route that touches the db now throws (closed database): without the
    // handler wrapper this surfaces as an unhandled rejection in the host
    // process; with it the client sees a plain 500.
    db.close();
    const response = await fetch(`${url}/status`, {
      headers: { authorization: "Bearer tok-peer1" },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });

    server.close();
  });

  it("POST /registry-sync merges the peer's rows through the real handler (the mr-review 🔴)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const response = await post(
      url,
      "/registry-sync",
      {
        registry: [
          {
            name: "remote-dev",
            session_id: "ses-remote",
            role: "ops",
            pools: "[]",
            primary_pool: null,
            registered_at: Date.now() - 1000,
          },
        ],
      },
      "tok-peer1",
    );
    // The nested-transaction regression made EVERY push 500 and the
    // federation silently dead on the wire: the route must merge for real.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 1 });
    const row = db.conn.get<{ node_id: string }>(
      "SELECT node_id FROM mailboxes WHERE name = 'remote-dev'",
    );
    expect(row?.node_id).toBe("peer1");
    server.close();
  });

  it("bounds the pair-code attempt map (LRU cap, 0.18.0)", () => {
    // The cap evicts the OLDEST remote: a fresh flood of spoofed sources
    // cannot grow the map, and an evicted remote starts a fresh window.
    const first = "remote-1";
    expect(pairCodeThrottled(first)).toBe(false);
    for (let i = 2; i <= 1001; i += 1) {
      pairCodeThrottled(`remote-${i}`);
    }
    // The first remote was evicted: five more attempts stay unthrottled (a
    // retained entry would have throttled on the 6th total call).
    for (let i = 0; i < 5; i += 1) {
      expect(pairCodeThrottled(first)).toBe(false);
    }
    // A recently-seen remote keeps its window: 1 flood call + 5 now → throttled.
    const recent = "remote-1001";
    for (let i = 0; i < 5; i += 1) {
      pairCodeThrottled(recent);
    }
    expect(pairCodeThrottled(recent)).toBe(true);
  });

  it("answers /status with node identity for a valid token", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    const response = await fetch(`${url}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { node_id: string; unread: number };
    expect(body.node_id).toBe("peer1");
    expect(body.unread).toBe(0);

    server.close();
    db.close();
  });

  it("exposes no lock route: locks stay local to this host (guard)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    // mesh_lock is deliberately not part of the wire protocol. A future
    // half-measure that adds a lock endpoint must fail here.
    for (const path of ["/lock", "/locks", "/unlock", "/announce"]) {
      expect((await post(url, path, { path: "a" }, token)).status).toBe(404);
    }

    server.close();
    db.close();
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    expect((await post(url, "/nope", { x: 1 }, token)).status).toBe(404);
    expect(
      (
        await fetch(`${url}/status`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(405);

    server.close();
    db.close();
  });

  it("rejects mail with a missing or mismatched body (400)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    expect((await post(url, "/mail", { nope: true }, token)).status).toBe(400);

    server.close();
    db.close();
  });
});

describe("mesh server body guard", () => {
  it("rejects oversized chunked bodies without content-length (413)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    const urlObj = new URL(url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: urlObj.hostname,
          port: urlObj.port,
          path: "/mail",
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      // No content-length header: node uses chunked encoding when we write in pieces.
      const chunk = "y".repeat(16 * 1024);
      for (let i = 0; i < 6; i++) {
        req.write(chunk);
      }
      req.end();
    });
    expect(status).toBe(413);

    server.close();
    db.close();
  });

  it("reports a body read failure as 400, not 413 (socket error)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";
    const urlObj = new URL(url);

    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect({ host: urlObj.hostname, port: Number(urlObj.port) }, () => {
        // Declare a 100-byte body, send 10, then half-close: the read fails
        // (aborted/reset) without ever completing.
        socket.write(
          `POST /mail HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n`,
        );
        socket.write("0123456789");
        socket.end();
      });
      let raw = "";
      socket.on("data", (chunk) => {
        raw += chunk.toString();
      });
      socket.on("end", () => resolve(Number(/HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0)));
      socket.on("error", reject);
    });

    expect(status).toBe(400);

    server.close();
    db.close();
  });
});

describe("mesh server pairing proof", () => {
  function nodeKeys() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      public_key: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"),
      private_key: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString(
        "base64",
      ),
    };
  }

  it("binds a pending token over /mail only with a valid sender proof", async () => {
    const { db, server, url } = await start();
    const keys = nodeKeys();
    upsertDiscoveredPeer(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      addresses: [],
      public_key: keys.public_key,
    });
    const token = createPairingToken(db);
    const proof = `${keys.public_key}.${signPairingProof(
      keys.private_key,
      pairingProofPayload("peer1", token),
    )}`;

    // No proof: the pending token binds nothing, even from a known node.
    const noProof = await post(url, "/mail", { subject: "s", body: "b", from: "peer1" }, token);
    expect(noProof.status).toBe(401);

    // Wrong signer: refused.
    const wrongSigner = `${keys.public_key}.${signPairingProof(
      nodeKeys().private_key,
      pairingProofPayload("peer1", token),
    )}`;
    const bad = await post(
      url,
      "/mail",
      { subject: "s", body: "b", from: "peer1", proof: wrongSigner },
      token,
    );
    expect(bad.status).toBe(401);

    // The peer's real proof: binding happens, mail accepted.
    const good = await post(
      url,
      "/mail",
      { subject: "handoff", body: "x", from: "peer1", proof },
      token,
    );
    expect(good.status).toBe(200);

    server.close();
    db.close();
  });

  it("accepts mail from a paired peer whose credential matches, proof optional", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });

    const response = await post(
      url,
      "/mail",
      { subject: "s", body: "b", from: "peer1" },
      "tok-peer1",
    );
    expect(response.status).toBe(200);

    // Intent pin: the live credential answers by itself; a garbage proof is
    // never consulted on this path.
    const withGarbage = await post(
      url,
      "/mail",
      { subject: "s", body: "b", from: "peer1", proof: "nonsense" },
      "tok-peer1",
    );
    expect(withGarbage.status).toBe(200);

    server.close();
    db.close();
  });

  it("signs outgoing mail like a peer would (sendMail carries the proof)", async () => {
    const { db, server, url } = await start();
    const keys = nodeKeys();
    upsertDiscoveredPeer(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      addresses: [],
      public_key: keys.public_key,
    });
    const token = createPairingToken(db);

    // The sender-side proof helper produces a verifying wire proof.
    const proof = pairingProof(
      { node_id: "peer1", public_key: keys.public_key, private_key: keys.private_key },
      token,
    );
    const response = await post(
      url,
      "/mail",
      { subject: "s", body: "b", from: "peer1", proof },
      token,
    );
    expect(response.status).toBe(200);

    server.close();
    db.close();
  });
});

describe("mesh server status auth", () => {
  it("rejects /status without a valid token (401)", async () => {
    const { db, server, url } = await start();

    const response = await fetch(`${url}/status`, { headers: { authorization: "Bearer wrong" } });
    expect(response.status).toBe(401);

    server.close();
    db.close();
  });
});

describe("mesh server mailboxes", () => {
  it("routes remote mail with a known to-box into that box's deliveries only", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    registerMailbox(db, { name: "dev", session_id: "sess-dev", now: Date.now() });

    const response = await post(
      url,
      "/mail",
      { subject: "task", body: "hello box", from: "peer1", to: "dev" },
      "tok-peer1",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; unread: number; delivered: number };
    expect(body).toEqual({ ok: true, unread: 1, delivered: 1 });

    const inbox = inboxRows(db, "sess-dev");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.subject).toBe("task");
    expect(inbox[0]?.from).toBe("peer1");
    // Targeted mail never lands in the legacy global inbox too.
    expect(unreadMessages(db)).toHaveLength(0);

    server.close();
    db.close();
  });

  it("falls back to the global inbox when the addressed box is unknown", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });

    const response = await post(
      url,
      "/mail",
      { subject: "stray", body: "no box here", from: "peer1", to: "ghost" },
      "tok-peer1",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; unread: number; delivered: number };
    expect(body).toEqual({ ok: true, unread: 1, delivered: 0 });

    const inbox = unreadMessages(db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.subject).toBe("stray");

    server.close();
    db.close();
  });

  it("reports delivered: 0 (not an error) for a broadcast with no local members", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });

    const response = await post(
      url,
      "/mail",
      { subject: "all", body: "to everyone", from: "peer1", to: "all" },
      "tok-peer1",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; unread: number; delivered: number };
    expect(body).toEqual({ ok: true, unread: 0, delivered: 0 });

    server.close();
    db.close();
  });

  it("sweeps messages older than 7 days when the server boots", async () => {
    const db = openMeshDb(":memory:");
    receiveMessage(db, { from: "n0", subject: "old", body: "b" });
    db.conn.run("UPDATE messages SET created_at = ?", [Date.now() - MESSAGE_TTL_MS - 1]);
    receiveMessage(db, { from: "n0", subject: "fresh", body: "b" });

    const { server } = await startMeshServer({ db, port: 0, tls: false, self: SELF });
    expect(unreadMessages(db).map((m) => m.subject)).toEqual(["fresh"]);

    server.close();
    db.close();
  });
});

describe("GET /metrics", () => {
  async function startWithMetrics(capa?: () => Promise<HostCapa>) {
    const db = openMeshDb(":memory:");
    const { server, port } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      self: SELF,
      ...(capa !== undefined ? { capa } : {}),
    });
    const url = `http://127.0.0.1:${port}`;
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    return { db, server, url };
  }

  async function get(url: string, path: string, token?: string) {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    return fetch(`${url}${path}`, { headers });
  }

  it("answers 401 without the bearer token (same auth as /status)", async () => {
    const { db, server, url } = await startWithMetrics();

    expect((await get(url, "/metrics")).status).toBe(401);
    expect((await get(url, "/metrics", "wrong")).status).toBe(401);

    server.close();
    db.close();
  });

  it("renders prometheus text gauges for the db counters", async () => {
    const { db, server, url } = await startWithMetrics();
    receiveMessage(db, { from: "n0", subject: "s1", body: "b" });
    receiveMessage(db, { from: "n0", subject: "s2", body: "b" });
    db.conn.run(
      "INSERT INTO deliveries (id, message_id, to_box, status, created_at) VALUES ('d1', 'x', 'a', 'unread', 1)",
    );

    const response = await get(url, "/metrics", "tok-peer1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-type")).toContain("version=1.0.0");
    const text = await response.text();
    expect(text).toContain("opencode_mesh_messages_total 2");
    expect(text).toContain("opencode_mesh_deliveries_unread 1");
    // Prometheus text format: one metric per line, TYPE declarations present.
    expect(text).toMatch(/^# TYPE opencode_mesh_messages_total gauge$/m);
    db.close();
    server.close();
  });

  it("renders the capa gauges and omits the gpu metric when absent", async () => {
    const { db, server, url } = await startWithMetrics(async () => ({
      cpu: { cores: 8, loadAvg: 0.25 },
      ram: { totalMb: 32000, usedMb: 12000 },
      workersInFlight: 3,
      sessionsRunning: 2,
    }));

    const text = await (await get(url, "/metrics", "tok-peer1")).text();
    expect(text).toContain("opencode_mesh_cpu_load_avg 0.25");
    expect(text).toContain("opencode_mesh_ram_used_mb 12000");
    expect(text).toContain("opencode_mesh_ram_total_mb 32000");
    expect(text).toContain("opencode_mesh_workers_in_flight 3");
    expect(text).toContain("opencode_mesh_sessions_running 2");
    expect(text).not.toContain("opencode_mesh_gpu_vram_used_mb");

    server.close();
    db.close();
  });

  it("renders the gpu metric when the capa snapshot carries one", async () => {
    const { db, server, url } = await startWithMetrics(async () => ({
      cpu: { cores: 8, loadAvg: 0 },
      ram: { totalMb: 32000, usedMb: 0 },
      gpu: { model: "RTX", vramTotalMb: 10240, vramUsedMb: 2345 },
      workersInFlight: 0,
      sessionsRunning: 0,
    }));

    const text = await (await get(url, "/metrics", "tok-peer1")).text();
    expect(text).toContain("opencode_mesh_gpu_vram_used_mb 2345");

    server.close();
    db.close();
  });

  it("keeps every rendered value a finite number", async () => {
    const { db, server, url } = await startWithMetrics(async () => ({
      cpu: { cores: 8, loadAvg: 0.5 },
      ram: { totalMb: 32000, usedMb: 16000 },
      workersInFlight: 1,
      sessionsRunning: 1,
    }));

    const text = await (await get(url, "/metrics", "tok-peer1")).text();
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || line.trim() === "") continue;
      const value = Number(line.slice(line.lastIndexOf(" ") + 1));
      expect(Number.isFinite(value)).toBe(true);
    }

    server.close();
    db.close();
  });

  it("exposes the same capa snapshot on /status", async () => {
    const { db, server, url } = await startWithMetrics(async () => ({
      cpu: { cores: 4, loadAvg: 0 },
      ram: { totalMb: 16000, usedMb: 4000 },
      workersInFlight: 0,
      sessionsRunning: 0,
    }));

    const body = (await (await get(url, "/status", "tok-peer1")).json()) as {
      node_id: string;
      capa?: HostCapa;
    };
    expect(body.node_id).toBe("peer1");
    expect(body.capa?.ram.totalMb).toBe(16000);

    server.close();
    db.close();
  });
});

describe("the task wire routes (refonte P2.5)", () => {
  it("POST /task-ask creates the mirror + delivers the task message; POST /task-reply applies back home", async () => {
    const { db, server, url } = await start();
    registerMailbox(db, { name: "alice", session_id: "s-alice", now: 1000 });
    pairWithToken(db, {
      node_id: "peer-1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    // 401: le proof manque.
    const unauthorized = await post(url, "/task-ask", { task: { id: "t1", to_box: "alice" } });
    expect(unauthorized.status).toBe(401);
    // 400: la payload mal forme.
    const bad = await post(url, "/task-ask", { task: {} }, "tok-peer1");
    expect(bad.status).toBe(400);
    // Le happy path: le miroir + le message dans la box locale.
    const ok = await post(
      url,
      "/task-ask",
      {
        from_box: "alice",
        task: {
          id: "task-abc",
          to_box: "alice",
          question: "quel etat?",
          group_id: null,
          deadline: null,
        },
      },
      "tok-peer1",
    );
    expect(ok.status).toBe(200);
    const mirror = db.conn.get<{ state: string; from_box: string }>(
      "SELECT state, from_box FROM tasks WHERE id = 'task-abc'",
    )!;
    expect(mirror.state).toBe("submitted");
    expect(mirror.from_box).toBe("peer-1/alice");
    expect(
      db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'alice'")?.n,
    ).toBe(1);
    // 404: la reply sur une tache inconnue.
    const unknown = await post(
      url,
      "/task-reply",
      { task: { id: "task-nope", result: "x", state: "completed" } },
      "tok-peer1",
    );
    expect(unknown.status).toBe(404);
    // Le happy path reply: la row originale appliquee.
    db.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, question, state, created_at, updated_at)
       VALUES ('task-xyz', 'alice', 'bob-remote', 'q', 'submitted', 1, 1)`,
    );
    const reply = await post(
      url,
      "/task-reply",
      { task: { id: "task-xyz", result: "tout vert", state: "completed" } },
      "tok-peer1",
    );
    expect(reply.status).toBe(200);
    const applied = db.conn.get<{ state: string }>(
      "SELECT state FROM tasks WHERE id = 'task-xyz'",
    )!;
    expect(applied.state).toBe("completed");
    // La notification locale (l'asker alice est sur CE node).
    expect(
      db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'alice'")?.n,
    ).toBe(2);
    server.close();
  });
});
