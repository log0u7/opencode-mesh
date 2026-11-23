// Single-string pairing offers: the whole handshake payload (node id, pending
// token, public key, address, hostname) in one copyable string. The trust
// anchor stays the Ed25519 proof — the blob only carries what the wire
// protocol already required field by field.

import { createPairingToken } from "./peers.js";
import type { MeshDb } from "./db.js";

const PREFIX = "MESH1-";

export type OfferPayload = {
  node_id: string;
  token: string;
  pk: string;
  address?: string;
  hostname?: string;
  /** Emitter serves TLS on its mesh port (0.11+). */
  tls?: boolean;
};

export function buildOfferBlob(
  db: MeshDb,
  self: { node_id: string; pk: string; hostname: string; address: string },
): string {
  const token = createPairingToken(db);
  const payload: OfferPayload = {
    node_id: self.node_id,
    token,
    pk: self.pk,
    address: self.address,
    hostname: self.hostname,
    tls: true,
  };
  return PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function parseOfferBlob(offer: string): OfferPayload | null {
  if (!offer.startsWith(PREFIX)) return null;
  try {
    const decoded = Buffer.from(offer.slice(PREFIX.length), "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<OfferPayload>;
    if (
      typeof parsed.node_id !== "string" ||
      parsed.node_id.length === 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      typeof parsed.pk !== "string" ||
      parsed.pk.length === 0
    ) {
      return null;
    }
    return {
      node_id: parsed.node_id,
      token: parsed.token,
      pk: parsed.pk,
      ...(typeof parsed.address === "string" ? { address: parsed.address } : {}),
      ...(typeof parsed.hostname === "string" ? { hostname: parsed.hostname } : {}),
      ...(parsed.tls === true ? { tls: true } : {}),
    };
  } catch {
    return null;
  }
}
