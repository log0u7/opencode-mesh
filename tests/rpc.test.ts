import { describe, expect, it } from "vitest";

import {
  formatMeshSidebarCollapsed,
  formatMeshSidebarExpanded,
  snapshotFromMesh,
  type SidebarSegment,
} from "../src/rpc.js";

function snapshot() {
  return snapshotFromMesh({
    identity: { node_id: "n1", hostname: "laptop" },
    peers: [
      { node_id: "p1", hostname: "desktop", paired: true },
      { node_id: "p2", hostname: "phone", paired: false },
    ],
    locks: [{ path: "a", owner: "s1", node_id: "n1", expires_at: 1 }],
    server: "127.0.0.1:4399",
    hats: [
      { name: "purser", role: "lead", unread: 2 },
      { name: "orchestrator", role: null, unread: 1 },
    ],
    mailboxes: [
      {
        name: "purser",
        role: "lead",
        pools: ["team:purser"],
        age_s: 5,
        primary_pool: "team:purser",
      },
      { name: "6admin", role: "lead", pools: ["team:infra", "team:quartermaster"], age_s: 100 },
      { name: "k8s-oci", role: "pair", pools: ["team:infra"], age_s: 540 },
      { name: "theforeman", role: "lead", pools: ["team:foreman"], age_s: 3600 },
    ],
    pools: {
      "team:infra": ["6admin", "k8s-oci"],
      "team:purser": ["purser"],
      "team:foreman": ["theforeman"],
    },
  });
}

/** The rendered text of one segment line, for readable assertions. */
function renderLine(line: SidebarSegment[] | undefined): string {
  return (line ?? []).map((seg) => seg.text).join("");
}

describe("snapshotFromMesh capa", () => {
  it("passes the host capabilities through and omits them when absent", () => {
    const base = {
      identity: { node_id: "n1", hostname: "h" },
      peers: [],
      locks: [],
      server: "127.0.0.1:4399",
      hats: [],
      mailboxes: [],
      pools: {},
    };
    const withCapa = snapshotFromMesh({
      ...base,
      capa: {
        cpu: { cores: 4, loadAvg: 0 },
        ram: { totalMb: 16000, usedMb: 0 },
        workersInFlight: 0,
        sessionsRunning: 0,
      },
    });
    expect(withCapa.capa?.cpu.cores).toBe(4);
    expect("capa" in snapshotFromMesh(base)).toBe(false);
  });
});

describe("snapshotFromMesh", () => {
  it("keeps paired peers only, counts locks, passes org data through", () => {
    const s = snapshot();
    expect(s.node_id).toBe("n1");
    expect(s.peers).toEqual([{ node_id: "p1", hostname: "desktop" }]);
    expect(s.active_locks).toBe(1);
    expect(s.hats).toEqual([
      { name: "purser", role: "lead", unread: 2 },
      { name: "orchestrator", role: null, unread: 1 },
    ]);
    expect(s.mailboxes).toHaveLength(4);
    expect(s.mailboxes[0]?.primary_pool).toBe("team:purser");
    expect(s.pools["team:infra"]).toEqual(["6admin", "k8s-oci"]);
  });
});

describe("formatMeshSidebarExpanded (v4)", () => {
  it("pins header identity, also line, unread, pools, counters and peers with tone tiers", () => {
    const lines = formatMeshSidebarExpanded(snapshot());
    expect(lines).toEqual([
      [
        { text: "▼ Mesh", tone: "entity" },
        { text: " — ", tone: "value" },
        { text: "purser", tone: "entity" },
        { text: " (lead)", tone: "value" },
      ],
      [{ text: "  also orchestrator", tone: "value" }],
      [
        { text: "  ● ", tone: "alert" },
        { text: "3 unread", tone: "qualifier" },
      ],
      [
        { text: "  ☰ ", tone: "qualifier" },
        { text: "team:purser", tone: "entity" },
        { text: " (1)", tone: "value" },
      ],
      [
        { text: "  ☰ ", tone: "qualifier" },
        { text: "team:foreman", tone: "entity" },
        { text: " (1)", tone: "value" },
      ],
      [
        { text: "  ☰ ", tone: "qualifier" },
        { text: "team:infra", tone: "entity" },
        { text: " (2)", tone: "value" },
      ],
      [
        { text: "  ⌂ ", tone: "qualifier" },
        { text: "4", tone: "qualifier" },
        { text: " agents", tone: "value" },
        { text: " · ", tone: "value" },
        { text: "3", tone: "qualifier" },
        { text: " pools", tone: "value" },
        { text: " · ", tone: "value" },
        { text: "2", tone: "qualifier" },
        { text: " hosts", tone: "value" },
      ],
      [
        { text: "  ⇄ ", tone: "qualifier" },
        { text: "desktop", tone: "qualifier" },
      ],
    ]);
  });

  it("omits the unread line at 0, drops locks entirely, sorts pools alpha then", () => {
    const s = snapshot();
    s.hats = s.hats.map((h) => ({ ...h, unread: 0 }));
    const lines = formatMeshSidebarExpanded(s);
    expect(lines).toHaveLength(7); // header + also + 3 pools + counters + peer
    expect(renderLine(lines[0])).toBe("▼ Mesh — purser (lead)");
    expect(renderLine(lines[1])).toBe("  also orchestrator");
    expect(lines.some((l) => renderLine(l).includes("unread"))).toBe(false);
    expect(lines.some((l) => renderLine(l).includes("lock"))).toBe(false);
    expect(renderLine(lines[2])).toBe("  ☰ team:foreman (1)");
    expect(renderLine(lines[3])).toBe("  ☰ team:infra (2)");
    expect(renderLine(lines[4])).toBe("  ☰ team:purser (1)");
    expect(renderLine(lines[5])).toBe("  ⌂ 4 agents · 3 pools · 2 hosts");
    expect(renderLine(lines[6])).toBe("  ⇄ desktop");
  });

  it("sorts pools by the session's unread in them, descending, then alpha", () => {
    const s = snapshot();
    // orchestrator's unread must attribute to its pools once the mailbox exists
    s.mailboxes.push({ name: "orchestrator", role: null, pools: ["team:infra"], age_s: 30 });
    const lines = formatMeshSidebarExpanded(s);
    // purser 2 (team:purser), orchestrator 1 (team:infra), team:foreman 0
    expect(renderLine(lines[3])).toBe("  ☰ team:purser (1)");
    expect(renderLine(lines[4])).toBe("  ☰ team:infra (2)");
    expect(renderLine(lines[5])).toBe("  ☰ team:foreman (1)");
  });

  it("renders the primary identity without a role and extra hats with theirs", () => {
    const s = snapshot();
    s.hats = [
      { name: "orchestrator", role: null, unread: 0 },
      { name: "blogger", role: "editor", unread: 0 },
    ];
    const lines = formatMeshSidebarExpanded(s);
    expect(renderLine(lines[0])).toBe("▼ Mesh — orchestrator");
    expect(renderLine(lines[1])).toBe("  also blogger (editor)");
  });

  it("shows the register hint and no identity when the session has no hat", () => {
    const s = snapshot();
    s.hats = [];
    const lines = formatMeshSidebarExpanded(s);
    expect(renderLine(lines[0])).toBe("▼ Mesh");
    expect(renderLine(lines[1])).toBe("  no mailbox — mesh_register");
  });

  it("skips empty pools and caps pools and peers at six rows plus an overflow line", () => {
    const s = snapshot();
    s.hats = [];
    s.pools = {
      p1: ["a"],
      p2: ["a"],
      p3: ["a"],
      p4: ["a"],
      p5: ["a"],
      p6: [],
      p7: ["a"],
      p8: ["a"],
    };
    const lines = formatMeshSidebarExpanded(s);
    const poolLines = lines.filter((l) => renderLine(l).startsWith("  ☰ "));
    expect(poolLines).toHaveLength(7); // 6 rows + overflow
    expect(renderLine(poolLines[5])).toBe("  ☰ p7 (1)");
    expect(poolLines[6]).toEqual([
      { text: "  ☰ … ", tone: "qualifier" },
      { text: "+1 more", tone: "value" },
    ]);
    expect(poolLines.some((l) => renderLine(l).includes("p6"))).toBe(false);
    s.peers = Array.from({ length: 7 }, (_, i) => ({ node_id: `n${i}`, hostname: `host${i}` }));
    const lines2 = formatMeshSidebarExpanded(s);
    const peerLines = lines2.filter((l) => renderLine(l).startsWith("  ⇄ "));
    expect(peerLines).toHaveLength(7);
    expect(renderLine(peerLines[5])).toBe("  ⇄ host5");
    expect(renderLine(peerLines[6])).toBe("  ⇄ … +1 more");
  });

  it("labels a manual peer by short node id", () => {
    const s = snapshot();
    s.peers = [{ node_id: "12345678abcdef90", hostname: "manual" }];
    const lines = formatMeshSidebarExpanded(s);
    expect(renderLine(lines[lines.length - 1])).toBe("  ⇄ 12345678");
  });

  it("omits the peer rows entirely when no peer is paired", () => {
    const s = snapshot();
    s.peers = [];
    const lines = formatMeshSidebarExpanded(s);
    expect(lines).toHaveLength(7); // header + also + unread + 3 pools + counters
    expect(lines.some((l) => renderLine(l).includes("⇄"))).toBe(false);
    expect(renderLine(lines[lines.length - 1])).toBe("  ⌂ 4 agents · 3 pools · 1 hosts");
  });
});

describe("formatMeshSidebarCollapsed (v4)", () => {
  it("renders one line with the four counters in the tone grammar", () => {
    expect(formatMeshSidebarCollapsed(snapshot())).toEqual([
      { text: "▶ Mesh", tone: "entity" },
      { text: " ● ", tone: "alert" },
      { text: "3 unread", tone: "qualifier" },
      { text: " · ", tone: "value" },
      { text: "4", tone: "qualifier" },
      { text: " agents", tone: "value" },
      { text: " · ", tone: "value" },
      { text: "3", tone: "qualifier" },
      { text: " pools", tone: "value" },
      { text: " · ", tone: "value" },
      { text: "2", tone: "qualifier" },
      { text: " hosts", tone: "value" },
    ]);
  });

  it("counts hosts as self plus paired peers only, and drops the unread segment at 0", () => {
    const s = snapshot();
    s.peers = [];
    s.hats = s.hats.map((h) => ({ ...h, unread: 0 }));
    expect(formatMeshSidebarCollapsed(s)).toEqual([
      { text: "▶ Mesh", tone: "entity" },
      { text: " · ", tone: "value" },
      { text: "4", tone: "qualifier" },
      { text: " agents", tone: "value" },
      { text: " · ", tone: "value" },
      { text: "3", tone: "qualifier" },
      { text: " pools", tone: "value" },
      { text: " · ", tone: "value" },
      { text: "1", tone: "qualifier" },
      { text: " hosts", tone: "value" },
    ]);
  });
});
