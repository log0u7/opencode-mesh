import { describe, expect, it } from "vitest";

import {
  MeshRpc,
  formatMeshPoolsDialog,
  formatMeshPeersDialog,
  formatMeshStatusDialog,
  type MeshSnapshot,
  type SidebarSegment,
} from "../src/rpc.js";

function snapshot(overrides: Partial<MeshSnapshot> = {}): MeshSnapshot {
  return {
    node_id: "a1b2c3d4e5f6",
    hostname: "aconitum",
    peers: [{ node_id: "e5f6a7b8c9d0", hostname: "ricinus" }],
    active_locks: 1,
    hats: [{ name: "orq", role: "routing, arbitrage", unread: 3 }],
    mailboxes: [
      { name: "orq", role: "routing, arbitrage", pools: ["team:opencode"], age_s: 10 },
      { name: "sysops-aconitum", role: null, pools: ["team:infra"], age_s: 20 },
    ],
    pools: {
      "team:opencode": ["orq", "opencode-plugins"],
      "team:infra": ["sysops-aconitum", "6admin", "sysops-ricinus"],
      "team:web": ["blogger", "webmaster"],
    },
    ...overrides,
  };
}

function render(line: SidebarSegment[]): string {
  return line.map((seg) => seg.text).join("");
}

describe("formatMeshStatusDialog", () => {
  it("renders node, identity, unread, my pools, fleet, peers, locks and host sections", () => {
    const lines = formatMeshStatusDialog(snapshot(), { width: 40 }).map(render);
    expect(lines[0]).toBe("Node aconitum · a1b2c3d4");
    expect(lines[1]).toBe("Identity orq");
    expect(lines[2]).toBe("  ≔  routing, arbitrage");
    expect(lines[3]).toContain("3 unread");
    expect(lines.some((l) => l.includes("team:opencode") && l.includes("(2)"))).toBe(true);
    expect(lines.some((l) => l.includes("team:infra"))).toBe(false); // not my pool
    expect(lines.some((l) => l.startsWith("Fleet") && l.includes("2 agents"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Peers") && l.includes("ricinus"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Locks") && l.includes("1"))).toBe(true);
  });

  it("labels an unregistered session and quiet unread", () => {
    const lines = formatMeshStatusDialog(snapshot({ hats: [] }), { width: 40 }).map(render);
    expect(lines.some((l) => l.includes("not registered"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Unread"))).toBe(false);
  });

  it("renders none for empty peers and locks at 0", () => {
    const lines = formatMeshStatusDialog(snapshot({ peers: [], active_locks: 0 }), {
      width: 40,
    }).map(render);
    expect(lines.some((l) => l.startsWith("Peers") && l.includes("none"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Locks") && l.includes("0"))).toBe(true);
  });

  it("truncates a long role at the word boundary within the width budget", () => {
    const lines = formatMeshStatusDialog(
      snapshot({
        hats: [{ name: "orq", role: "routing, arbitrage, reporting to the PO weekly", unread: 0 }],
      }),
      { width: 40 },
    ).map(render);
    const role = lines.find((l) => l.trimStart().startsWith("≔"));
    expect(role?.length).toBeLessThanOrEqual(40);
    expect(role?.trimEnd()).toMatch(/…$/);
  });

  it("renders the host section from capa when provided", () => {
    const lines = formatMeshStatusDialog(
      snapshot({
        capa: {
          cpu: { cores: 16, loadAvg: 0.5 },
          ram: { totalMb: 65536, usedMb: 8192 },
          workersInFlight: 0,
          sessionsRunning: 1,
        },
      }),
      { width: 40 },
    ).map(render);
    const host = lines.find((l) => l.startsWith("Host"));
    expect(host).toContain("16 cores");
    expect(host).toContain("64 GB");
  });
});

describe("formatMeshPoolsDialog and formatMeshPeersDialog", () => {
  it("lists my pools with member counts and unread", () => {
    const lines = formatMeshPoolsDialog(snapshot()).map(render);
    expect(lines.some((l) => l.includes("team:opencode") && l.includes("(2)"))).toBe(true);
    expect(lines.some((l) => l.includes("team:web"))).toBe(false); // not mine
  });

  it("lists peers as hostname@id, none when empty", () => {
    expect(formatMeshPeersDialog(snapshot()).map(render)[0]).toContain("ricinus");
    expect(
      formatMeshPeersDialog(snapshot({ peers: [] }))
        .map(render)
        .join(""),
    ).toContain("none");
  });
});

describe("MeshRpc board and inbox wire schema", () => {
  it("declares board (pool?) -> rows", () => {
    const board = MeshRpc.methods.board;
    expect(board).toBeDefined();
    expect(board.output.properties.rows).toBeDefined();
  });

  it("declares inbox (box?) -> rows with from, subject, age", () => {
    const inbox = MeshRpc.methods.inbox;
    expect(inbox).toBeDefined();
    expect(inbox.output.properties.rows).toBeDefined();
    expect(inbox.output.properties.total).toBeDefined();
  });
});
