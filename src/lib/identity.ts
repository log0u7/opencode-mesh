import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";

export type NodeIdentity = {
  node_id: string;
  hostname: string;
  fingerprint: string;
};

type PersistedIdentity = Omit<NodeIdentity, "fingerprint">;

export function loadOrCreateIdentity(dataDir: string): NodeIdentity {
  const file = join(dataDir, "node.json");
  const existing = readIdentity(file);

  if (existing) {
    // A file written by <= 0.2.0 carries an Ed25519 keypair nothing ever used.
    // Only the node_id matters, so the migration finishes by rewriting the file
    // without the key material: the node keeps its id and its peers stay
    // recognised, and the dead keys stop lingering on disk.
    if (existing.migrated) writeIdentity(file, existing.identity);
    return withFingerprint(existing.identity);
  }

  const identity: PersistedIdentity = { node_id: randomUUID(), hostname: hostName() };
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

  return {
    identity: { node_id: record.node_id, hostname: hostName(record.hostname) },
    migrated: Object.keys(record).some((key) => key !== "node_id" && key !== "hostname"),
  };
}

// A corrupt identity file would make the node silently mint a new id, breaking
// every peer that recognises it and orphaning queued mail. Refuse to start and
// hand the operator a recovery path instead of reminting behind their back.
function corrupt(file: string, why: string): Error {
  return new Error(
    `identity file ${file} ${why}; refusing to mint a new node id. ` +
      `Move it aside to start with a fresh identity: mv '${file}' '${file}.bak'`,
  );
}

function writeIdentity(file: string, identity: PersistedIdentity): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Atomic write: temp file + rename, so a crash never leaves a truncated record.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// The keypair this replaces produced a fingerprint nobody verified. Deriving it
// from the node_id keeps the same short, operator-readable label for `mesh_status`
// without storing or protecting key material.
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
