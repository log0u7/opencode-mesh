import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { pairWithToken, resolvePeerTarget, upsertDiscoveredPeer } from "../src/lib/peers.js";

function pair(addresses: string[]) {
  const db = openMeshDb(":memory:");
  upsertDiscoveredPeer(db, {
    node_id: "node-b",
    hostname: "laptop",
    fingerprint: "fb",
    addresses,
  });
  pairWithToken(db, {
    node_id: "node-b",
    hostname: "laptop",
    fingerprint: "fb",
    token: "tok",
    addresses,
  });
  return db;
}

// Pairings are TLS (0.11+): the scheme follows the peer's tls flag.
describe("resolvePeerTarget", () => {
  it("accepts addresses that carry a port", () => {
    const db = pair(["10.0.0.2:4399"]);
    expect(resolvePeerTarget(db, "node-b")).toEqual({
      url: "https://10.0.0.2:4399",
      tls: true,
      pk: null,
    });
    expect(resolvePeerTarget(db, "laptop")).toEqual({
      url: "https://10.0.0.2:4399",
      tls: true,
      pk: null,
    });
    db.close();

    const v6 = pair(["[fe80::1]:4399"]);
    expect(resolvePeerTarget(v6, "node-b")).toEqual({
      url: "https://[fe80::1]:4399",
      tls: true,
      pk: null,
    });
    v6.close();

    const named = pair(["laptop.local:4399"]);
    expect(resolvePeerTarget(named, "node-b")).toEqual({
      url: "https://laptop.local:4399",
      tls: true,
      pk: null,
    });
    named.close();

    // A link-local IPv6 address carries a zone id (`%eth0`), which must not
    // disqualify an otherwise well-formed host:port.
    const zoned = pair(["[fe80::1%eth0]:4399"]);
    expect(resolvePeerTarget(zoned, "node-b")).toEqual({
      url: "https://[fe80::1%eth0]:4399",
      tls: true,
      pk: null,
    });
    zoned.close();

    // IPv4-mapped IPv6 (dual-stack resolvers emit these) carries dots inside
    // the brackets; it must not be classified as portless.
    const mapped = pair(["[::ffff:192.168.1.10]:4399"]);
    expect(resolvePeerTarget(mapped, "node-b")).toEqual({
      url: "https://[::ffff:192.168.1.10]:4399",
      tls: true,
      pk: null,
    });
    mapped.close();
  });

  it("pins the pairing key over TLS when the peer has one", () => {
    const db = openMeshDb(":memory:");
    pairWithToken(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      token: "tok",
      addresses: ["10.0.0.2:4399"],
      public_key: "PKDATA",
    });
    expect(resolvePeerTarget(db, "node-b")).toEqual({
      url: "https://10.0.0.2:4399",
      tls: true,
      pk: "PKDATA",
    });
    db.close();
  });

  it("refuses to invent a port for a portless address", () => {
    const db = pair(["10.0.0.2"]);
    expect(resolvePeerTarget(db, "node-b")).toBeNull();
    db.close();

    // Bracketed forms without a port, and an empty zone id, stay rejected so a
    // future relaxation cannot resurrect the portless-address path.
    for (const address of ["[::ffff:192.168.1.10]", "[fe80::1]", "[fe80::1%]:4399"]) {
      const bad = pair([address]);
      expect(resolvePeerTarget(bad, "node-b"), `address: ${address}`).toBeNull();
      bad.close();
    }
  });

  it("prefers the first routable address when a peer lists several", () => {
    const db = pair(["10.0.0.2", "10.0.0.3:4399"]);
    expect(resolvePeerTarget(db, "node-b")).toEqual({
      url: "https://10.0.0.3:4399",
      tls: true,
      pk: null,
    });
    db.close();
  });

  it("returns null for an unknown or unpaired peer", () => {
    const discovered = openMeshDb(":memory:");
    upsertDiscoveredPeer(discovered, {
      node_id: "node-c",
      hostname: "c",
      fingerprint: "fc",
      addresses: ["10.0.0.9:4399"],
    });
    // Discovered is not paired: not sendable yet.
    expect(resolvePeerTarget(discovered, "node-c")).toBeNull();
    expect(resolvePeerTarget(discovered, "nobody")).toBeNull();
    discovered.close();
  });
});
