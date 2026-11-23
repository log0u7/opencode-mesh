import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, X509Certificate } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMeshDb, type MeshDb } from "../src/lib/db.js";
import { joinPool, registerMailbox, unreadMessages } from "../src/lib/mail.js";
import { loadOrCreateIdentity, pairingProof, type NodeIdentity } from "../src/lib/identity.js";
import {
  createPairingCode,
  findPeerById,
  pairWithToken,
  upsertDiscoveredPeer,
} from "../src/lib/peers.js";
import { buildOfferBlob, parseOfferBlob } from "../src/lib/offer-blob.js";
import { getPools, postPairCode, sendMail } from "../src/lib/client.js";
import { startMeshServer } from "../src/lib/serve.js";
import { buildTlsMaterial, certPkSpki, nodeTlsMaterial, type TlsMaterial } from "../src/lib/tls.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-tls-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function identityFor(name: string): NodeIdentity {
  return loadOrCreateIdentity(join(dir, name));
}

async function startTlsNode(name: string): Promise<{
  identity: NodeIdentity;
  material: TlsMaterial;
  db: MeshDb;
  server: Awaited<ReturnType<typeof startMeshServer>>["server"];
  port: number;
  url: string;
}> {
  const identity = identityFor(name);
  const material = buildTlsMaterial(identity);
  const db = openMeshDb(join(dir, name, "mesh.db"));
  const { server, port } = await startMeshServer({
    db,
    port: 0,
    tlsMaterial: material,
    self: { node_id: identity.node_id, pk: identity.public_key, hostname: identity.hostname },
  });
  return { identity, material, db, server, port, url: `https://127.0.0.1:${port}` };
}

describe("TLS material builder", () => {
  it("derives a valid self-signed certificate from the node identity", () => {
    const identity = identityFor("builder");
    const material = buildTlsMaterial(identity);

    const cert = new X509Certificate(material.certPem);
    expect(cert.subject).toContain(identity.hostname);
    expect(cert.issuer).toBe(cert.subject); // self-signed
    expect(cert.ca).toBe(true);
    // The cert presents the very key peers already pin (zero new trust).
    expect(certPkSpki(material.certPem)).toBe(identity.public_key);
    // Ed25519 self-signature verifies against the cert's own key.
    expect(cert.verify(cert.publicKey)).toBe(true);
    // One year of validity.
    const days = (cert.validToDate.getTime() - cert.validFromDate.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
  });

  it("caches the material per data dir", () => {
    const dataDir = join(dir, "cached");
    const first = nodeTlsMaterial(dataDir);
    const second = nodeTlsMaterial(dataDir);
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
    // Same identity → same certificate key.
    expect(certPkSpki(first.certPem)).toBe(loadOrCreateIdentity(dataDir).public_key);
  });
});

describe("TLS round-trip (two nodes)", () => {
  it("delivers mail end to end over the pinned TLS channel", async () => {
    const a = await startTlsNode("a");
    const b = identityFor("b");

    // A knows B, pinned to B's Ed25519 key.
    pairWithToken(a.db, {
      node_id: b.node_id,
      hostname: "node-b",
      fingerprint: "fb",
      token: "tok-b",
      public_key: b.public_key,
    });

    const result = await sendMail({
      url: a.url,
      tls: true,
      pk: certPkSpki(a.material.certPem),
      token: "tok-b",
      from: b.node_id,
      subject: "tls-handoff",
      body: "delivered over TLS",
      proof: pairingProof(b, "tok-b"),
    });
    expect(result).toBe("ok");

    const unread = unreadMessages(a.db);
    expect(unread.some((m) => m.subject === "tls-handoff" && m.from === b.node_id)).toBe(true);

    a.server.close();
    a.db.close();
  });

  it("rejects a certificate whose key does not match the pin, before any body", async () => {
    const a = await startTlsNode("a");
    const b = identityFor("b");
    pairWithToken(a.db, {
      node_id: b.node_id,
      hostname: "node-b",
      fingerprint: "fb",
      token: "tok-b",
      public_key: b.public_key,
    });

    // A rogue key pair: its SPKI is a valid pin that the peer's cert fails.
    const rogue = generateKeyPairSync("ed25519");
    const rogueSpki = Buffer.from(rogue.publicKey.export({ type: "spki", format: "der" })).toString(
      "base64",
    );

    const result = await sendMail({
      url: a.url,
      tls: true,
      pk: rogueSpki,
      token: "tok-b",
      from: b.node_id,
      subject: "evil",
      body: "x",
      proof: pairingProof(b, "tok-b"),
    });
    expect(result).toBe("unreachable");
    // The handshake died before any mail reached the server.
    expect(unreadMessages(a.db)).toHaveLength(0);

    a.server.close();
    a.db.close();
  });

  it("serves /pools over TLS with the pinned key", async () => {
    const a = await startTlsNode("a");
    pairWithToken(a.db, {
      node_id: "peer-x",
      hostname: "x",
      fingerprint: "fx",
      token: "tok-x",
    });
    registerMailbox(a.db, { name: "ops", session_id: "s1", now: Date.now() });
    joinPool(a.db, "ops", "team:x");

    const pools = await getPools({
      url: a.url,
      tls: true,
      pk: certPkSpki(a.material.certPem),
      token: "tok-x",
    });
    expect(pools?.pools["team:x"]).toContain("ops");

    a.server.close();
    a.db.close();
  });
});

describe("code pairing over TLS (TOFU pin)", () => {
  it("accepts the first contact unpinned and returns the peer's cert key", async () => {
    const a = await startTlsNode("a");
    const b = identityFor("b");
    const dbB = openMeshDb(join(dir, "b", "mesh.db"));

    const pairing = createPairingCode(a.db, a.identity.hostname);
    const offer = buildOfferBlob(dbB, {
      node_id: b.node_id,
      pk: b.public_key,
      hostname: b.hostname,
      address: `127.0.0.1:${a.port}`,
    });

    const result = await postPairCode({
      url: a.url,
      tls: true,
      code: pairing.code,
      offer,
    });
    expect(result).not.toBeNull();

    const counter = parseOfferBlob(result!.counter_offer);
    expect(counter?.pk).toBe(a.identity.public_key);
    // TOFU: the presented cert key IS the node key the counter-offer attests.
    expect(result!.peer_pk).toBe(a.identity.public_key);
    // A paired B on its side, TLS-flagged.
    const peerA = findPeerById(a.db, b.node_id);
    expect(peerA?.paired).toBe(true);
    expect(peerA?.tls).toBe(true);

    a.server.close();
    a.db.close();
    dbB.close();
  });
});

describe("server TLS options", () => {
  it("requires TLS material unless TLS is explicitly disabled", async () => {
    const db = openMeshDb(":memory:");
    await expect(startMeshServer({ db, port: 0 })).rejects.toThrow(/tlsMaterial/);
    db.close();
  });

  it("opens the documented plain-HTTP side channel on port+1 when asked", async () => {
    const db = openMeshDb(":memory:");
    const material = buildTlsMaterial(identityFor("side"));
    const { server, insecureServer, insecurePort } = await startMeshServer({
      db,
      port: 0,
      tlsMaterial: material,
      insecureHttp: true,
    });

    const response = await fetch(`http://127.0.0.1:${insecurePort}/mail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "n1", subject: "x", body: "y" }),
    });
    expect(response.status).toBe(401);

    insecureServer?.close();
    server.close();
    db.close();
  });

  it("keeps a discovered legacy peer non-TLS and a paired one TLS", () => {
    const db = openMeshDb(":memory:");
    upsertDiscoveredPeer(db, {
      node_id: "legacy",
      hostname: "old",
      fingerprint: "f0",
      addresses: ["10.0.0.5:4399"],
    });
    expect(findPeerById(db, "legacy")?.tls).toBe(false);
    // A new pairing flips the peer to TLS regardless of its discovery state.
    pairWithToken(db, {
      node_id: "legacy",
      hostname: "old",
      fingerprint: "f0",
      token: "tok",
      addresses: ["10.0.0.5:4399"],
    });
    expect(findPeerById(db, "legacy")?.tls).toBe(true);
    db.close();
  });
});
