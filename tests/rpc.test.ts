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
        { text: ": ", tone: "value" },
        { text: "purser", tone: "entity" },
      ],
      [{ text: "  also orchestrator", tone: "value" }],
      [
        { text: "  ●  ", tone: "alert" },
        { text: "3 unread", tone: "qualifier" },
      ],
      [
        { text: "  ≔  ", tone: "qualifier" },
        { text: "lead", tone: "value" },
      ],
      [
        { text: "  ≡  ", tone: "qualifier" },
        { text: "team:purser", tone: "entity" },
        { text: " (1)", tone: "value" },
      ],
      [
        { text: "  ⌂  ", tone: "qualifier" },
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
        { text: "  ⇄  ", tone: "qualifier" },
        { text: "desktop", tone: "qualifier" },
      ],
    ]);
  });

  it("lists ONLY the pools the asking session belongs to (purser is in one pool: one ≡ row, never other sessions' pools)", () => {
    const s = snapshot();
    s.hats = [{ name: "purser", role: "lead", unread: 0 }];
    s.pools = {
      "team:purser": ["purser"],
      "other:a": ["6admin"],
      "other:b": ["k8s-oci"],
      "other:c": ["theforeman"],
      "other:d": ["6admin", "k8s-oci"],
      "other:e": ["theforeman"],
      "other:f": ["6admin"],
    };
    const lines = formatMeshSidebarExpanded(s);
    const poolLines = lines.filter((l) => renderLine(l).startsWith("  ≡  "));
    expect(poolLines).toHaveLength(1);
    expect(renderLine(poolLines[0])).toBe("  ≡  team:purser (1)");
    expect(lines.some((l) => renderLine(l).includes("other:"))).toBe(false);
  });

  it("omits the unread line at 0, drops locks entirely, sorts my pools alpha then", () => {
    const s = snapshot();
    s.hats = s.hats.map((h) => ({ ...h, unread: 0 }));
    s.pools = {
      "team:zz": ["purser"],
      "team:aa": ["purser", "k8s-oci"],
      "team:foreman": ["theforeman"],
    };
    const lines = formatMeshSidebarExpanded(s);
    expect(lines).toHaveLength(7); // header + also + ≔ + 2 of my pools + counters + peer
    expect(renderLine(lines[0])).toBe("▼ Mesh: purser");
    expect(renderLine(lines[1])).toBe("  also orchestrator");
    expect(renderLine(lines[2])).toBe("  ≔  lead");
    expect(lines.some((l) => renderLine(l).includes("unread"))).toBe(false);
    expect(lines.some((l) => renderLine(l).includes("lock"))).toBe(false);
    expect(renderLine(lines[3])).toBe("  ≡  team:aa (2)");
    expect(renderLine(lines[4])).toBe("  ≡  team:zz (1)");
    expect(renderLine(lines[5])).toBe("  ⌂  4 agents · 3 pools · 2 hosts");
    expect(renderLine(lines[6])).toBe("  ⇄  desktop");
    expect(lines.some((l) => renderLine(l).includes("team:foreman"))).toBe(false);
  });

  it("sorts my pools by the session's unread in them, descending, then alpha", () => {
    const s = snapshot();
    // orchestrator joins team:infra (roster membership) and its mailbox scores
    // the pool's unread
    s.mailboxes.push({ name: "orchestrator", role: null, pools: ["team:infra"], age_s: 30 });
    s.pools["team:infra"] = ["6admin", "k8s-oci", "orchestrator"];
    const lines = formatMeshSidebarExpanded(s);
    // my pools: team:purser (purser's unread 2), team:infra (orchestrator's 1)
    expect(renderLine(lines[3])).toBe("  ≔  lead");
    expect(renderLine(lines[4])).toBe("  ≡  team:purser (1)");
    expect(renderLine(lines[5])).toBe("  ≡  team:infra (3)");
    expect(lines).toHaveLength(8); // header + also + unread + ≔ + 2 pools + counters + peer
    expect(lines.some((l) => renderLine(l).includes("team:foreman"))).toBe(false);
  });

  it("moves every hat role into ≔ lines: primary out of the header, extras out of the also line", () => {
    const s = snapshot();
    s.hats = [
      { name: "orchestrator", role: null, unread: 0 },
      { name: "blogger", role: "editor", unread: 0 },
    ];
    const lines = formatMeshSidebarExpanded(s);
    expect(renderLine(lines[0])).toBe("▼ Mesh: orchestrator");
    expect(renderLine(lines[1])).toBe("  also blogger");
    expect(renderLine(lines[2])).toBe("  ≔  editor");
  });

  it("renders one ≔ line per hat that declares a role, after unread and in enrollment order", () => {
    const s = snapshot();
    s.hats = [
      { name: "orchestrator", role: "housekeeper (upstream opencode)", unread: 2 },
      { name: "blogger", role: "editor", unread: 0 },
      { name: "purser", role: null, unread: 0 },
    ];
    const rendered = formatMeshSidebarExpanded(s).map(renderLine);
    const unreadAt = rendered.findIndex((l) => l.includes("unread"));
    const roleAt = rendered.findIndex((l) => l.startsWith("  ≔  "));
    expect(unreadAt).toBeGreaterThan(-1);
    expect(unreadAt).toBeLessThan(roleAt); // the role line comes after the unread line
    expect(rendered.filter((l) => l.startsWith("  ≔  "))).toEqual([
      "  ≔  housekeeper (upstream…",
      "  ≔  editor",
    ]);
  });

  it("truncates a long role at the last word boundary that fits the panel width, never mid-word", () => {
    const s = snapshot();
    s.hats = [{ name: "opencode", role: "housekeeper (upstream opencode)", unread: 0 }];
    const rendered = formatMeshSidebarExpanded(s).map(renderLine);
    const roleLine = rendered.find((l) => l.startsWith("  ≔  "));
    expect(roleLine).toBe("  ≔  housekeeper (upstream…"); // cut between two words + …
    expect(roleLine?.length).toBeLessThanOrEqual(32); // default panel width
  });

  it("leaves a short role whole and honors the width option", () => {
    const s = snapshot();
    s.hats = [{ name: "purser", role: "lead (produit purser)", unread: 0 }];
    expect(formatMeshSidebarExpanded(s).map(renderLine)).toContain("  ≔  lead (produit purser)");
    // width 14 → 9 chars of role after the ≔ mark: cuts at the last space
    expect(formatMeshSidebarExpanded(s, { width: 14 }).map(renderLine)).toContain("  ≔  lead…");
  });

  it("shows the register hint and no identity when the session has no hat", () => {
    const s = snapshot();
    s.hats = [];
    const lines = formatMeshSidebarExpanded(s);
    expect(renderLine(lines[0])).toBe("▼ Mesh");
    expect(renderLine(lines[1])).toBe("  no mailbox: mesh_register");
  });

  it("skips empty pools and caps my pools and peers at six rows plus an overflow line", () => {
    const s = snapshot();
    s.pools = {
      p1: ["purser"],
      p2: ["purser"],
      p3: ["purser"],
      p4: ["purser"],
      p5: ["purser"],
      p6: [],
      p7: ["purser"],
      p8: ["purser"],
    };
    const lines = formatMeshSidebarExpanded(s);
    const poolLines = lines.filter((l) => renderLine(l).startsWith("  ≡  "));
    expect(poolLines).toHaveLength(6); // rows only; the overflow line has no double space
    expect(renderLine(poolLines[5])).toBe("  ≡  p7 (1)");
    const overflow = lines.find((l) => renderLine(l).startsWith("  ≡ …"));
    expect(overflow).toEqual([
      { text: "  ≡ …  ", tone: "qualifier" },
      { text: "+1 more", tone: "value" },
    ]);
    expect(lines.some((l) => renderLine(l).includes("p6"))).toBe(false);
    s.peers = Array.from({ length: 7 }, (_, i) => ({ node_id: `n${i}`, hostname: `host${i}` }));
    const lines2 = formatMeshSidebarExpanded(s);
    const peerLines = lines2.filter((l) => renderLine(l).startsWith("  ⇄  "));
    expect(peerLines).toHaveLength(6);
    expect(renderLine(peerLines[5])).toBe("  ⇄  host5");
    expect(renderLine(lines2[lines2.length - 1])).toBe("  ⇄ …  +1 more");
  });

  it("swaps the glyphs for lowercase dim labels when icons=false", () => {
    const lines = formatMeshSidebarExpanded(snapshot(), { icons: false });
    const rendered = lines.map(renderLine).join("\n");
    expect(rendered).not.toContain("≡");
    expect(rendered).not.toContain("⌂");
    expect(rendered).not.toContain("⇄");
    expect(renderLine(lines[3])).toBe("  ≔  lead");
    expect(renderLine(lines[4])).toBe("  pools team:purser (1)");
    expect(renderLine(lines[5])).toBe("  fleet 4 agents · 3 pools · 2 hosts");
    expect(renderLine(lines[6])).toBe("  peers desktop");
    expect(lines[4]?.[0]).toEqual({ text: "  pools ", tone: "value" });
    expect(lines[5]?.[0]).toEqual({ text: "  fleet ", tone: "value" });
    expect(lines[6]?.[0]).toEqual({ text: "  peers ", tone: "value" });
  });

  it("icons=false overflow lines drop the ellipsis glyph too", () => {
    const s = snapshot();
    s.pools = {
      p1: ["purser"],
      p2: ["purser"],
      p3: ["purser"],
      p4: ["purser"],
      p5: ["purser"],
      p6: ["purser"],
      p7: ["purser"],
      p8: ["purser"],
    };
    const lines = formatMeshSidebarExpanded(s, { icons: false });
    const poolLines = lines.filter((l) => renderLine(l).startsWith("  pools "));
    expect(poolLines).toHaveLength(7); // 6 rows + overflow
    expect(renderLine(poolLines[6])).toBe("  pools +2 more");
    expect(lines.map(renderLine).join("\n")).not.toContain("…");
  });

  it("labels a manual peer by short node id", () => {
    const s = snapshot();
    s.peers = [{ node_id: "12345678abcdef90", hostname: "manual" }];
    const lines = formatMeshSidebarExpanded(s);
    expect(renderLine(lines[lines.length - 1])).toBe("  ⇄  12345678");
  });

  it("omits the peer rows entirely when no peer is paired", () => {
    const s = snapshot();
    s.peers = [];
    const lines = formatMeshSidebarExpanded(s);
    expect(lines).toHaveLength(6); // header + also + unread + ≔ + my pool + counters
    expect(lines.some((l) => renderLine(l).includes("⇄"))).toBe(false);
    expect(renderLine(lines[lines.length - 1])).toBe("  ⌂  4 agents · 3 pools · 1 host");
  });
});

describe("formatMeshSidebarCollapsed (v4)", () => {
  it("carries the toggle: ▶ collapsed, ▼ expanded (restored in 0.24.2)", () => {
    const quiet = snapshot();
    quiet.hats = quiet.hats.map((h) => ({ ...h, unread: 0 }));
    expect(formatMeshSidebarCollapsed(quiet)[0]).toEqual({ text: "▶ Mesh", tone: "entity" });
    expect(formatMeshSidebarCollapsed(snapshot())[0]).toEqual({ text: "▶ Mesh", tone: "entity" });
    expect(renderLine(formatMeshSidebarExpanded(snapshot())[0])).toMatch(/^▼ Mesh/);
  });

  it("renders the unified grammar with mail pending: ▶ Mesh ·N unread ·counters (no glyph in fold)", () => {
    expect(formatMeshSidebarCollapsed(snapshot())).toEqual([
      { text: "▶ Mesh", tone: "entity" },
      { text: " ·", tone: "value" },
      { text: "3", tone: "qualifier" },
      { text: " unread", tone: "value" },
      { text: " ·", tone: "value" },
      { text: "4", tone: "qualifier" },
      { text: " Agents", tone: "value" },
      { text: " ·", tone: "value" },
      { text: "3", tone: "qualifier" },
      { text: " Pools", tone: "value" },
      { text: " ·", tone: "value" },
      { text: "2", tone: "qualifier" },
      { text: " Hosts", tone: "value" },
    ]);
  });

  it("shows the full inventory when quiet: Mesh bold, counters capitalized-plural, hosts = self + paired peers", () => {
    const s = snapshot();
    s.peers = [];
    s.hats = s.hats.map((h) => ({ ...h, unread: 0 }));
    expect(formatMeshSidebarCollapsed(s)).toEqual([
      { text: "▶ Mesh", tone: "entity" },
      { text: " ·", tone: "value" },
      { text: "4", tone: "qualifier" },
      { text: " Agents", tone: "value" },
      { text: " ·", tone: "value" },
      { text: "3", tone: "qualifier" },
      { text: " Pools", tone: "value" },
      { text: " ·", tone: "value" },
      { text: "1", tone: "qualifier" },
      { text: " Host", tone: "value" },
    ]);
  });

  it("pluralizes the counters in the unified grammar (1 Agent · 1 Pool · 1 Host, 11 Agents)", () => {
    const s = snapshot();
    s.hats = s.hats.map((h) => ({ ...h, unread: 0 }));
    s.mailboxes = s.mailboxes.slice(0, 1);
    s.pools = { "team:purser": ["purser"] };
    s.peers = [];
    expect(renderLine(formatMeshSidebarCollapsed(s))).toBe("▶ Mesh ·1 Agent ·1 Pool ·1 Host");
    const counters = formatMeshSidebarExpanded(s).find((l) => renderLine(l).startsWith("  ⌂  "));
    expect(renderLine(counters)).toBe("  ⌂  1 agent · 1 pool · 1 host");
    const base = s.mailboxes[0];
    if (!base) throw new Error("fixture: no mailbox");
    s.mailboxes = Array.from({ length: 11 }, (_, i) => ({
      ...base,
      name: `mailbox-${i}`,
    }));
    expect(renderLine(formatMeshSidebarCollapsed(s))).toBe("▶ Mesh ·11 Agents ·1 Pool ·1 Host");
  });
});
