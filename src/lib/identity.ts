import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

export type NodeIdentity = {
  node_id: string;
  hostname: string;
  fingerprint: string;
};

type StoredIdentity = {
  node_id: string;
  hostname: string;
};

type PersistedIdentity = Omit<NodeIdentity, "fingerprint">;

export function loadOrCreateIdentity(dataDir: string): NodeIdentity {
  const file = join(dataDir, "node.json");

  return withFingerprint(tryRead(file) ?? generate(dataDir, file));
}

function tryRead(file: string): PersistedIdentity | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredIdentity>;
    if (typeof raw.node_id === "string" && raw.node_id.length > 0) {
      return { node_id: raw.node_id, hostname: hostName(raw.hostname) };
    }
    return null;
  } catch {
    return null;
  }
}

// An identity file written by <= 0.2.0 carries an Ed25519 keypair that nothing
// ever used. Only the node_id mattered, so keep it and drop the key material:
// the node keeps its identity and its peers stay recognised.
function generate(dataDir: string, file: string): PersistedIdentity {
  const identity: PersistedIdentity = {
    node_id: randomUUID(),
    hostname: hostName(),
  };

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Atomic write: temp file + rename, so a crash never leaves a truncated record.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);

  return identity;
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
