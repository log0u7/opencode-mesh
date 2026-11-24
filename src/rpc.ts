import { Rpc } from "@opencode/plugin/rpc";

import type { HostCapa } from "./lib/capa.js";

// The TUI sidebar reads one compact snapshot per tick over RPC. The pure helpers
// (snapshotFromMesh, the v4 sidebar formatters) are testable without a
// renderer; the definition itself carries the wire schema.

export type MailboxInfo = {
  name: string;
  role: string | null;
  pools: string[];
  /** Declared primary group (pool id), when the box declared one. */
  primary_pool?: string | null;
  age_s: number;
};

export type MeshSnapshot = {
  node_id: string;
  hostname: string;
  /** Host capabilities snapshot (60 s cache) when the setup side provided one. */
  capa?: HostCapa;
  /** Paired peers only: discovery alone never makes a peer sendable. */
  peers: Array<{ node_id: string; hostname: string; address?: string }>;
  active_locks: number;
  /** The session's hats: every mailbox bound to the asking session (empty when
   * unregistered). Each carries its own unread count. */
  hats: Array<{ name: string; role: string | null; unread: number }>;
  /** Every registered mailbox on this node, oldest first. */
  mailboxes: MailboxInfo[];
  /** pool id -> member mailbox names. */
  pools: Record<string, string[]>;
};

/** Structural input: the mesh context (identity, listPeers, listLocks) satisfies this. */
export type SnapshotInput = {
  identity: { node_id: string; hostname: string };
  capa?: HostCapa;
  peers: ReadonlyArray<{ node_id: string; hostname: string; paired: boolean }>;
  locks: ReadonlyArray<unknown>;
  server: string;
  hats: Array<{ name: string; role: string | null; unread: number }>;
  mailboxes: ReadonlyArray<MailboxInfo>;
  pools: Record<string, string[]>;
};

export function snapshotFromMesh(data: SnapshotInput): MeshSnapshot {
  return {
    node_id: data.identity.node_id,
    hostname: data.identity.hostname,
    ...(data.capa !== undefined ? { capa: data.capa } : {}),
    peers: data.peers
      .filter((p) => p.paired)
      .map((p) => ({ node_id: p.node_id, hostname: p.hostname })),
    active_locks: data.locks.length,
    hats: [...data.hats],
    mailboxes: [...data.mailboxes],
    pools: { ...data.pools },
  };
}

// Tone tiers of the quota-style sidebar grammar, mapped to the theme in
// tui.tsx: entity = text + bold, qualifier = text, value = textMuted, alert =
// the theme's attention color (warning/error, text when it exposes none).
export type SidebarTone = "entity" | "qualifier" | "value" | "alert";

export type SidebarSegment = { text: string; tone: SidebarTone };

/** Pool and peer groups cap at 6 rows before a "+N more" overflow line. */
const ROWS_PER_GROUP = 6;

/** Total unread across the session's hats. */
function totalUnread(s: MeshSnapshot): number {
  return s.hats.reduce((sum, h) => sum + h.unread, 0);
}

/** Per-pool unread: the snapshot only carries unread for the asking session's
 * own hats, so a pool scores the unread of the hats member of it (matched
 * through the mailbox list). Frozen design: pools sort by unread descending,
 * then alphabetically. */
function poolUnread(s: MeshSnapshot): Map<string, number> {
  const byName = new Map(s.mailboxes.map((m) => [m.name, m]));
  const scores = new Map<string, number>();
  for (const hat of s.hats) {
    if (hat.unread <= 0) continue;
    const box = byName.get(hat.name);
    if (!box) continue;
    for (const pool of box.pools) {
      scores.set(pool, (scores.get(pool) ?? 0) + hat.unread);
    }
  }
  return scores;
}

/** Manual pairings all carry the placeholder hostname "manual": label them by
 * short node id + address, which is what actually distinguishes them. */
export function peerLabel(peer: { node_id: string; hostname: string; address?: string }): string {
  const host = peer.hostname.length > 0 ? peer.hostname : peer.node_id;
  if (host !== "manual" && host !== peer.node_id) return host;
  const id = peer.node_id.slice(0, 8);
  return peer.address !== undefined ? `${id}@${peer.address}` : id;
}

/** Expanded sidebar (v4, quota-style): segment lines, tone per segment. Line 0
 * is the clickable bold header carrying the session's primary identity (the
 * first hat); extra hats render as muted "also" lines. No blank lines: an
 * inapplicable line is omitted entirely (unread at 0, no peers). Pools sort by
 * the session's unread in them (desc, then alpha) and cap at six rows; peers
 * come last, one per line, same cap. */
export function formatMeshSidebarExpanded(s: MeshSnapshot): SidebarSegment[][] {
  const primary = s.hats[0];
  const header: SidebarSegment[] = [{ text: "▼ Mesh", tone: "entity" }];
  if (primary) {
    header.push({ text: " — ", tone: "value" }, { text: primary.name, tone: "entity" });
    if (primary.role) header.push({ text: ` (${primary.role})`, tone: "value" });
  }
  const lines: SidebarSegment[][] = [header];
  for (const hat of s.hats.slice(1)) {
    lines.push([{ text: `  also ${hat.name}${hat.role ? ` (${hat.role})` : ""}`, tone: "value" }]);
  }
  const unread = totalUnread(s);
  if (unread > 0) {
    lines.push([
      { text: "  ● ", tone: "alert" },
      { text: `${unread} unread`, tone: "qualifier" },
    ]);
  } else if (s.hats.length === 0) {
    lines.push([{ text: "  no mailbox — mesh_register", tone: "value" }]);
  }
  const scores = poolUnread(s);
  const pools = Object.keys(s.pools)
    .map((pool) => ({
      pool,
      members: s.pools[pool]?.length ?? 0,
      unread: scores.get(pool) ?? 0,
    }))
    .filter((row) => row.members > 0)
    .sort((a, b) => b.unread - a.unread || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
  for (const row of pools.slice(0, ROWS_PER_GROUP)) {
    lines.push([
      { text: "  ☰ ", tone: "qualifier" },
      { text: row.pool, tone: "entity" },
      { text: ` (${row.members})`, tone: "value" },
    ]);
  }
  if (pools.length > ROWS_PER_GROUP) {
    lines.push([
      { text: "  ☰ … ", tone: "qualifier" },
      { text: `+${pools.length - ROWS_PER_GROUP} more`, tone: "value" },
    ]);
  }
  const hosts = 1 + s.peers.length;
  lines.push([
    { text: "  ⌂ ", tone: "qualifier" },
    { text: `${s.mailboxes.length}`, tone: "qualifier" },
    { text: " agents", tone: "value" },
    { text: " · ", tone: "value" },
    { text: `${Object.keys(s.pools).length}`, tone: "qualifier" },
    { text: " pools", tone: "value" },
    { text: " · ", tone: "value" },
    { text: `${hosts}`, tone: "qualifier" },
    { text: " hosts", tone: "value" },
  ]);
  for (const peer of s.peers.slice(0, ROWS_PER_GROUP)) {
    lines.push([
      { text: "  ⇄ ", tone: "qualifier" },
      { text: peerLabel(peer), tone: "qualifier" },
    ]);
  }
  if (s.peers.length > ROWS_PER_GROUP) {
    lines.push([
      { text: "  ⇄ … ", tone: "qualifier" },
      { text: `+${s.peers.length - ROWS_PER_GROUP} more`, tone: "value" },
    ]);
  }
  return lines;
}

/** Collapsed: ONE line, the four counters, same tone grammar. The unread
 * segment is omitted at 0 (like the expanded line). */
export function formatMeshSidebarCollapsed(s: MeshSnapshot): SidebarSegment[] {
  const line: SidebarSegment[] = [{ text: "▶ Mesh", tone: "entity" }];
  const unread = totalUnread(s);
  if (unread > 0) {
    line.push({ text: " ● ", tone: "alert" }, { text: `${unread} unread`, tone: "qualifier" });
  }
  const hosts = 1 + s.peers.length;
  const counts: Array<[number, string]> = [
    [s.mailboxes.length, "agents"],
    [Object.keys(s.pools).length, "pools"],
    [hosts, "hosts"],
  ];
  for (const [count, label] of counts) {
    line.push(
      { text: " · ", tone: "value" },
      { text: `${count}`, tone: "qualifier" },
      { text: ` ${label}`, tone: "value" },
    );
  }
  return line;
}

export const MeshRpc = Rpc.define({
  id: "mesh",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "The session asking (resolves its mailbox)" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "This node's id" },
          hostname: { type: "string", description: "This node's hostname" },
          capa: {
            type: "object",
            description: "Host capabilities snapshot (60 s cache)",
            properties: {
              cpu: {
                type: "object",
                properties: {
                  cores: { type: "number" },
                  loadAvg: { type: "number" },
                },
                required: ["cores", "loadAvg"],
                additionalProperties: false,
              },
              ram: {
                type: "object",
                properties: {
                  totalMb: { type: "number" },
                  usedMb: { type: "number" },
                },
                required: ["totalMb", "usedMb"],
                additionalProperties: false,
              },
              gpu: {
                type: "object",
                description: "Present only when nvidia-smi answers",
                properties: {
                  model: { type: "string" },
                  vramTotalMb: { type: "number" },
                  vramUsedMb: { type: "number" },
                },
                required: ["model", "vramTotalMb", "vramUsedMb"],
                additionalProperties: false,
              },
              workersInFlight: { type: "number" },
              sessionsRunning: { type: "number" },
            },
            required: ["cpu", "ram", "workersInFlight", "sessionsRunning"],
            additionalProperties: false,
          },
          peers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                node_id: { type: "string" },
                hostname: { type: "string" },
              },
              required: ["node_id", "hostname"],
              additionalProperties: false,
            },
            description: "Paired peers",
          },
          active_locks: { type: "number", description: "Active local file locks" },
          hats: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: ["string", "null"] },
                unread: { type: "number" },
              },
              required: ["name", "role", "unread"],
              additionalProperties: false,
            },
            description: "The asking session's mailboxes (multi-hat sessions own several)",
          },
          mailboxes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: ["string", "null"] },
                pools: { type: "array", items: { type: "string" } },
                primary_pool: {
                  type: ["string", "null"],
                  description: "Declared primary group (pool id)",
                },
                age_s: { type: "number" },
              },
              required: ["name", "role", "pools", "age_s"],
              additionalProperties: false,
            },
            description: "Registered mailboxes on this node",
          },
          pools: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
            description: "Pool id -> member mailbox names",
          },
        },
        required: ["node_id", "hostname", "peers", "active_locks", "hats", "mailboxes", "pools"],
        additionalProperties: false,
      },
    },
    // Bind: the TUI reports this instance's sessionID at mount, so the wake
    // loop works BEFORE any mesh tool call (a fresh idle session otherwise
    // never learns its sessionID and mail to its mailbox stays silent).
    bind: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "This TUI instance's session id" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          bound: { type: "boolean" },
        },
        required: ["bound"],
        additionalProperties: false,
      },
    },
    // Sidebar collapse state, persisted by the setup side through the raw
    // storage domain: the TUI-side storage.store() throws for scoped plugin
    // ids (anomalyco/opencode#62634).
    sidebar: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          collapsed: { type: "boolean", description: "Sidebar collapsed state" },
        },
        required: ["collapsed"],
        additionalProperties: false,
      },
    },
    set_sidebar: {
      input: {
        type: "object",
        properties: {
          collapsed: { type: "boolean", description: "Sidebar collapsed state" },
        },
        required: ["collapsed"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          collapsed: { type: "boolean", description: "Sidebar collapsed state" },
        },
        required: ["collapsed"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
