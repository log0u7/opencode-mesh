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

  it("is stable across reloads (same id, same fingerprint)", () => {
    const first = loadOrCreateIdentity(dir);
    const second = loadOrCreateIdentity(dir);

    expect(first.node_id).toBe(second.node_id);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("stores no key material: nothing signs or verifies with it", () => {
    const identity = loadOrCreateIdentity(dir);

    // The Ed25519 ceremony was pure overhead: no signature, no verification.
    expect(identity).not.toHaveProperty("public_key");
    expect(identity).not.toHaveProperty("private_key");

    const raw = JSON.parse(readFileSync(join(dir, "node.json"), "utf8")) as Record<string, unknown>;
    // The fingerprint is derived from node_id, never stored alongside keys.
    expect(Object.keys(raw).sort()).toEqual(["hostname", "node_id"]);
    expect(raw).not.toHaveProperty("public_key");
    expect(raw).not.toHaveProperty("private_key");
  });

  it("keeps an existing node_id across the migration from the keypair format", () => {
    const previous = {
      node_id: "11111111-2222-3333-4444-555555555555",
      hostname: "old-host",
      public_key: { kty: "OKP", crv: "Ed25519", x: "stale" },
      private_key: { kty: "OKP", crv: "Ed25519", x: "stale", d: "stale" },
    };
    writeFileSync(join(dir, "node.json"), JSON.stringify(previous), "utf8");

    const identity = loadOrCreateIdentity(dir);

    // Identity continuity: the node keeps its id, so peers stay recognised.
    expect(identity.node_id).toBe(previous.node_id);
    expect(identity.hostname).toBe("old-host");
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(identity.fingerprint).not.toBe("");
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
