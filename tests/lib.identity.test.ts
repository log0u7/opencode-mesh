import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOrCreateIdentity } from "../src/lib/identity.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-identity-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadOrCreateIdentity", () => {
  it("creates node.json with restrictive permissions", () => {
    const identity = loadOrCreateIdentity(dir);

    const file = join(dir, "node.json");
    const stats = statSync(file);
    // 0600: owner read/write only
    expect(stats.mode & 0o777).toBe(0o600);

    expect(identity.node_id).toMatch(/[0-9a-f-]{36}/);
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof identity.hostname).toBe("string");
  });

  it("is stable across reloads (same id, same keys)", () => {
    const first = loadOrCreateIdentity(dir);
    const second = loadOrCreateIdentity(dir);

    expect(first.node_id).toBe(second.node_id);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.public_key).toEqual(second.public_key);
  });

  it("persists an operator-readable record with keys", () => {
    loadOrCreateIdentity(dir);

    const raw = JSON.parse(readFileSync(join(dir, "node.json"), "utf8")) as {
      node_id: string;
      public_key: unknown;
      private_key: unknown;
    };
    expect(raw.public_key).toBeTruthy();
    expect(raw.private_key).toBeTruthy();
    expect(raw.private_key).not.toEqual(raw.public_key);
  });
});

describe("pairing token flow", () => {
  it("authenticateToken consumes a pending token and binds it to the sender", async () => {
    const { createPairingToken, authenticateToken } = await import("../src/lib/peers.js");
    const { openMeshDb } = await import("../src/lib/db.js");
    const db = openMeshDb(":memory:");

    const token = createPairingToken(db);

    // No sender id: pending token alone is not accepted.
    expect(authenticateToken(db, token, null)).toBeNull();
    // With the claimed sender id: pairing completes.
    const peer = authenticateToken(db, token, "node-b");
    expect(peer?.node_id).toBe("node-b");
    // Token is consumed: second use falls back to the now-paired row.
    expect(authenticateToken(db, token, "node-c")?.node_id).toBe("node-b");
    // Unknown tokens fail.
    expect(authenticateToken(db, "nope", "node-x")).toBeNull();

    db.close();
  });
});

describe("corrupt identity file", () => {
  it("regenerates a valid identity when node.json is garbage", () => {
    writeFileSync(join(dir, "node.json"), "}{ not json", "utf8");

    const identity = loadOrCreateIdentity(dir);
    expect(identity.node_id).toMatch(/[0-9a-f-]{36}/);
    expect(statSync(join(dir, "node.json")).isFile()).toBe(true);
  });
});
