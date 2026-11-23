import { randomBytes, randomInt } from "node:crypto";

import type { MeshDb } from "./db.js";
import { pairingProofPayload, verifyPairingProof } from "./identity.js";
import type { Peer } from "../types/peer.js";

// A pairing offer is only useful while the operator can relay it out of band.
// Past this age the token is dropped instead of becoming a permanent credential.
export const PAIRING_TOKEN_TTL_MS = 30 * 60_000;

/** Six-digit pairing code: a capability naming a pending offer, not a secret.
 * The trust anchor stays the Ed25519 proof (pk pinned at completion). */
export type PairingCode = { code: string; token: string; hostname: string };

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type PeerInput = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses?: string[];
  public_key?: string;
};

// Complete pairing with a token the peer generated (shared out of band).
// Only the pairing call and the peer know it; the server compares on every request.
// The pinned public_key is preserved when the call provides none (manual pairing):
// pairing must never be able to erase a proof key it did not attest.
export function pairWithToken(
  db: MeshDb,
  peer: {
    node_id: string;
    hostname: string;
    fingerprint: string;
    token: string;
    addresses?: string[];
    public_key?: string;
  },
): void {
  const now = Date.now();

  // New pairings speak TLS (0.11+): the flag rides with the pairing itself.
  db.conn.run(
    `INSERT INTO peers (node_id, hostname, fingerprint, addresses, paired, token, public_key, last_seen, tls)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)
     ON CONFLICT(node_id) DO UPDATE SET hostname = excluded.hostname,
       fingerprint = excluded.fingerprint, paired = 1, token = excluded.token,
       public_key = COALESCE(excluded.public_key, peers.public_key), last_seen = excluded.last_seen,
       tls = 1`,
    [
      peer.node_id,
      peer.hostname,
      peer.fingerprint,
      JSON.stringify(peer.addresses ?? []),
      peer.token,
      peer.public_key ?? null,
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

/** Schema addition: pending_tokens gains code + hostname (the emitter's real
 * name, replacing the "manual" placeholder). */
export function ensurePairingCodeSchema(db: MeshDb): void {
  const columns = db.conn
    .all<{ name: string }>("PRAGMA table_info(pending_tokens)")
    .map((c) => c.name);
  if (!columns.includes("code")) {
    db.conn.exec("ALTER TABLE pending_tokens ADD COLUMN code TEXT");
    db.conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_code ON pending_tokens(code)");
  }
  if (!columns.includes("hostname")) {
    db.conn.exec("ALTER TABLE pending_tokens ADD COLUMN hostname TEXT");
  }
}

/** Create a code-based pairing offer: a 6-digit code naming the pending token. */
export function createPairingCode(db: MeshDb, hostname: string): PairingCode {
  const token = createPairingToken(db);
  let code = newCode();
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      db.conn.run(
        "INSERT INTO pending_tokens (token, created_at, code, hostname) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(token) DO UPDATE SET code = excluded.code, hostname = excluded.hostname",
        [token, Date.now(), code, hostname],
      );
      return { code, token, hostname };
    } catch (error) {
      lastError = error;
      code = newCode(); // unique index collision: regenerate
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`unable to allocate a unique pairing code: ${detail}`);
}

/** Resolve a pairing code to its pending offer. Expired or absent codes return null. */
export function findPendingByCode(
  db: MeshDb,
  code: string,
): { token: string; hostname: string } | null {
  if (!/^\d{6}$/.test(code)) return null;
  prunePendingTokens(db);
  const row = db.conn.get<{ token: string; hostname: string | null }>(
    "SELECT token, hostname FROM pending_tokens WHERE code = ?",
    [code],
  );
  if (!row || row.hostname === null) return null;
  return { token: row.token, hostname: row.hostname };
}

// Check a bearer token: known paired peer, or a live pending pairing token.
// The pending path requires the claimed sender to be a node this host already
// knows, and (the rebind-window fix) a proof signed by the sender's pinned
// key: a leaked offer alone cannot rotate a paired credential.
export function authenticateToken(
  db: MeshDb,
  token: string,
  from: string | null,
  proof?: string,
): Peer | null {
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

  // Proof of possession: the sender signs opencode-mesh-pair:<node_id>:<token>
  // with the key pinned for it (first bind: the proof carries its own key).
  const attested = attestedProof(known, token, proof);
  if (attested === null) {
    return null;
  }

  pairWithToken(db, {
    node_id: known.node_id,
    hostname: known.hostname,
    fingerprint: known.fingerprint,
    addresses: known.addresses,
    public_key: attested,
    token,
  });
  return known;
}

// Returns the public key to pin for this binding, or null when the proof does
// not attest the sender. Rules:
// - wire form is exactly `<base64 spki>.<base64 sig>`: no extra dots (base64
//   decoders skip '.', so a trailing dot would otherwise verify);
// - unpaired known node: the proof's key is pinned once its signature checks;
// - paired node with a pinned key: the proof key must BE the pinned key;
// - paired node without a pinned key (legacy/manual rows): no remote attested
//   rebind at all. Rotation goes through the operator (re-run mesh_pair).
function attestedProof(known: Peer, token: string, proof: string | undefined): string | null {
  if (proof === undefined || proof.length === 0) {
    return null;
  }

  const separator = proof.indexOf(".");
  if (separator <= 0 || separator === proof.length - 1) {
    return null;
  }
  const presentedKey = proof.slice(0, separator);
  const signature = proof.slice(separator + 1);
  if (signature.includes(".")) {
    return null;
  }
  const payload = pairingProofPayload(known.node_id, token);

  if (known.paired) {
    // Rotation of a live credential: the pinned key is the only authority.
    if (known.public_key === null || presentedKey !== known.public_key) {
      return null;
    }
  } else if (known.public_key !== null && presentedKey !== known.public_key) {
    // First bind, but discovery already pinned a different key: spoof guard.
    return null;
  }

  return verifyPairingProof(presentedKey, payload, signature) ? presentedKey : null;
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

export type PeerTarget = {
  url: string;
  /** True when the peer serves TLS: the client pins `pk`. */
  tls: boolean;
  /** The pinned cert SPKI (the peer's Ed25519 key) when tls and known. */
  pk: string | null;
};

// Paired peer connection info for sending: scheme chosen by the peer's tls
// flag (TLS-only since 0.11). Peer addresses must carry a port: discovery
// attaches the advertised port and mesh_pair transmits a full host:port.
// Returning null instead of guessing the local port keeps a stale address
// from silently reaching the wrong socket.
export function resolvePeerTarget(db: MeshDb, query: string): PeerTarget | null {
  const peers = listPeers(db).filter((p) => p.paired);
  const peer =
    peers.find((p) => p.node_id === query) ?? peers.find((p) => p.hostname === query) ?? null;
  // A bare IPv6 literal also ends in ":<digits>", so the bracketed form is the
  // only one that can be told apart unambiguously.
  const address = peer?.addresses.find(hasPort);
  if (address === undefined || peer === null) {
    return null;
  }
  const tls = peer.tls;
  return {
    url: `${tls ? "https" : "http"}://${address}`,
    tls,
    pk: tls ? (peer.public_key ?? null) : null,
  };
}

function hasPort(address: string): boolean {
  // Bracketed IPv6, with an optional zone id (`[fe80::1%eth0]:4399`) and the
  // v4-mapped dotted form (`[::ffff:192.168.1.10]:4399`).
  return /^\[[0-9a-f:.]+(?:%[^\]]+)?\]:\d+$/i.test(address) || /^[^:]+:\d+$/.test(address);
}

export function upsertDiscoveredPeer(
  db: MeshDb,
  peer: {
    node_id: string;
    hostname: string;
    fingerprint: string;
    addresses: string[];
    public_key?: string;
    tls?: boolean;
  },
): void {
  const now = Date.now();
  const tls = peer.tls === true ? 1 : 0;
  db.conn.run(
    `INSERT INTO peers (node_id, hostname, fingerprint, addresses, paired, token, public_key, last_seen, tls)
     VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET hostname = excluded.hostname,
       fingerprint = excluded.fingerprint, addresses = excluded.addresses,
       public_key = CASE WHEN peers.paired = 1 THEN peers.public_key ELSE excluded.public_key END,
       tls = CASE WHEN peers.paired = 1 THEN peers.tls ELSE excluded.tls END,
       last_seen = excluded.last_seen`,
    [
      peer.node_id,
      peer.hostname,
      peer.fingerprint,
      JSON.stringify(peer.addresses),
      peer.public_key ?? null,
      now,
      tls,
    ],
  );
}

type PeerRow = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses: string;
  paired: number;
  token: string | null;
  public_key: string | null;
  last_seen: number;
  tls: number;
};

function rowToPeer(row: PeerRow): Peer {
  return {
    node_id: row.node_id,
    hostname: row.hostname,
    fingerprint: row.fingerprint,
    addresses: parseAddresses(row.addresses),
    paired: row.paired === 1,
    token: row.token,
    public_key: row.public_key,
    last_seen: row.last_seen,
    tls: row.tls === 1,
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
