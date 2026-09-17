import { randomBytes, randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";
import type { Peer } from "../types/peer.js";

export type PeerInput = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses?: string[];
};

// Pair a peer (or re-pair, rotating the token) and return the new shared token.
// Only the pairing call and the peer know it; the server compares on every request.
export function pairPeer(
  db: MeshDb,
  peer: { node_id: string; hostname: string; fingerprint: string },
): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  db.conn.run(
    `INSERT INTO peers (node_id, hostname, fingerprint, addresses, paired, token, last_seen)
     VALUES (?, ?, ?, '[]', 1, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET hostname = excluded.hostname,
       fingerprint = excluded.fingerprint, paired = 1, token = excluded.token, last_seen = excluded.last_seen`,
    [peer.node_id, peer.hostname, peer.fingerprint, token, now],
  );

  return token;
}

export function listPeers(db: MeshDb): Peer[] {
  return db.conn.all<PeerRow>("SELECT * FROM peers ORDER BY hostname").map(rowToPeer);
}

export function findPeerByToken(db: MeshDb, token: string): Peer | null {
  const row = db.conn.get<PeerRow>("SELECT * FROM peers WHERE token = ? AND paired = 1", [token]);
  return row ? rowToPeer(row) : null;
}

export function touchPeer(db: MeshDb, nodeId: string, addresses: string[]): void {
  db.conn.run("UPDATE peers SET addresses = ?, last_seen = ? WHERE node_id = ?", [
    JSON.stringify(addresses),
    Date.now(),
    nodeId,
  ]);
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
