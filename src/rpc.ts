import { Rpc } from "@opencode/plugin/rpc";

// The TUI sidebar reads one compact snapshot per tick over RPC. The pure helpers
// (snapshotFromMesh, formatMeshLines) are testable without a renderer; the
// definition itself carries the wire schema.

export type MeshSnapshot = {
  node_id: string;
  hostname: string;
  /** Paired peers only: discovery alone never makes a peer sendable. */
  peers: Array<{ node_id: string; hostname: string }>;
  active_locks: number;
};

/** Structural input: the mesh context (identity, listPeers, listLocks) satisfies this. */
export type SnapshotInput = {
  identity: { node_id: string; hostname: string };
  peers: ReadonlyArray<{ node_id: string; hostname: string; paired: boolean }>;
  locks: ReadonlyArray<unknown>;
  server: string;
};

export function snapshotFromMesh(data: SnapshotInput): MeshSnapshot {
  return {
    node_id: data.identity.node_id,
    hostname: data.identity.hostname,
    peers: data.peers
      .filter((p) => p.paired)
      .map((p) => ({ node_id: p.node_id, hostname: p.hostname })),
    active_locks: data.locks.length,
  };
}

/** Sidebar lines: the node, one line per paired peer, the active lock count. */
export function formatMeshLines(s: MeshSnapshot): string[] {
  const self = s.hostname.length > 0 ? s.hostname : s.node_id;
  const lines = [`mesh: ${self}`];
  if (s.peers.length === 0) {
    lines.push("no paired peers");
  } else {
    for (const peer of s.peers) {
      lines.push(`↔ ${peer.hostname.length > 0 ? peer.hostname : peer.node_id}`);
    }
  }
  if (s.active_locks > 0) {
    lines.push(`${s.active_locks} active lock(s)`);
  }
  return lines;
}

export const MeshRpc = Rpc.define({
  id: "mesh",
  methods: {
    snapshot: {
      input: { type: "object", properties: {}, additionalProperties: false },
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
        },
        required: ["node_id", "hostname", "peers", "active_locks"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
