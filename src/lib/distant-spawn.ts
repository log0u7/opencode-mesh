import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { pairingProof, signPayload, verifyPayload, type NodeIdentity } from "./identity.js";
import type { MeshDb } from "./db.js";
import { createWorkerWorktree, removeWorkerWorktree, type WorktreeClient } from "./worktree.js";
import { runWorker, type SpawnFn } from "./spawn.js";
import type { Worker } from "./workers.js";
import { findPeerById, resolvePeerTarget } from "./peers.js";
import { sendMail } from "./client.js";

// Distant spawn (0.24.0): mesh_spawn(node=<peer>) births an enrolled fleet
// agent ON a paired peer. The request travels on the peer's /spawn endpoint,
// authenticated by the pairing token AND signed with the parent's node key —
// the peer verifies the signature against the key it PINNED at pairing
// (never TOFU: a peer row without a pinned key refuses, the 0.18.0 lesson).

export type SpawnSpec = {
  task: string;
  name: string;
  role: string;
  pools: string[];
};

export type SpawnRequestBody = {
  spec: SpawnSpec;
  /** The requesting node's id — must match the authenticated pairing peer. */
  from: string;
  /** The parent's mailbox on its own host; the ack DM targets it. */
  from_box?: string;
  /** Anti-replay pair: the nonce is unique per request. */
  nonce: string;
  /** Epoch ms of the signature; outside the window the request dies. */
  ts: number;
  /** base64 Ed25519 over spawnRequestPayload(spec, from, nonce, ts). */
  sig: string;
  /** Standard pairing proof, for the token-bind path (same as /mail). */
  proof?: string;
};

// Anti-replay window: a request older than 5 minutes is refused even with a
// valid signature (a captured body is worthless past the window).
export const SPAWN_REQUEST_TTL_MS = 5 * 60_000;

// Per-peer concurrency quota on the receiving host: max enrolled workers with
// a RUNNING status spawned by ONE requesting peer. The operator raises it with
// spawnQuotaPeer; the default stays tight (deny-by-default posture).
export const DEFAULT_SPAWN_QUOTA_PEER = 2;

// The canonical signature payload: deterministic on both sides (the receiver
// rebuilds it from its own parse — the same fixed key order). Mirrors the
// pairing-proof pattern: a versioned prefix, then the exact signed fields.
export function spawnRequestPayload(
  spec: SpawnSpec,
  from: string,
  nonce: string,
  ts: number,
): string {
  return `opencode-mesh-spawn:${from}:${nonce}:${ts}:${JSON.stringify(spec)}`;
}

// Parent side: serialize the request and sign it with the node key.
export function buildSpawnRequest(
  identity: Pick<NodeIdentity, "node_id" | "public_key" | "private_key">,
  input: { spec: SpawnSpec; from_box?: string; now?: number },
): string {
  const ts = input.now ?? Date.now();
  const nonce = randomUUID();
  const body: SpawnRequestBody = {
    spec: input.spec,
    from: identity.node_id,
    ...(input.from_box !== undefined ? { from_box: input.from_box } : {}),
    nonce,
    ts,
    sig: signPayload(
      identity.private_key,
      spawnRequestPayload(input.spec, identity.node_id, nonce, ts),
    ),
  };
  return JSON.stringify(body);
}

// The exact body shape the receiver accepts. Every field is type-checked:
// a malformed request dies before any auth machinery runs.
export function parseSpawnRequest(raw: string): SpawnRequestBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const spec = body.spec as Record<string, unknown> | undefined;
  if (
    typeof body.from !== "string" ||
    body.from.length === 0 ||
    typeof body.nonce !== "string" ||
    body.nonce.length === 0 ||
    typeof body.ts !== "number" ||
    typeof body.sig !== "string" ||
    body.sig.length === 0 ||
    typeof spec !== "object" ||
    spec === null ||
    typeof spec.task !== "string" ||
    spec.task.length === 0 ||
    typeof spec.name !== "string" ||
    typeof spec.role !== "string" ||
    !Array.isArray(spec.pools) ||
    !spec.pools.every((p): p is string => typeof p === "string")
  ) {
    return null;
  }
  return {
    spec: {
      task: spec.task,
      name: spec.name,
      role: spec.role,
      pools: spec.pools.filter((p) => p.length > 0),
    },
    from: body.from,
    ...(typeof body.from_box === "string" && body.from_box.length > 0
      ? { from_box: body.from_box }
      : {}),
    nonce: body.nonce,
    ts: body.ts,
    sig: body.sig,
    ...(typeof body.proof === "string" ? { proof: body.proof } : {}),
  };
}

// Receiver-side cryptographic checks, against the PINNED key only:
// - a peer row without a pinned public_key is refused (no TOFU on a
//   token-authenticated channel: an unpinned row would accept any signer),
// - a timestamp outside the window is refused (anti-replay, half 1: staleness),
// - the signature must verify against the pinned key (half 2: the replay store
//   in serve.ts refuses a nonce already seen).
// Returns the refusal message, or null when the request is authentic.
export function verifySpawnRequest(
  peer: { public_key: string | null } | null,
  body: SpawnRequestBody,
  now: number,
): string | null {
  if (peer === null || peer.public_key === null) {
    return "spawn refused: peer has no pinned key (re-pair with mesh_pair)";
  }
  if (Math.abs(now - body.ts) > SPAWN_REQUEST_TTL_MS) {
    return "spawn refused: stale request (outside the 5 min window)";
  }
  const payload = spawnRequestPayload(body.spec, body.from, body.nonce, body.ts);
  if (!verifyPayload(peer.public_key, payload, body.sig)) {
    return "spawn refused: invalid signature";
  }
  return null;
}

// Anti-replay, half 2: claimed (from, nonce) pairs live in the mesh db
// (spawn_nonces, v13), so a receiver restart no longer re-opens the 5 min
// replay window. Claimed AFTER the signature verifies, so an attacker cannot
// burn a victim's nonce with garbage signatures. Stale rows are purged at
// every claim; the nonce is a UUID minted by the parent and the signature
// binds it to `from`, so the nonce alone keys the table.
export type SpawnReplayStore = {
  claim(from: string, nonce: string, now: number): boolean;
};

export function createDbSpawnReplayStore(db: MeshDb): SpawnReplayStore {
  return {
    claim(_from: string, nonce: string, now: number): boolean {
      db.conn.run("DELETE FROM spawn_nonces WHERE ts <= ?", [now - SPAWN_REQUEST_TTL_MS]);
      if (db.conn.get("SELECT nonce FROM spawn_nonces WHERE nonce = ?", [nonce]) !== null) {
        return false;
      }
      db.conn.run("INSERT INTO spawn_nonces (nonce, ts) VALUES (?, ?)", [nonce, now]);
      return true;
    },
  };
}

// The enrolled-spawn spec is re-validated on the receiver: it feeds the enroll
// header (mesh_register/mesh_join lines) and names a worktree, so it must
// satisfy the same rules the parent's mesh_spawn applies. Both sides run this
// before any worktree work. Control characters are refused outright: the role
// and the pools are interpolated line-by-line into the enroll header.
const hasControlChar = (s: string): boolean =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

export function validateSpawnSpec(spec: Pick<SpawnSpec, "name" | "role" | "pools">): string | null {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(spec.name)) {
    return "spawn refused: invalid name (1-64 chars of letters, digits, . _ -)";
  }
  if (
    typeof spec.role !== "string" ||
    spec.role.length === 0 ||
    spec.role.length > 64 ||
    hasControlChar(spec.role)
  ) {
    return "spawn refused: invalid role (non-empty, max 64 chars, no control characters)";
  }
  if (
    !Array.isArray(spec.pools) ||
    spec.pools.length > 8 ||
    !spec.pools.every(
      (p) => typeof p === "string" && p.length > 0 && p.length <= 64 && !hasControlChar(p),
    )
  ) {
    return "spawn refused: invalid pools (max 8, each non-empty, max 64 chars, no control characters)";
  }
  return null;
}

// A failure cause that is NEVER empty: an Error with an empty message (a bare
// `new Error()`, an aborted fetch in some runtimes) used to leave the parent
// with the bare "spawn failed: " seen live (0.24.5) and the peer without a
// diagnosable trace.
export function spawnCause(error: unknown): string {
  const empty = "unknown error (no message)";
  if (error instanceof Error) {
    if (error.message.length > 0) {
      return error.message;
    }
    return error.name.length > 0 ? `${error.name} (no message)` : empty;
  }
  if (typeof error === "string") {
    return error.length > 0 ? error : empty;
  }
  const text = String(error).trim();
  return text.length > 0 ? text : empty;
}

export type DistantSpawnDeps = {
  db: MeshDb;
  dataDir: string;
  /** Node identity for the ack DM: it signs a pairing proof with the node key. */
  identity: Pick<NodeIdentity, "node_id" | "hostname" | "public_key" | "private_key">;
  worktreeClient: WorktreeClient;
  spawnFn: SpawnFn;
};

export type DistantSpawnResult = { ok: true; worker: Worker } | { ok: false; error: string };

// The peer executes ITS OWN local enrolled-spawn path (the 0.23.0 machinery,
// runWorker: worktree named after the mailbox, the enrolled child env, the
// self-enroll header, logs, session capture, exit tracking). The worker row is
// stamped with the requesting peer so the per-peer quota can count it.
// Failure cleans the worktree like mesh_spawn does.
export async function runDistantSpawn(
  deps: DistantSpawnDeps,
  body: SpawnRequestBody,
): Promise<DistantSpawnResult> {
  const specError = validateSpawnSpec(body.spec);
  if (specError !== null) {
    return { ok: false, error: specError };
  }
  const enroll = { name: body.spec.name, role: body.spec.role, pools: body.spec.pools };
  let directory: string | undefined;
  try {
    const info = await createWorkerWorktree(deps.worktreeClient, { name: enroll.name });
    directory = info.directory;
    const worker = runWorker(deps.db, deps.dataDir, {
      task: body.spec.task,
      worktree_path: info.directory,
      branch: info.branch ?? info.name ?? basename(info.directory),
      enroll,
      spawnFn: deps.spawnFn,
      spawned_by: body.from,
    });
    if (worker.status === "failed") {
      // The child never ran: clean up exactly like mesh_spawn (worktree, row,
      // log) so the peer is not left with a stranded directory.
      const cleaned = await removeWorkerWorktree(deps.worktreeClient, {
        directory: info.directory,
      }).catch(() => false);
      deps.db.conn.run("DELETE FROM workers WHERE id = ?", [worker.id]);
      if (!cleaned) {
        return {
          ok: false,
          error: `spawn failed: the worker did not start; worktree ${info.directory} may be stranded`,
        };
      }
      return { ok: false, error: "spawn failed: the worker process did not start" };
    }
    return { ok: true, worker };
  } catch (error) {
    if (directory !== undefined) {
      await removeWorkerWorktree(deps.worktreeClient, { directory }).catch(() => false);
    }
    return { ok: false, error: `spawn failed: ${spawnCause(error)}` };
  }
}

// The self-enroll header text lives in src/lib/spawn.ts (enrollHeader) and is
// applied by runWorker itself: this module only feeds the enroll identity, it
// never re-serializes the prompt.

// Ack DM back to the parent (best effort): the spawned worker posts its own
// status: to the pools like any agent; this ack just closes the spawn call.
// Skipped when the parent shared no mailbox or no reachable address.
export async function ackSpawned(
  deps: DistantSpawnDeps,
  body: SpawnRequestBody,
  workerId: string,
): Promise<boolean> {
  if (body.from_box === undefined) {
    return false;
  }
  const conn = resolvePeerTarget(deps.db, body.from);
  if (conn === null) {
    return false;
  }
  const peerRow = findPeerById(deps.db, body.from);
  if (peerRow === null || peerRow.token === null) {
    return false;
  }
  // A TLS peer without a pinned key must not receive anything on a
  // token-authenticated channel (the mesh_send rule); the ack is skippable.
  if (conn.tls && conn.pk === null) {
    return false;
  }
  const result = await sendMail({
    url: conn.url,
    ...(conn.tls ? { tls: true } : {}),
    ...(conn.pk !== null ? { pk: conn.pk } : {}),
    token: peerRow.token,
    from: deps.identity.node_id,
    to: body.from_box,
    subject: `spawned: ${body.spec.name}`,
    body: `spawned ${body.spec.name} on ${deps.identity.hostname} (worker ${workerId})`,
    proof: pairingProof(deps.identity, peerRow.token),
  });
  return result === "ok";
}
