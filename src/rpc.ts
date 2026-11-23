import { Rpc } from "@opencode/plugin/rpc";

// The TUI sidebar reads one compact snapshot per tick over RPC. The pure helpers
// (snapshotFromMesh, formatMeshSidebar) are testable without a renderer; the
// definition itself carries the wire schema.

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
    peers: data.peers
      .filter((p) => p.paired)
      .map((p) => ({ node_id: p.node_id, hostname: p.hostname })),
    active_locks: data.locks.length,
    hats: [...data.hats],
    mailboxes: [...data.mailboxes],
    pools: { ...data.pools },
  };
}

// Presence thresholds: fresh under 2 minutes, warm under 15.
export const PRESENCE_FRESH_S = 120;
export const PRESENCE_WARM_S = 900;

export function presenceMark(age_s: number): string {
  if (age_s <= PRESENCE_FRESH_S) return "●";
  if (age_s <= PRESENCE_WARM_S) return "○";
  return "";
}

export function formatAge(age_s: number): string {
  if (age_s < 60) return `${age_s}s`;
  return `${Math.floor(age_s / 60)}m`;
}

function formatMember(m: MailboxInfo): string {
  const mark = presenceMark(m.age_s);
  const age = formatAge(m.age_s);
  return mark ? `${mark} ${m.name} ${age}` : `${m.name} ${age}`;
}

function formatPoolLine(pool: string, members: string[], byName: Map<string, MailboxInfo>): string {
  const parts: string[] = [];
  for (const name of members.slice(0, 4)) {
    const box = byName.get(name);
    parts.push(box ? formatMember(box) : name);
  }
  if (members.length > 4) {
    parts.push(`+${members.length - 4}`);
  }
  return `${pool}: ${parts.join(" · ")}`;
}

/** Manual pairings all carry the placeholder hostname "manual": label them by
 * short node id + address, which is what actually distinguishes them. */
export function peerLabel(peer: { node_id: string; hostname: string; address?: string }): string {
  const host = peer.hostname.length > 0 ? peer.hostname : peer.node_id;
  if (host !== "manual" && host !== peer.node_id) return host;
  const id = peer.node_id.slice(0, 8);
  return peer.address !== undefined ? `${id}@${peer.address}` : id;
}

/** Sidebar lines: the session's hats (unread first), one line per pool, peers, locks. */
export function formatMeshLines(s: MeshSnapshot): string[] {
  const lines: string[] = [];
  if (s.hats.length > 0) {
    const totalUnread = s.hats.reduce((sum, h) => sum + h.unread, 0);
    const rendered = s.hats.map((h) => {
      const role = h.role ? ` (${h.role})` : "";
      const unread = h.unread > 0 ? ` ● ${h.unread}` : "";
      return `${h.name}${role}${unread}`;
    });
    const prefix = totalUnread > 0 ? ` ● ${totalUnread} unread —` : "";
    lines.push(`hats:${prefix} ${rendered.join(" · ")}`);
  } else {
    lines.push("no mailbox — mesh_register");
  }
  const byName = new Map(s.mailboxes.map((m) => [m.name, m]));
  for (const [pool, members] of Object.entries(s.pools)) {
    if (members.length === 0) continue;
    lines.push(formatPoolLine(pool, members, byName));
  }
  if (s.peers.length === 0) {
    lines.push("no paired peers");
  } else {
    for (const peer of s.peers) {
      lines.push(`↔ ${peerLabel(peer)}`);
    }
  }
  if (s.active_locks > 0) {
    lines.push(`${s.active_locks} active lock(s)`);
  }
  return lines;
}

/** Collapsed: two lines. Line 1 is the toggle line — the TUI renders the
 * ▶/▼ prefix itself, so this returns `Mesh` plus the unread marker only.
 * Line 2 carries the counts (agents, pools, hosts). */
export function formatMeshSidebar(s: MeshSnapshot, collapsed: boolean): string[] {
  if (!collapsed) {
    return formatMeshLines(s);
  }
  const unread = s.hats.reduce((sum, h) => sum + h.unread, 0);
  const hosts = 1 + s.peers.length;
  return [
    unread > 0 ? `Mesh ● ${unread} unread` : "Mesh",
    `${s.mailboxes.length} agents · ${Object.keys(s.pools).length} pools · ${hosts} hôte${hosts > 1 ? "s" : ""}`,
  ];
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
