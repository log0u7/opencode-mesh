import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Jwk = {
  kty?: string;
  x?: string;
  [key: string]: unknown;
};

export type NodeIdentity = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  public_key: Jwk;
  private_key: Jwk;
};

type PersistedIdentity = {
  node_id: string;
  hostname: string;
  public_key: Jwk;
  private_key: Jwk;
};

export function loadOrCreateIdentity(dataDir: string): NodeIdentity {
  const file = join(dataDir, "node.json");

  const existing = tryRead(file);
  if (existing) {
    return withFingerprint(existing);
  }

  return withFingerprint(generate(dataDir, file));
}

function tryRead(file: string): PersistedIdentity | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as PersistedIdentity;
    if (typeof raw.node_id === "string" && raw.public_key && raw.private_key) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function generate(dataDir: string, file: string): PersistedIdentity {
  // Bun implements node:crypto, so this works under OpenCode's runtime and Node.
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as Jwk;
  const privateJwk = privateKey.export({ format: "jwk" }) as Jwk;

  const identity: PersistedIdentity = {
    node_id: randomUUID(),
    hostname: hostName(),
    public_key: publicJwk,
    private_key: privateJwk,
  };

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Atomic write: temp file + rename, so a crash never leaves a truncated keypair.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);

  return identity;
}

function withFingerprint(identity: PersistedIdentity): NodeIdentity {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  // x is the raw public key coordinate in an Ed25519 JWK; hash it for a short
  // operator-verifiable fingerprint.
  const x = identity.public_key.x ?? "";
  return {
    ...identity,
    fingerprint: createHash("sha256").update(x).digest("hex").slice(0, 16),
  };
}

function hostName(): string {
  try {
    const os = require("node:os") as typeof import("node:os");
    return os.hostname();
  } catch {
    return "unknown";
  }
}
