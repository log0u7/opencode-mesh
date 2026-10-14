import { randomBytes } from "node:crypto";

import type { MeshDb } from "./db.js";
import type { Peer } from "../types/peer.js";

// A pairing offer is only useful while the operator can relay it out of band.
// Past this age the token is dropped instead of becoming a permanent credential.
export const PAIRING_TOKEN_TTL_MS = 5 * 60_000;

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

// Check a bearer token: known paired peer, or a live pending pairing token.
// The pending path requires the claimed sender to be a node this host already
// knows, so a leaked token cannot mint a permanent peer on its own.
export function authenticateToken(db: MeshDb, token: string, from: string | null): Peer | null {
  const paired = findPeerByToken(db, token);
  if (paired) {
    return paired;
  }

  prunePendingTokens(db);

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

  const known = findPeerById(db, from);
  if (!known) {
    return null;
  }

  pairWithToken(db, {
    node_id: known.node_id,
    hostname: known.hostname,
    fingerprint: known.fingerprint,
    addresses: known.addresses,
    token,
  });
  return known;
}

// Pairing offers are single-shot credentials with a short life: bulk delete on
// every check keeps the table bounded without a background timer.
export function prunePendingTokens(db: MeshDb): void {
  db.conn.run("DELETE FROM pending_tokens WHERE created_at <= ?", [
    Date.now() - PAIRING_TOKEN_TTL_MS,
  ]);
}

export function listPeers(db: MeshDb): Peer[] {
  return db.conn.all<PeerRow>("SELECT * FROM peers ORDER BY hostname").map(rowToPeer);
}

export function findPeerById(db: MeshDb, nodeId: string): Peer | null {
  const row = db.conn.get<PeerRow>("SELECT * FROM peers WHERE node_id = ?", [nodeId]);
  return row ? rowToPeer(row) : null;
}

export function findPeerByToken(db: MeshDb, token: string): Peer | null {
  const row = db.conn.get<PeerRow>("SELECT * FROM peers WHERE token = ? AND paired = 1", [token]);
  return row ? rowToPeer(row) : null;
}

// Paired peers only: discovery alone never makes a peer sendable.
export function findSendablePeer(
  db: MeshDb,
  query: string,
): { node_id: string; addresses: string[]; token: string | null } | null {
  const peers = listPeers(db).filter((p) => p.paired);
  return peers.find((p) => p.node_id === query) ?? peers.find((p) => p.hostname === query) ?? null;
}

// Peer addresses must carry a port: discovery attaches the advertised port and
// mesh_pair transmits a full host:port. Returning null instead of guessing the
// local port keeps a stale address from silently reaching the wrong socket.
export function resolvePeerUrl(db: MeshDb, query: string): string | null {
  const peers = listPeers(db).filter((p) => p.paired);
  const peer =
    peers.find((p) => p.node_id === query) ?? peers.find((p) => p.hostname === query) ?? null;
  // A bare IPv6 literal also ends in ":<digits>", so the bracketed form is the
  // only one that can be told apart unambiguously.
  const address = peer?.addresses.find(hasPort);
  return address !== undefined ? `http://${address}` : null;
}

function hasPort(address: string): boolean {
  // Bracketed IPv6, optionally with a zone id (e.g. `[fe80::1%eth0]:4399`).
  return /^\[[0-9a-f:]+(?:%[^\]]+)?\]:\d+$/i.test(address) || /^[^:]+:\d+$/.test(address);
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
