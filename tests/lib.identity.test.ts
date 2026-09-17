import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
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
