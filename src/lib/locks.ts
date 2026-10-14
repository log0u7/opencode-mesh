import type { MeshDb } from "./db.js";
import type { Lock } from "../types/peer.js";

export function tryLock(
  db: MeshDb,
  input: { path: string; owner_node: string; owner_session: string; ttl_ms: number; now: number },
): boolean {
  const expiresAt = input.now + input.ttl_ms;

  db.conn.run("DELETE FROM locks WHERE expires_at <= ?", [input.now]);

  // Claim atomically: a second opencode process sharing this dataDir that races
  // for the same path loses the insert (ON CONFLICT DO NOTHING) instead of
  // throwing a UNIQUE constraint error out of mesh_lock.
  db.conn.run(
    "INSERT INTO locks (path, owner_node, owner_session, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING",
    [input.path, input.owner_node, input.owner_session, expiresAt],
  );
  const claimed =
    (db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) > 0;
  if (claimed) {
    return true;
  }

  const existing = db.conn.get<LockRow>("SELECT * FROM locks WHERE path = ?", [input.path]);
  if (!existing) {
    // Raced with a release between the insert and this read; not granted.
    return false;
  }
  if (existing.owner_node === input.owner_node) {
    // Same owner refreshes its claim.
    db.conn.run("UPDATE locks SET expires_at = ?, owner_session = ? WHERE path = ?", [
      expiresAt,
      input.owner_session,
      input.path,
    ]);
    return true;
  }
  return false;
}

export function releaseLock(db: MeshDb, input: { path: string; owner_node: string }): boolean {
  db.conn.run("DELETE FROM locks WHERE path = ? AND owner_node = ?", [
    input.path,
    input.owner_node,
  ]);
  return (db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) > 0;
}

export function listLocks(db: MeshDb, query: { now: number }): Lock[] {
  db.conn.run("DELETE FROM locks WHERE expires_at <= ?", [query.now]);
  return db.conn.all<LockRow>("SELECT * FROM locks ORDER BY path").map(rowToLock);
}

type LockRow = {
  path: string;
  owner_node: string;
  owner_session: string;
  expires_at: number;
};

function rowToLock(row: LockRow): Lock {
  return {
    path: row.path,
    owner: row.owner_session,
    node_id: row.owner_node,
    expires_at: row.expires_at,
  };
}
