import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadOrCreateIdentity,
  pairingProofPayload,
  signPairingProof,
  verifyPairingProof,
} from "../src/lib/identity.js";

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

    // A signing key is back: pairing rebinding requires proof of possession.
    expect(identity.public_key).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(identity.private_key).toMatch(/^[A-Za-z0-9+/=]+$/);

    const raw = JSON.parse(readFileSync(join(dir, "node.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["hostname", "node_id", "private_key", "public_key"]);
  });

  it("keeps the keypair stable across reloads", () => {
    const first = loadOrCreateIdentity(dir);
    const second = loadOrCreateIdentity(dir);

    expect(first.public_key).toBe(second.public_key);
    expect(first.private_key).toBe(second.private_key);
  });

  it("regenerates a parseable keypair that is not Ed25519", () => {
    // A hand-edited node.json with an RSA key must not pass key validation:
    // `sign(null, ...)` would break at send time on Node.
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(
      join(dir, "node.json"),
      JSON.stringify({
        node_id: "11111111-2222-3333-4444-555555555555",
        hostname: "h",
        public_key: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString(
          "base64",
        ),
        private_key: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString(
          "base64",
        ),
      }),
      "utf8",
    );

    const identity = loadOrCreateIdentity(dir);
    expect(identity.node_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(identity.public_key).not.toBe(
      Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"),
    );
    // The regenerated keys are usable for signing and verifying.
    const payload = pairingProofPayload("node-b", "tok");
    expect(
      verifyPairingProof(
        identity.public_key,
        payload,
        signPairingProof(identity.private_key, payload),
      ),
    ).toBe(true);
  });

  it("signs and verifies a pairing proof with the identity keys", () => {
    const identity = loadOrCreateIdentity(dir);
    const payload = `node-b:${"tok".repeat(8)}`;

    const proof = signPairingProof(identity.private_key, payload);
    expect(verifyPairingProof(identity.public_key, payload, proof)).toBe(true);
    // Any other payload, or a flipped byte, must fail: the proof binds node and token.
    expect(verifyPairingProof(identity.public_key, `node-c:${"tok".repeat(8)}`, proof)).toBe(false);
    expect(verifyPairingProof(identity.public_key, payload, `${proof.slice(0, -2)}xx`)).toBe(false);
    expect(verifyPairingProof(identity.public_key, payload, "not-base64!")).toBe(false);
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

  it("rewrites a migrated keypair file to the canonical shape on disk", () => {
    const previous = {
      node_id: "11111111-2222-3333-4444-555555555555",
      hostname: "old-host",
      public_key: { kty: "OKP", crv: "Ed25519", x: "stale" },
      private_key: { kty: "OKP", crv: "Ed25519", x: "stale", d: "stale" },
    };
    const file = join(dir, "node.json");
    writeFileSync(file, JSON.stringify(previous), "utf8");

    loadOrCreateIdentity(dir);

    // The stale key material must not survive on disk: migration is not done
    // until the stored file matches the in-memory record, with a fresh
    // generated keypair (the 0.2.0 JWK keys were never ours to keep).
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["hostname", "node_id", "private_key", "public_key"]);
    expect(String(raw.public_key)).not.toBe(previous.public_key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("corrupt identity file", () => {
  it("refuses to mint a new identity when node.json is not valid JSON", () => {
    writeFileSync(join(dir, "node.json"), "}{ not json", "utf8");

    expect(() => loadOrCreateIdentity(dir)).toThrow(/node\.json|corrupt/i);
  });

  it("refuses to mint a new identity when node_id is missing", () => {
    writeFileSync(join(dir, "node.json"), JSON.stringify({ hostname: "x" }), "utf8");

    expect(() => loadOrCreateIdentity(dir)).toThrow(/node_id/);
  });

  it("leaves the corrupt file untouched for the operator to inspect", () => {
    const file = join(dir, "node.json");
    writeFileSync(file, "}{ not json", "utf8");

    expect(() => loadOrCreateIdentity(dir)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("}{ not json");
  });

  it("refuses to mint a new identity for an empty or non-object body", () => {
    for (const body of ["{}", "null", "[1,2]", '"str"', "42"]) {
      writeFileSync(join(dir, "node.json"), body, "utf8");
      expect(() => loadOrCreateIdentity(dir), `body: ${body}`).toThrow(/node_id/);
    }
  });

  it("refuses to mint a new identity when node.json cannot be read", () => {
    // A directory makes readFileSync throw EISDIR, not ENOENT: a real file
    // exists, so reminting would be a silent identity change.
    mkdirSync(join(dir, "node.json"));

    expect(() => loadOrCreateIdentity(dir)).toThrow(/cannot read/);
  });

  it("strips unknown keys while migrating, not just the keypair", () => {
    const file = join(dir, "node.json");
    writeFileSync(
      file,
      JSON.stringify({ node_id: "11111111-2222-3333-4444-555555555555", hostname: "h", note: "x" }),
      "utf8",
    );

    loadOrCreateIdentity(dir);

    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual([
      "hostname",
      "node_id",
      "private_key",
      "public_key",
    ]);
  });
});
