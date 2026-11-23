import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { MeshDb } from "./db.js";
import type { NodeIdentity } from "./identity.js";
import { pairingProof } from "./identity.js";
import { listPeers, resolvePeerTarget } from "./peers.js";
import { pushMemorySync } from "./client.js";

/**
 * The filesystem contract of cross-host memory sync. The mesh is the transport and
 * never parses the payload: the opencode-memory plugin (the content side) writes its
 * shareable export to the outbox file, this plugin pushes those bytes to every paired
 * peer's /memory-sync endpoint, and the peer's memory plugin imports them during its
 * housekeeping sweep. The two plugins never import each other — these paths are the
 * whole interface:
 *
 *   <dataDir>/memory-sync/outbox/shareable.jsonl   what our memory plugin exports
 *   <dataDir>/memory-sync/inbox/<from-node>.jsonl  what peers push to us
 */

export function outboxFile(dataDir: string): string {
  return join(dataDir, "memory-sync", "outbox", "shareable.jsonl");
}

export function inboxDir(dataDir: string): string {
  return join(dataDir, "memory-sync", "inbox");
}

/** The node id doubles as a filename: only the pairing-minted charset may pass
 * (UUIDs qualify). Anything else is refused before it can reach the filesystem. */
export function isInboxNodeName(nodeId: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(nodeId);
}

/**
 * Store a peer's pushed JSONL as `inbox/<node id>.jsonl`, replacing any earlier file
 * from the same peer: the outbox is a full snapshot of the peer's shareable entries,
 * and the importing side is idempotent per entry id. Atomic (tmp + rename, 0600) so a
 * concurrent import reads either the previous or the new file, never a partial one.
 * Returns the number of bytes accepted.
 */
export function receiveMemorySync(dataDir: string, fromNodeId: string, body: string): number {
  if (!isInboxNodeName(fromNodeId)) {
    throw new Error(`refusing node id as inbox filename: ${fromNodeId.slice(0, 16)}`);
  }
  const target = join(inboxDir(dataDir), `${fromNodeId}.jsonl`);
  mkdirSync(inboxDir(dataDir), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The tmp file may not exist yet: the original failure is the one to report.
    }
    throw error;
  }
  return Buffer.byteLength(body);
}

export type SyncPushResult = {
  node_id: string;
  outcome: "ok" | "unreachable" | "unauthorized" | "error" | "skipped";
  bytes: number;
};

export type SyncPushState = {
  /** Outbox mtime already delivered to every paired peer; -1 = nothing yet. */
  lastPushedMtimeMs: number;
};

/** Transport seam for tests: the real default POSTs over the peer's TLS connection. */
export type SyncPost = typeof pushMemorySync;

/**
 * One push cycle: when the outbox exists and changed since the last fully-delivered
 * push, POST its bytes to every paired peer. The stamp only advances when every peer
 * accepted the payload (or when there is nothing to push to), so a peer that was down
 * catches up on the next cycle instead of missing the snapshot forever — duplicates
 * on the receiving side are free, the import is idempotent. An unchanged outbox with
 * no paired peers stays un-stamped: the first pairing must push the existing outbox.
 */
export async function pushOutbox(options: {
  dataDir: string;
  db: MeshDb;
  identity: NodeIdentity;
  state: SyncPushState;
  post?: SyncPost;
}): Promise<SyncPushResult[]> {
  const post = options.post ?? pushMemorySync;
  const path = outboxFile(options.dataDir);
  let stat: { mtimeMs: number };
  let body: string;
  try {
    stat = statSync(path);
    body = readFileSync(path, "utf8");
  } catch {
    // No outbox yet: the memory plugin has not exported anything shareable.
    return [];
  }
  if (stat.mtimeMs === options.state.lastPushedMtimeMs) {
    return [];
  }

  const targets = listPeers(options.db)
    .filter((peer) => peer.paired)
    .flatMap((peer) => {
      const target = resolvePeerTarget(options.db, peer.node_id);
      return target === null ? [] : [{ node_id: peer.node_id, token: peer.token ?? "", ...target }];
    });
  if (targets.length === 0) {
    return [];
  }

  const results: SyncPushResult[] = [];
  for (const target of targets) {
    const outcome = await post({
      url: target.url,
      token: target.token,
      from: options.identity.node_id,
      // Same proof the mail sends carry: lets the peer's first accept bind the
      // pairing token (the legacy/code pairings leave the tokens asymmetric).
      proof: pairingProof(options.identity, target.token),
      ...(target.tls ? { tls: true } : {}),
      ...(target.pk !== null ? { pk: target.pk } : {}),
      body,
    });
    results.push({ node_id: target.node_id, outcome, bytes: Buffer.byteLength(body) });
  }
  if (results.every((result) => result.outcome === "ok")) {
    options.state.lastPushedMtimeMs = stat.mtimeMs;
  }
  return results;
}

export type MemorySyncPusher = { stop: () => void };

/** The plugin-side loop: one push at boot, then every `intervalMs`. intervalMs <= 0
 * disables the loop entirely (0 = off). The timer never holds the process open. */
export function startMemorySyncPusher(options: {
  dataDir: string;
  db: MeshDb;
  identity: NodeIdentity;
  intervalMs: number;
  post?: SyncPost;
}): MemorySyncPusher {
  if (options.intervalMs <= 0) {
    return { stop: () => {} };
  }
  const state: SyncPushState = { lastPushedMtimeMs: -1 };
  const cycle = (): void => {
    void pushOutbox({
      dataDir: options.dataDir,
      db: options.db,
      identity: options.identity,
      state,
      ...(options.post !== undefined ? { post: options.post } : {}),
    }).catch(() => {});
  };
  cycle();
  const timer = setInterval(cycle, options.intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
