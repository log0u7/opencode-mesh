import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { pairWithToken, resolvePeerUrl, upsertDiscoveredPeer } from "../src/lib/peers.js";

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

describe("resolvePeerUrl", () => {
  it("accepts addresses that carry a port", () => {
    const db = pair(["10.0.0.2:4399"]);
    expect(resolvePeerUrl(db, "node-b")).toBe("http://10.0.0.2:4399");
    expect(resolvePeerUrl(db, "laptop")).toBe("http://10.0.0.2:4399");
    db.close();

    const v6 = pair(["[fe80::1]:4399"]);
    expect(resolvePeerUrl(v6, "node-b")).toBe("http://[fe80::1]:4399");
    v6.close();

    const named = pair(["laptop.local:4399"]);
    expect(resolvePeerUrl(named, "node-b")).toBe("http://laptop.local:4399");
    named.close();

    // A link-local IPv6 address carries a zone id (`%eth0`), which must not
    // disqualify an otherwise well-formed host:port.
    const zoned = pair(["[fe80::1%eth0]:4399"]);
    expect(resolvePeerUrl(zoned, "node-b")).toBe("http://[fe80::1%eth0]:4399");
    zoned.close();

    // IPv4-mapped IPv6 (dual-stack resolvers emit these) carries dots inside
    // the brackets; it must not be classified as portless.
    const mapped = pair(["[::ffff:192.168.1.10]:4399"]);
    expect(resolvePeerUrl(mapped, "node-b")).toBe("http://[::ffff:192.168.1.10]:4399");
    mapped.close();
  });

  it("refuses to invent a port for a portless address", () => {
    const db = pair(["10.0.0.2"]);
    expect(resolvePeerUrl(db, "node-b")).toBeNull();
    db.close();

    // Bracketed forms without a port, and an empty zone id, stay rejected so a
    // future relaxation cannot resurrect the portless-address path.
    for (const address of ["[::ffff:192.168.1.10]", "[fe80::1]", "[fe80::1%]:4399"]) {
      const bad = pair([address]);
      expect(resolvePeerUrl(bad, "node-b"), `address: ${address}`).toBeNull();
      bad.close();
    }
  });

  it("prefers the first routable address when a peer lists several", () => {
    const db = pair(["10.0.0.2", "10.0.0.3:4399"]);
    expect(resolvePeerUrl(db, "node-b")).toBe("http://10.0.0.3:4399");
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
    expect(resolvePeerUrl(discovered, "node-c")).toBeNull();
    expect(resolvePeerUrl(discovered, "nobody")).toBeNull();
    discovered.close();
  });
});
