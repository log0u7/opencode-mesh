import { randomBytes } from "node:crypto";

import type { MeshDb } from "./db.js";
import type { Peer } from "../types/peer.js";

export type PeerInput = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses?: string[];
};

// Complete pairing with a token the peer generated (shared out of band).
// Only the pairing call and the peer know it; the server compares on every request.
export function pairWithToken(
  db: MeshDb,
  peer: {
    node_id: string;
    hostname: string;
    fingerprint: string;
    token: string;
    addresses?: string[];
  },
): void {
  const now = Date.now();

  db.conn.run(
    `INSERT INTO peers (node_id, hostname, fingerprint, addresses, paired, token, last_seen)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET hostname = excluded.hostname,
       fingerprint = excluded.fingerprint, paired = 1, token = excluded.token, last_seen = excluded.last_seen`,
    [
      peer.node_id,
      peer.hostname,
      peer.fingerprint,
      JSON.stringify(peer.addresses ?? []),
      peer.token,
      now,
    ],
  );
  db.conn.run("DELETE FROM pending_tokens WHERE token = ?", [peer.token]);
}

// Generate a token the peer must present with mesh_pair(node_id, token).
// Until consumed, the server accepts it as proof of pairing.
export function createPairingToken(db: MeshDb): string {
  const token = randomBytes(32).toString("base64url");
  db.conn.run("INSERT OR REPLACE INTO pending_tokens (token, created_at) VALUES (?, ?)", [
    token,
    Date.now(),
  ]);
  return token;
}

// Check a bearer token: known paired peer, or a pending pairing token (which
// then completes pairing for the claimed sender node).
export function authenticateToken(db: MeshDb, token: string, from: string | null): Peer | null {
  const paired = findPeerByToken(db, token);
  if (paired) {
    return paired;
  }

  const pending = db.conn.get<{ token: string }>(
    "SELECT token FROM pending_tokens WHERE token = ?",
    [token],
  );
  if (!pending) {
    return null;
  }

  // Pending tokens need the claimed sender id to bind the pairing to a node.
  if (from === null || from.length === 0) {
    return null;
  }
  pairWithToken(db, { node_id: from, hostname: "pending", fingerprint: "pending", token });
  return {
    node_id: from,
    hostname: "pending",
    fingerprint: "pending",
    addresses: [],
    paired: true,
    token,
    last_seen: Date.now(),
  };
}

export function listPeers(db: MeshDb): Peer[] {
  return db.conn.all<PeerRow>("SELECT * FROM peers ORDER BY hostname").map(rowToPeer);
}

export function findPeerByToken(db: MeshDb, token: string): Peer | null {
  const row = db.conn.get<PeerRow>("SELECT * FROM peers WHERE token = ? AND paired = 1", [token]);
  return row ? rowToPeer(row) : null;
}

export function upsertDiscoveredPeer(
  db: MeshDb,
  peer: { node_id: string; hostname: string; fingerprint: string; addresses: string[] },
): void {
  const now = Date.now();
  db.conn.run(
    `INSERT INTO peers (node_id, hostname, fingerprint, addresses, paired, token, last_seen)
     VALUES (?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(node_id) DO UPDATE SET hostname = excluded.hostname,
       fingerprint = excluded.fingerprint, addresses = excluded.addresses, last_seen = excluded.last_seen`,
    [peer.node_id, peer.hostname, peer.fingerprint, JSON.stringify(peer.addresses), now],
  );
}

type PeerRow = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses: string;
  paired: number;
  token: string | null;
  last_seen: number;
};

function rowToPeer(row: PeerRow): Peer {
  return {
    node_id: row.node_id,
    hostname: row.hostname,
    fingerprint: row.fingerprint,
    addresses: parseAddresses(row.addresses),
    paired: row.paired === 1,
    token: row.token,
    last_seen: row.last_seen,
  };
}

function parseAddresses(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}
