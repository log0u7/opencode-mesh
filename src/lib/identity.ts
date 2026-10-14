import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";

export type NodeIdentity = {
  node_id: string;
  hostname: string;
  public_key: string;
  private_key: string;
  fingerprint: string;
};

type PersistedIdentity = Omit<NodeIdentity, "fingerprint">;

export function loadOrCreateIdentity(dataDir: string): NodeIdentity {
  const file = join(dataDir, "node.json");
  const existing = readIdentity(file);

  if (existing) {
    // A file written by <= 0.2.0 carries either no keys or a dead Ed25519
    // JWK keypair nothing ever used. The node keeps its node_id (peers stay
    // recognised), and the file is rewritten to the canonical shape with a
    // fresh signing keypair so pairing proofs can be produced.
    if (existing.migrated) writeIdentity(file, existing.identity);
    return withFingerprint(existing.identity);
  }

  const identity: PersistedIdentity = {
    ...freshKeys(),
    node_id: randomUUID(),
    hostname: hostName(),
  };
  writeIdentity(file, identity);
  return withFingerprint(identity);
}

type ReadIdentity = { identity: PersistedIdentity; migrated: boolean };

function readIdentity(file: string): ReadIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read identity file ${file}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(file, "is not valid JSON");
  }

  const record = (parsed ?? {}) as Record<string, unknown>;
  if (typeof record.node_id !== "string" || record.node_id.length === 0) {
    throw corrupt(file, "has no node_id");
  }

  const identity: PersistedIdentity = {
    node_id: record.node_id,
    hostname: hostName(record.hostname),
    public_key: typeof record.public_key === "string" ? record.public_key : "",
    private_key: typeof record.private_key === "string" ? record.private_key : "",
  };
  const keysUsable = isSpki(identity.public_key) && isPkcs8(identity.private_key);
  const migrated = !keysUsable || Object.keys(record).some((key) => !KNOWN_KEYS.has(key));
  if (!keysUsable) {
    // Replace dead or missing keys; the node_id above is never regenerated, so
    // peers keep recognising this node through the migration.
    Object.assign(identity, freshKeys());
  }

  return { identity, migrated };
}

const KNOWN_KEYS = new Set(["node_id", "hostname", "public_key", "private_key"]);

// A corrupt identity file would make the node silently mint a new id, breaking
// every peer that recognises it and orphaning queued mail. Refuse to start and
// hand the operator a recovery path instead of reminting behind their back.
function corrupt(file: string, why: string): Error {
  return new Error(
    `identity file ${file} ${why}; refusing to mint a new node id. ` +
      `Move it aside to start with a fresh identity: mv '${file}' '${file}.bak'`,
  );
}

function freshKeys(): { public_key: string; private_key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    public_key: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"),
    private_key: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString(
      "base64",
    ),
  };
}

function isSpki(value: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(value, "base64"),
      format: "der",
      type: "spki",
    });
    // Only the algorithm we sign with: a hand-edited RSA key must not pass
    // validation and then break `sign(null, ...)` at send time.
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function isPkcs8(value: string): boolean {
  try {
    const key = createPrivateKey({
      key: Buffer.from(value, "base64"),
      format: "der",
      type: "pkcs8",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

// Pairing proofs: an Ed25519 signature binding the sender's node id to the
// token it presents. The canonical payload lives next to the signers so the
// sender and the verifier cannot drift.
export function pairingProofPayload(nodeId: string, token: string): string {
  return `opencode-mesh-pair:${nodeId}:${token}`;
}

export function signPairingProof(privateKey: string, payload: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return Buffer.from(sign(null, Buffer.from(payload, "utf8"), key)).toString("base64");
}

// The wire form of a pairing proof: `<base64 spki>.<base64 signature>`.
export function pairingProof(
  identity: { node_id: string; public_key: string; private_key: string },
  token: string,
): string {
  return `${identity.public_key}.${signPairingProof(
    identity.private_key,
    pairingProofPayload(identity.node_id, token),
  )}`;
}

export function verifyPairingProof(publicKey: string, payload: string, proof: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(proof, "base64"));
  } catch {
    return false;
  }
}

function writeIdentity(file: string, identity: PersistedIdentity): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Atomic write: temp file + rename, so a crash never leaves a truncated record.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// The fingerprint stays derived from the node_id (not from the signing key):
// keys can be replaced on migration without shuffling the operator-facing
// label for `mesh_status`.
function withFingerprint(identity: PersistedIdentity): NodeIdentity {
  return {
    ...identity,
    fingerprint: createHash("sha256").update(identity.node_id).digest("hex").slice(0, 16),
  };
}

function hostName(recorded?: unknown): string {
  return typeof recorded === "string" && recorded.length > 0 ? recorded : osHostname();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
