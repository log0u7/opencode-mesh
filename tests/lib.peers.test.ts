import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { pairingProofPayload, signPairingProof, verifyPairingProof } from "../src/lib/identity.js";
import {
  authenticateToken,
  createPairingToken,
  findPeerById,
  pairWithToken,
  upsertDiscoveredPeer,
} from "../src/lib/peers.js";

const PAIRING_TTL_MS = 5 * 60_000;

// A test-held Ed25519 identity for node-b: proofs are signed like a real peer.
function nodeBKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    public_key: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"),
    private_key: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString(
      "base64",
    ),
  };
}

// Wire format: `<base64 spki>.<base64 signature over pairingProofPayload(node_id, token)>`.
function proofFor(
  keys: { public_key: string; private_key: string },
  nodeId: string,
  token: string,
): string {
  return `${keys.public_key}.${signPairingProof(keys.private_key, pairingProofPayload(nodeId, token))}`;
}

describe("pairing token rules", () => {
  it("rejects a pending token once it is older than the pairing ttl", () => {
    const db = openMeshDb(":memory:");
    const keys = nodeBKeys();
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "b",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
      public_key: keys.public_key,
    });

    const fresh = createPairingToken(db);
    expect(authenticateToken(db, fresh, "node-b", proofFor(keys, "node-b", fresh))?.node_id).toBe(
      "node-b",
    );

    // Rewind the token: it must now be treated as expired, not as a credential.
    db.conn.run("UPDATE pending_tokens SET created_at = ?", [Date.now() - PAIRING_TTL_MS - 1]);
    const expired = createPairingToken(db);
    db.conn.run("UPDATE pending_tokens SET created_at = ? WHERE token = ?", [
      Date.now() - PAIRING_TTL_MS - 1,
      expired,
    ]);

    expect(authenticateToken(db, expired, "node-b", proofFor(keys, "node-b", expired))).toBeNull();

    db.close();
  });

  it("refuses to auto-pair a node id it has never seen", () => {
    const db = openMeshDb(":memory:");
    const token = createPairingToken(db);

    // A pending token alone grants nothing: the claimed sender must already be
    // a known node (discovered over mDNS or paired out of band).
    expect(authenticateToken(db, token, "node-attacker", "proof")).toBeNull();
    expect(authenticateToken(db, token, null, "proof")).toBeNull();

    // Nobody is paired and the token is untouched.
    expect(authenticateToken(db, token, "node-attacker", "proof")).toBeNull();

    db.close();
  });

  it("first bind rejects a proof key that differs from the discovery-pinned key", () => {
    const db = openMeshDb(":memory:");
    const pinned = nodeBKeys();
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
      public_key: pinned.public_key,
    });
    const token = createPairingToken(db);

    // An attacker reannouncing node-b's id with their own key over mDNS cannot
    // swap the discovery pin: the proof must be signed by the pinned key.
    const attacker = nodeBKeys();
    expect(authenticateToken(db, token, "node-b", proofFor(attacker, "node-b", token))).toBeNull();
    // The row stays unpaired, its pin intact, and the token unconsumed.
    const row = db.conn.get<{ paired: number }>(
      "SELECT paired FROM peers WHERE node_id = 'node-b'",
    );
    expect(row?.paired).toBe(0);
    expect(authenticateToken(db, token, "node-b", proofFor(pinned, "node-b", token))?.node_id).toBe(
      "node-b",
    );

    db.close();
  });

  it("rejects malformed proof envelopes (stray or leading dots)", () => {
    const db = openMeshDb(":memory:");
    const keys = nodeBKeys();
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
    });
    const token = createPairingToken(db);
    const signature = signPairingProof(keys.private_key, pairingProofPayload("node-b", token));

    // Base64 decoders skip dots, so a trailing dot would otherwise still
    // verify: the envelope grammar refuses it outright.
    for (const malformed of [
      `.${signature}`,
      `${keys.public_key}.`,
      `${keys.public_key}.${signature}.`,
    ]) {
      expect(authenticateToken(db, token, "node-b", malformed), `proof: ${malformed}`).toBeNull();
    }

    db.close();
  });

  it("consumes a pending token, pins the signer key, keeps the discovered identity", () => {
    const db = openMeshDb(":memory:");
    const keys = nodeBKeys();
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
      public_key: keys.public_key,
    });
    const token = createPairingToken(db);

    const peer = authenticateToken(db, token, "node-b", proofFor(keys, "node-b", token));
    expect(peer?.node_id).toBe("node-b");
    // The discovered hostname/fingerprint survive, not a "pending" placeholder.
    expect(peer?.hostname).toBe("laptop");
    expect(peer?.fingerprint).toBe("fb");

    // Token consumed: the paired row is what answers afterwards.
    expect(authenticateToken(db, token, "node-c", "whatever")?.node_id).toBe("node-b");

    db.close();
  });

  it("rebinds a paired peer's token only with a valid proof from the pinned key", () => {
    const db = openMeshDb(":memory:");
    const keys = nodeBKeys();
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
      public_key: keys.public_key,
    });
    pairWithToken(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      token: "tok-b-offer",
      addresses: ["10.0.0.2:4399"],
      public_key: keys.public_key,
    });
    // Two-sided pairing: this host's offer token is still pending here, and
    // node-b presents it back. Binding it requires a proof signed by the
    // pinned node-b key: the offer string alone must never rebind a row.
    const offer = createPairingToken(db);

    // The offer alone: refused.
    expect(authenticateToken(db, offer, "node-b")).toBeNull();
    // A proof signed by a different key: refused, token still unconsumed.
    const attacker = nodeBKeys();
    expect(authenticateToken(db, offer, "node-b", proofFor(attacker, "node-b", offer))).toBeNull();
    // A tampered proof: refused.
    const goodProof = proofFor(keys, "node-b", offer);
    expect(authenticateToken(db, offer, "node-b", `${goodProof.slice(0, -2)}xx`)).toBeNull();
    // A proof for a different token: refused.
    expect(
      authenticateToken(db, offer, "node-b", proofFor(keys, "node-b", "other-token")),
    ).toBeNull();

    // The real proof: the presented offer becomes the peer's credential, and
    // the pinned key is what stays trusted from now on.
    expect(authenticateToken(db, offer, "node-b", goodProof)?.node_id).toBe("node-b");
    expect(authenticateToken(db, offer, null)?.node_id).toBe("node-b");
    // The rotated-away token is no longer a credential.
    expect(authenticateToken(db, "tok-b-offer", null)).toBeNull();

    db.close();
  });

  it("refuses to rebind a paired peer that has no pinned key (legacy rows)", () => {
    const db = openMeshDb(":memory:");
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
    });
    pairWithToken(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      token: "tok-b-offer",
      addresses: ["10.0.0.2:4399"],
    });
    const offer = createPairingToken(db);

    // No pinned key means no way to attest the sender: rotation must go
    // through the operator (mesh_pair re-run), not a leaked offer.
    const keys = nodeBKeys();
    expect(authenticateToken(db, offer, "node-b", proofFor(keys, "node-b", offer))).toBeNull();

    db.close();
  });

  it("keeps serving an already paired peer without a pending token", () => {
    const db = openMeshDb(":memory:");
    pairWithToken(db, {
      node_id: "node-a",
      hostname: "a",
      fingerprint: "fa",
      token: "tok-a",
    });

    expect(authenticateToken(db, "tok-a", null)?.node_id).toBe("node-a");
    expect(authenticateToken(db, "nope", "node-a")).toBeNull();

    db.close();
  });

  it("verifies proofs against the pinned key, rejecting garbage", () => {
    const keys = nodeBKeys();
    const payload = pairingProofPayload("node-b", "token");
    const signature = signPairingProof(keys.private_key, payload);

    expect(verifyPairingProof(keys.public_key, payload, signature)).toBe(true);
    expect(verifyPairingProof(keys.public_key, payload, "not-base64!")).toBe(false);
    expect(verifyPairingProof("nope", payload, signature)).toBe(false);
  });

  it("never overwrites a paired peer's pinned key from mDNS discovery", () => {
    const db = openMeshDb(":memory:");
    const pinned = nodeBKeys();
    pairWithToken(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      token: "tok-b",
      addresses: ["10.0.0.2:4399"],
      public_key: pinned.public_key,
    });

    // Spoofed mDNS TXT carries a different key: it must not replace the pin
    // on a paired row (an attacker reannouncing node-b's id).
    const spoofed = nodeBKeys();
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.9.9.9:4399"],
      public_key: spoofed.public_key,
    });

    const offer = createPairingToken(db);
    // The spoofed key cannot produce an acceptable proof for the rebind.
    expect(authenticateToken(db, offer, "node-b", proofFor(spoofed, "node-b", offer))).toBeNull();
    // The real pinned key still rebinds.
    expect(authenticateToken(db, offer, "node-b", proofFor(pinned, "node-b", offer))?.node_id).toBe(
      "node-b",
    );

    db.close();
  });

  it("discovery without a key resets an unpaired row's pin (paired rows keep theirs)", () => {
    const db = openMeshDb(":memory:");
    const keys = nodeBKeys();
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
      public_key: keys.public_key,
    });

    // An reannouncement without the pk field (older advertising version)
    // clears the pin of an UNPAIRED row: it is low-trust state that binding
    // re-attests anyway.
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
    });
    expect(findPeerById(db, "node-b")?.public_key).toBeNull();

    db.close();
  });
});
