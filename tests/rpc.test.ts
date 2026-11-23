import { describe, expect, it } from "vitest";

import {
  formatAge,
  formatMeshLines,
  formatMeshSidebar,
  presenceMark,
  snapshotFromMesh,
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
      { name: "purser", role: "lead", pools: ["team:purser"], age_s: 5 },
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
    expect(s.pools["team:infra"]).toEqual(["6admin", "k8s-oci"]);
  });
});

describe("presence", () => {
  it("marks fresh, warm and stale mailboxes", () => {
    expect(presenceMark(0)).toBe("●");
    expect(presenceMark(120)).toBe("●");
    expect(presenceMark(121)).toBe("○");
    expect(presenceMark(900)).toBe("○");
    expect(presenceMark(901)).toBe("");
  });

  it("formats ages in seconds then minutes", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(59)).toBe("59s");
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(540)).toBe("9m");
  });
});

describe("formatMeshLines", () => {
  it("leads with the hats line (total unread, per-hat counters), then pools, peers and locks", () => {
    const lines = formatMeshLines(snapshot());
    expect(lines[0]).toBe("hats: ● 3 unread — purser (lead) ● 2 · orchestrator ● 1");
    expect(lines).toContain("team:infra: ● 6admin 1m · ○ k8s-oci 9m");
    expect(lines).toContain("team:purser: ● purser 5s");
    expect(lines).toContain("↔ desktop");
    expect(lines).toContain("1 active lock(s)");
  });

  it("omits the unread prefix and per-hat counters when nothing is unread", () => {
    const s = snapshot();
    s.hats = s.hats.map((h) => ({ ...h, unread: 0 }));
    const lines = formatMeshLines(s);
    expect(lines[0]).toBe("hats: purser (lead) · orchestrator");
  });

  it("shows the unregistered state when the session has no hat", () => {
    const s = snapshot();
    s.hats = [];
    const lines = formatMeshLines(s);
    expect(lines[0]).toBe("no mailbox — mesh_register");
  });

  it("caps pool member lists at four plus a counter", () => {
    const s = snapshot();
    s.pools["team:big"] = ["a", "b", "c", "d", "e", "f"];
    s.mailboxes.push(
      { name: "a", role: null, pools: [], age_s: 10 },
      { name: "b", role: null, pools: [], age_s: 10 },
      { name: "c", role: null, pools: [], age_s: 10 },
      { name: "d", role: null, pools: [], age_s: 10 },
      { name: "e", role: null, pools: [], age_s: 10 },
      { name: "f", role: null, pools: [], age_s: 10 },
    );
    const line = formatMeshLines(s).find((l) => l.startsWith("team:big"));
    expect(line).toBe("team:big: ● a 10s · ● b 10s · ● c 10s · ● d 10s · +2");
  });
});

describe("formatMeshSidebar", () => {
  it("expands to the full lines", () => {
    const lines = formatMeshSidebar(snapshot(), false);
    expect(lines[0]).toBe("hats: ● 3 unread — purser (lead) ● 2 · orchestrator ● 1");
  });

  it("collapses to one summary line led by unread, ending with the host count", () => {
    expect(formatMeshSidebar(snapshot(), true)).toEqual([
      "3 unread · 4 agents · 3 pools · 2 hôtes",
    ]);
  });

  it("counts hosts as self plus paired peers only", () => {
    const s = snapshot();
    s.peers = [];
    expect(formatMeshSidebar(s, true)).toEqual(["3 unread · 4 agents · 3 pools · 1 hôte"]);
  });

  it("collapsed without unread shows agents, pools and hosts only", () => {
    const s = snapshot();
    s.hats = s.hats.map((h) => ({ ...h, unread: 0 }));
    expect(formatMeshSidebar(s, true)).toEqual(["4 agents · 3 pools · 2 hôtes"]);
  });
});
