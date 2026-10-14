import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { openSqlite } from "../src/lib/sqlite.js";

// The pre-versioning schema: tables only, no indexes, user_version left at 0.
const LEGACY_SCHEMA = `
CREATE TABLE peers (node_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, fingerprint TEXT NOT NULL,
  addresses TEXT NOT NULL DEFAULT '[]', paired INTEGER NOT NULL DEFAULT 0, token TEXT, last_seen INTEGER NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, from_node TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unread', created_at INTEGER NOT NULL);
CREATE TABLE locks (path TEXT PRIMARY KEY, owner_node TEXT NOT NULL, owner_session TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE pending_tokens (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE workers (id TEXT PRIMARY KEY, task TEXT NOT NULL, worktree_path TEXT NOT NULL, branch TEXT NOT NULL,
  pid INTEGER, session_id TEXT, status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER,
  started_at INTEGER NOT NULL, finished_at INTEGER);
`;

describe("mesh database schema", () => {
  it("records the schema version", () => {
    const db = openMeshDb(":memory:");
    const version = db.conn.get<{ user_version: number }>("PRAGMA user_version")?.user_version;
    expect(version).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("creates the query indexes for the hot lookups", () => {
    const db = openMeshDb(":memory:");
    const names = db.conn
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "idx_messages_status_created",
        "idx_pending_tokens_created",
        "idx_peers_token",
        "idx_workers_status",
        "idx_locks_expires",
      ]),
    );
    db.close();
  });

  it("upgrades a pre-versioning database in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-db-"));
    const file = join(dir, "legacy.db");
    try {
      const legacy = openSqlite(file);
      legacy.exec(LEGACY_SCHEMA);
      legacy.close();

      const db = openMeshDb(file);
      expect(db.conn.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
      const names = db.conn
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .map((row) => row.name);
      expect(names).toContain("idx_locks_expires");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
