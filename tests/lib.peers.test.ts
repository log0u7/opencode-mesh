import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import {
  authenticateToken,
  createPairingToken,
  pairWithToken,
  upsertDiscoveredPeer,
} from "../src/lib/peers.js";

const PAIRING_TTL_MS = 5 * 60_000;

describe("pairing token rules", () => {
  it("rejects a pending token once it is older than the pairing ttl", () => {
    const db = openMeshDb(":memory:");
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "b",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
    });

    const fresh = createPairingToken(db);
    expect(authenticateToken(db, fresh, "node-b")?.node_id).toBe("node-b");

    // Rewind the token: it must now be treated as expired, not as a credential.
    db.conn.run("UPDATE pending_tokens SET created_at = ?", [Date.now() - PAIRING_TTL_MS - 1]);
    const expired = createPairingToken(db);
    db.conn.run("UPDATE pending_tokens SET created_at = ? WHERE token = ?", [
      Date.now() - PAIRING_TTL_MS - 1,
      expired,
    ]);

    expect(authenticateToken(db, expired, "node-b")).toBeNull();

    db.close();
  });

  it("refuses to auto-pair a node id it has never seen", () => {
    const db = openMeshDb(":memory:");
    const token = createPairingToken(db);

    // A pending token alone grants nothing: the claimed sender must already be
    // a known node (discovered over mDNS or paired out of band).
    expect(authenticateToken(db, token, "node-attacker")).toBeNull();
    expect(authenticateToken(db, token, null)).toBeNull();

    // Nobody is paired and the token is untouched.
    expect(authenticateToken(db, token, "node-attacker")).toBeNull();

    db.close();
  });

  it("consumes a pending token and keeps the discovered peer identity", () => {
    const db = openMeshDb(":memory:");
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
    });
    const token = createPairingToken(db);

    const peer = authenticateToken(db, token, "node-b");
    expect(peer?.node_id).toBe("node-b");
    // The discovered hostname/fingerprint survive, not a "pending" placeholder.
    expect(peer?.hostname).toBe("laptop");
    expect(peer?.fingerprint).toBe("fb");

    // Token consumed: the paired row is what answers afterwards.
    expect(authenticateToken(db, token, "node-c")?.node_id).toBe("node-b");

    db.close();
  });

  it("rebinds a paired peer's token when its own offer is presented back", () => {
    const db = openMeshDb(":memory:");
    upsertDiscoveredPeer(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      addresses: ["10.0.0.2:4399"],
    });
    // Two-sided pairing: this host accepted node-b's offer...
    pairWithToken(db, {
      node_id: "node-b",
      hostname: "laptop",
      fingerprint: "fb",
      token: "tok-b-offer",
      addresses: ["10.0.0.2:4399"],
    });
    // ...and node-b authenticates with THIS host's offer token, which is still
    // pending here. Binding it is how the protocol works, not a downgrade.
    const offer = createPairingToken(db);

    expect(authenticateToken(db, offer, "node-b")?.node_id).toBe("node-b");
    // The presented offer becomes the peer's credential from now on.
    expect(authenticateToken(db, offer, null)?.node_id).toBe("node-b");

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
});
