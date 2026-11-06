import { describe, expect, it } from "vitest";

import { formatMeshLines, snapshotFromMesh } from "../src/rpc.js";

describe("snapshotFromMesh", () => {
  it("keeps paired peers only and counts active locks", () => {
    const s = snapshotFromMesh({
      identity: { node_id: "n1", hostname: "laptop" },
      peers: [
        { node_id: "p1", hostname: "desktop", paired: true },
        { node_id: "p2", hostname: "phone", paired: false },
      ],
      locks: [{ path: "a", owner: "s1", node_id: "n1", expires_at: 1 }],
      server: "127.0.0.1:4399",
    });
    expect(s.node_id).toBe("n1");
    expect(s.peers).toEqual([{ node_id: "p1", hostname: "desktop" }]);
    expect(s.active_locks).toBe(1);
  });

  it("reports zero locks when every lock is expired", () => {
    const s = snapshotFromMesh({
      identity: { node_id: "n1", hostname: "laptop" },
      peers: [],
      locks: [],
      server: "127.0.0.1:4399",
    });
    expect(s.peers).toEqual([]);
    expect(s.active_locks).toBe(0);
  });
});

describe("formatMeshLines", () => {
  it("renders the node line, one line per peer, and the lock count", () => {
    const lines = formatMeshLines({
      node_id: "n1",
      hostname: "laptop",
      peers: [
        { node_id: "p1", hostname: "desktop" },
        { node_id: "p2", hostname: "phone" },
      ],
      active_locks: 2,
    });
    expect(lines).toEqual(["mesh: laptop", "↔ desktop", "↔ phone", "2 active lock(s)"]);
  });

  it("says alone when there is no peer and no lock", () => {
    const lines = formatMeshLines({
      node_id: "n1",
      hostname: "laptop",
      peers: [],
      active_locks: 0,
    });
    expect(lines).toEqual(["mesh: laptop", "no paired peers"]);
  });

  it("falls back to the node id when the hostname is missing", () => {
    const lines = formatMeshLines({
      node_id: "n1",
      hostname: "",
      peers: [{ node_id: "p1", hostname: "" }],
      active_locks: 0,
    });
    expect(lines[0]).toBe("mesh: n1");
    expect(lines[1]).toBe("↔ p1");
  });
});
