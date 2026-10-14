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
  });

  it("refuses to invent a port for a portless address", () => {
    const db = pair(["10.0.0.2"]);
    expect(resolvePeerUrl(db, "node-b")).toBeNull();
    db.close();
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
