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

/** Role lines truncate at the last word boundary that fits the budget (panel
 * width minus the ≔ mark): never mid-word — the 0.23.4 complaint. A single
 * word longer than the whole budget has no boundary to cut at: hard cut, the
 * ellipsis riding INSIDE the budget (a cut at the full budget renders
 * budget+1 chars and clips the marker itself). */
function truncateAtWord(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, Math.max(0, budget - 1));
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut) + "…";
}

/** Count labels pluralize like the memory panel's pattern: `1 agent`,
 * `11 agents`. */
function plural(kind: string, count: number): string {
  return count === 1 ? kind : `${kind}s`;
}

/** Expanded sidebar (v4, quota-style): segment lines, tone per segment. Line 0
 * is the clickable bold header carrying the session's primary identity (the
 * first hat, name only); extra hats render as muted "also" lines. Each hat
 * that declares a role gets its own `≔ <role>` line (0.23.4), placed after
 * the unread line and before the pools, truncated at the last word boundary
 * that fits the panel width (`width`, default 32), never mid-word; the
 * full role lives in mesh_status. No blank lines: an
 * inapplicable line is omitted entirely (unread at 0, no peers). Only the
 * pools the asking session belongs to are listed (a pool qualifies when at
 * least one of the session's hats is one of its members), sorted by the
 * session's unread in them (desc, then alpha) and capped at six rows; peers
 * come last, one per line, same cap. `icons: false` swaps the ambiguous-width
 * glyphs (≡ ⌂ ⇄) for lowercase dim labels (pools, fleet, peers): the fallback
 * for terminals that draw those glyphs double-cell and glue the next
 * character. Glyph segments carry TWO trailing spaces: the first absorbs the
 * extra cell when the terminal draws the glyph wide, the second stays as the
 * visible gap. */
export function formatMeshSidebarExpanded(
  s: MeshSnapshot,
  opts?: { icons?: boolean; width?: number },
): SidebarSegment[][] {
  const icons = opts?.icons !== false;
  // Panel width for the role-line truncation: the sidebar column the TUI draws
  // in; the formatter can't measure it, so the caller passes it (default 32).
  const width = opts?.width ?? 32;
  const poolMark: SidebarSegment = icons
    ? { text: "  ≡  ", tone: "qualifier" }
    : { text: "  pools ", tone: "value" };
  const poolOverflowMark: SidebarSegment = icons
    ? { text: "  ≡ …  ", tone: "qualifier" }
    : { text: "  pools ", tone: "value" };
  const fleetMark: SidebarSegment = icons
    ? { text: "  ⌂  ", tone: "qualifier" }
    : { text: "  fleet ", tone: "value" };
  const peerMark: SidebarSegment = icons
    ? { text: "  ⇄  ", tone: "qualifier" }
    : { text: "  peers ", tone: "value" };
  const peerOverflowMark: SidebarSegment = icons
    ? { text: "  ⇄ …  ", tone: "qualifier" }
    : { text: "  peers ", tone: "value" };
  // The ≔ role mark rides the proven ≡ block (narrow math glyph, two trailing
  // spaces, the first absorbing a wide-cell draw); no icons:false label swap.
  const roleMark: SidebarSegment = { text: "  ≔  ", tone: "qualifier" };
  const primary = s.hats[0];
  const header: SidebarSegment[] = [{ text: "▼ Mesh", tone: "entity" }];
  if (primary) {
    header.push({ text: ": ", tone: "value" }, { text: primary.name, tone: "entity" });
  }
  const lines: SidebarSegment[][] = [header];
  for (const hat of s.hats.slice(1)) {
    lines.push([{ text: `  also ${hat.name}`, tone: "value" }]);
  }
  const unread = totalUnread(s);
  if (unread > 0) {
    lines.push([
      { text: "  ●  ", tone: "alert" },
      { text: `${unread} unread`, tone: "qualifier" },
    ]);
  } else if (s.hats.length === 0) {
    lines.push([{ text: "  no mailbox: mesh_register", tone: "value" }]);
  }
  // The role leaves the header (0.23.4): one ≔ line per hat that declares a
  // role, after the unread line and before the pools, truncated at the word
  // boundary that fits the panel width, never mid-word.
  for (const hat of s.hats) {
    if (!hat.role) continue;
    lines.push([
      roleMark,
      { text: truncateAtWord(hat.role, width - roleMark.text.length), tone: "value" },
    ]);
  }
  const scores = poolUnread(s);
  // A pool lists only when one of the asking session's hats is a member of it:
  // the panel is the session's view, not the host's roster.
  const mine = new Set(s.hats.map((h) => h.name));
  const pools = Object.keys(s.pools)
    .filter((pool) => (s.pools[pool] ?? []).some((member) => mine.has(member)))
    .map((pool) => ({
      pool,
      members: s.pools[pool]?.length ?? 0,
      unread: scores.get(pool) ?? 0,
    }))
    .sort((a, b) => b.unread - a.unread || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
  for (const row of pools.slice(0, ROWS_PER_GROUP)) {
    lines.push([
      poolMark,
      { text: row.pool, tone: "entity" },
      { text: ` (${row.members})`, tone: "value" },
    ]);
  }
  if (pools.length > ROWS_PER_GROUP) {
    lines.push([
      poolOverflowMark,
      { text: `+${pools.length - ROWS_PER_GROUP} more`, tone: "value" },
    ]);
  }
  const hosts = 1 + s.peers.length;
  lines.push([
    fleetMark,
    { text: `${s.mailboxes.length}`, tone: "qualifier" },
    { text: ` ${plural("agent", s.mailboxes.length)}`, tone: "value" },
    { text: " · ", tone: "value" },
    { text: `${Object.keys(s.pools).length}`, tone: "qualifier" },
    { text: ` ${plural("pool", Object.keys(s.pools).length)}`, tone: "value" },
    { text: " · ", tone: "value" },
    { text: `${hosts}`, tone: "qualifier" },
    { text: ` ${plural("host", hosts)}`, tone: "value" },
  ]);
  for (const peer of s.peers.slice(0, ROWS_PER_GROUP)) {
    lines.push([peerMark, { text: peerLabel(peer), tone: "qualifier" }]);
  }
  if (s.peers.length > ROWS_PER_GROUP) {
    lines.push([
      peerOverflowMark,
      { text: `+${s.peers.length - ROWS_PER_GROUP} more`, tone: "value" },
    ]);
  }
  return lines;
}

/** Collapsed: ONE line, conditional. Mail pending: the attention state replaces
 * the inventory (`▶ Mesh ● N unread`, nothing else stacked). Quiet: the fleet
 * inventory only, each counter three segments (muted ` · ` separator, count in
 * the qualifier tone, muted label; the 0.23.3 merge into one muted segment
 * dropped a space and the count tone, restored in 0.24.4). The first segment
 * carries the
 * toggle glyph (`▶ Mesh`, bold clickable — the expanded header is `▼ Mesh`),
 * restored in 0.24.2 after 0.23.3 dropped it from the conditional lines. */
export function formatMeshSidebarCollapsed(s: MeshSnapshot): SidebarSegment[] {
  // The unified panel grammar (2026-11-25, shared with the memory panel):
  // `▶ <Entity> ·<n> <Label>[s] ·...` — compact separators (the space rides
  // before the dot), capitalized plural labels, no glyphs in fold (the
  // labels carry the signals; "unread" stays lowercase — the alert
  // qualifier). The unread segment appears only when it signals.
  const unread = totalUnread(s);
  const hosts = 1 + s.peers.length;
  const counts: Array<[number, string, boolean]> = [
    ...(unread > 0 ? [[unread, "unread", false] as [number, string, boolean]] : []),
    [s.mailboxes.length, "Agent", true],
    [Object.keys(s.pools).length, "Pool", true],
    [hosts, "Host", true],
  ];
  const line: SidebarSegment[] = [{ text: "▶ Mesh", tone: "entity" }];
  for (const [count, label, capitalize] of counts) {
    line.push(
      { text: " ·", tone: "value" },
      { text: `${count}`, tone: "qualifier" },
      { text: ` ${capitalize ? plural(label, count) : label}`, tone: "value" },
    );
  }
  return line;
}

/** The rich /mesh status dialog (0.34.0): the session's view of the mesh, the
 * same sections as the sidebar plus the host data the sidebar skips. Labels
 * and separators in value, numbers and ids in qualifier, the unread glyph in
 * alert. No blank lines: an inapplicable section is omitted (unread at 0, capa
 * absent). Role lines truncate at the word boundary within the width budget. */
export function formatMeshStatusDialog(
  s: MeshSnapshot,
  opts?: { width?: number },
): SidebarSegment[][] {
  const width = opts?.width ?? 40;
  const line = (label: string, segs: SidebarSegment[]): SidebarSegment[] => [
    { text: `${label} `, tone: "value" as const },
    ...segs,
  ];
  const lines: SidebarSegment[][] = [];
  const self = s.hostname.length > 0 ? s.hostname : s.node_id.slice(0, 8);
  lines.push(
    line("Node", [
      { text: self, tone: "qualifier" },
      { text: " · ", tone: "value" },
      { text: s.node_id.slice(0, 8), tone: "qualifier" },
    ]),
  );
  if (s.hats.length === 0) {
    lines.push(line("Identity", [{ text: "not registered: mesh_register", tone: "value" }]));
  } else {
    lines.push(
      line(
        "Identity",
        s.hats.map((h, i) => {
          const name: SidebarSegment = { text: h.name, tone: "qualifier" };
          return i === 0 ? name : { text: `also ${h.name}`, tone: "value" };
        }),
      ),
    );
    for (const hat of s.hats) {
      if (!hat.role) continue;
      lines.push([
        { text: "  ≔  ", tone: "qualifier" },
        { text: truncateAtWord(hat.role, width - 5), tone: "value" },
      ]);
    }
  }
  const unread = totalUnread(s);
  if (unread > 0) {
    lines.push(
      line("Unread", [
        { text: "● ", tone: "alert" },
        { text: `${unread} unread`, tone: "qualifier" },
      ]),
    );
  }
  const mine = new Set(s.hats.map((h) => h.name));
  const scores = poolUnread(s);
  const myPools = Object.keys(s.pools)
    .filter((pool) => (s.pools[pool] ?? []).some((member) => mine.has(member)))
    .map((pool) => ({ pool, members: s.pools[pool]?.length ?? 0, unread: scores.get(pool) ?? 0 }))
    .sort((a, b) => b.unread - a.unread || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
  for (const row of myPools) {
    const segs: SidebarSegment[] = [
      { text: row.pool, tone: "qualifier" },
      { text: ` (${row.members})`, tone: "value" },
    ];
    if (row.unread > 0) {
      segs.push(
        { text: " · ", tone: "value" },
        { text: `${row.unread} unread`, tone: "qualifier" },
      );
    }
    lines.push(line("Pools", segs));
  }
  const hosts = 1 + s.peers.length;
  lines.push(
    line("Fleet", [
      { text: `${s.mailboxes.length}`, tone: "qualifier" },
      { text: ` ${plural("agent", s.mailboxes.length)}`, tone: "value" },
      { text: " · ", tone: "value" },
      { text: `${Object.keys(s.pools).length}`, tone: "qualifier" },
      { text: ` ${plural("pool", Object.keys(s.pools).length)}`, tone: "value" },
      { text: " · ", tone: "value" },
      { text: `${hosts}`, tone: "qualifier" },
      { text: ` ${plural("host", hosts)}`, tone: "value" },
    ]),
  );
  lines.push(
    line(
      "Peers",
      s.peers.length === 0
        ? [{ text: "none", tone: "value" }]
        : s.peers.map((p, i) => {
            const seg: SidebarSegment = { text: peerLabel(p), tone: "qualifier" };
            return i === 0 ? seg : { text: ` · ${seg.text}`, tone: "value" };
          }),
    ),
  );
  lines.push(
    line("Locks", [
      { text: `${s.active_locks}`, tone: "qualifier" },
      { text: ` ${plural("lock", s.active_locks)}`, tone: "value" },
    ]),
  );
  if (s.capa) {
    const hostSegs: SidebarSegment[] = [
      { text: `${s.capa.cpu.cores}`, tone: "qualifier" },
      { text: " cores", tone: "value" },
      { text: " · ", tone: "value" },
      { text: `${Math.round(s.capa.ram.totalMb / 1024)}`, tone: "qualifier" },
      { text: " GB", tone: "value" },
    ];
    if (s.capa.gpu) {
      hostSegs.push({ text: " · ", tone: "value" }, { text: s.capa.gpu.model, tone: "qualifier" });
    }
    lines.push(line("Host", hostSegs));
  }
  return lines;
}

/** The /mesh pools slice: my pools only, members and unread per pool. */
export function formatMeshPoolsDialog(s: MeshSnapshot): SidebarSegment[][] {
  const mine = new Set(s.hats.map((h) => h.name));
  const scores = poolUnread(s);
  const pools = Object.keys(s.pools)
    .filter((pool) => (s.pools[pool] ?? []).some((member) => mine.has(member)))
    .map((pool) => ({ pool, members: s.pools[pool]?.length ?? 0, unread: scores.get(pool) ?? 0 }))
    .sort((a, b) => b.unread - a.unread || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
  if (pools.length === 0) {
    return [[{ text: "no pool: mesh_join", tone: "value" }]];
  }
  return pools.map((row) => {
    const segs: SidebarSegment[] = [
      { text: row.pool, tone: "qualifier" },
      { text: ` (${row.members})`, tone: "value" },
    ];
    if (row.unread > 0) {
      segs.push(
        { text: " · ", tone: "value" },
        { text: `${row.unread} unread`, tone: "qualifier" },
      );
    }
    return [{ text: "  ≡  ", tone: "qualifier" }, ...segs];
  });
}

/** The /mesh peers slice: hostname@id per paired peer, none when empty. */
export function formatMeshPeersDialog(s: MeshSnapshot): SidebarSegment[][] {
  if (s.peers.length === 0) {
    return [[{ text: "none", tone: "value" }]];
  }
  return s.peers.map((peer) => [
    { text: "  ⇄  ", tone: "qualifier" },
    { text: peerLabel(peer), tone: "qualifier" },
  ]);
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
    // The /mesh board slice (0.34.0): the pool board, one line per box.
    board: {
      input: {
        type: "object",
        properties: { pool: { type: "string", description: "Pool id filter" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { box: { type: "string" }, line: { type: "string" } },
              required: ["box", "line"],
              additionalProperties: false,
            },
            description: "One line per box, keys in the fixed BOARD_KEYS order",
          },
        },
        required: ["rows"],
        additionalProperties: false,
      },
    },
    // The /mesh inbox slice (0.34.0): the unread mail, one row per delivery.
    inbox: {
      input: {
        type: "object",
        properties: { box: { type: "string", description: "Mailbox name filter" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                box: { type: "string" },
                from_box: { type: ["string", "null"] },
                subject: { type: "string" },
                age_s: { type: "number" },
              },
              required: ["box", "from_box", "subject", "age_s"],
              additionalProperties: false,
            },
            description: "The unread deliveries, oldest first, capped at 10 rows",
          },
          total: { type: "number", description: "The full unread count before the cap" },
        },
        required: ["rows", "total"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
