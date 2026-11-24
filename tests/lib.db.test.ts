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
    expect(version).toBeGreaterThanOrEqual(2);
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

  it("stores the pinned pairing public key on peers", () => {
    const db = openMeshDb(":memory:");
    const columns = db.conn
      .all<{ name: string }>("PRAGMA table_info(peers)")
      .map((row) => row.name);
    expect(columns).toContain("public_key");
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
      expect(db.conn.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(10);
      const names = db.conn
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .map((row) => row.name);
      expect(names).toContain("idx_locks_expires");
      const columns = db.conn
        .all<{ name: string }>("PRAGMA table_info(peers)")
        .map((row) => row.name);
      expect(columns).toContain("public_key");
      expect(columns).toContain("tls");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a v1 database (peers without the public_key column) in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-db-"));
    const file = join(dir, "v1.db");
    try {
      const v1 = openSqlite(file);
      v1.exec(SCHEMA_V1);
      v1.close();

      const db = openMeshDb(file);
      expect(db.conn.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(10);
      const columns = db.conn
        .all<{ name: string }>("PRAGMA table_info(peers)")
        .map((row) => row.name);
      expect(columns).toContain("public_key");
      expect(columns).toContain("tls");
      db.close();

      // Reopening an already-current database must be a no-op: no second
      // migration pass, no version churn.
      const reopened = openMeshDb(file);
      expect(reopened.conn.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
        10,
      );
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // v6 rebuilds the mailboxes table (UNIQUE(session_id) drop); the later
  // primary_pool ALTER must survive that rebuild — a pre-v6 database carries
  // no such column and the rebuilt table would silently lose it.
  it("adds primary_pool to a UNIQUE-constrained mailboxes table rebuilt from pre-v6", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-db-"));
    const file = join(dir, "v6.db");
    try {
      const v6 = openSqlite(file);
      v6.exec(`
        CREATE TABLE mailboxes (name TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, role TEXT,
          pools TEXT NOT NULL DEFAULT '[]', bind_key TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO mailboxes (name, session_id, role, pools, bind_key, last_seen, created_at)
          VALUES ('alice', 's1', NULL, '[]', NULL, 1, 1);
        PRAGMA user_version = 6;
      `);
      v6.close();

      const db = openMeshDb(file);
      const columns = db.conn
        .all<{ name: string }>("PRAGMA table_info(mailboxes)")
        .map((row) => row.name);
      expect(columns).toContain("primary_pool");
      expect(db.conn.get<{ name: string }>("SELECT name FROM mailboxes")?.name).toBe("alice");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // v9 adds messages.wake (0.17.0 Slack-model flag). The messages table is
  // never rebuilt, so the guarded ALTER must land on a pre-v9 messages table
  // and keep its rows.
  it("adds wake to a pre-v9 messages table in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-db-"));
    const file = join(dir, "v8.db");
    try {
      const v8 = openSqlite(file);
      v8.exec(`
        CREATE TABLE messages (id TEXT PRIMARY KEY, origin_id TEXT, from_node TEXT NOT NULL,
          from_box TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT,
          status TEXT NOT NULL DEFAULT 'unread', created_at INTEGER NOT NULL);
        INSERT INTO messages (id, origin_id, from_node, subject, body, status, created_at)
          VALUES ('m1', NULL, 'n1', 's', 'b', 'unread', 1);
        PRAGMA user_version = 8;
      `);
      v8.close();

      const db = openMeshDb(file);
      expect(db.conn.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(10);
      const columns = db.conn
        .all<{ name: string }>("PRAGMA table_info(messages)")
        .map((row) => row.name);
      expect(columns).toContain("wake");
      const row = db.conn.get<{ wake: number }>("SELECT wake FROM messages WHERE id = 'm1'");
      expect(row?.wake).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The 0.3.0 schema: indexed, versioned at 1, no public_key column yet.
const SCHEMA_V1 = `
CREATE TABLE peers (node_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, fingerprint TEXT NOT NULL,
  addresses TEXT NOT NULL DEFAULT '[]', paired INTEGER NOT NULL DEFAULT 0, token TEXT, last_seen INTEGER NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, from_node TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unread', created_at INTEGER NOT NULL);
CREATE TABLE locks (path TEXT PRIMARY KEY, owner_node TEXT NOT NULL, owner_session TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE pending_tokens (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE workers (id TEXT PRIMARY KEY, task TEXT NOT NULL, worktree_path TEXT NOT NULL, branch TEXT NOT NULL,
  pid INTEGER, session_id TEXT, status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER,
  started_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX idx_messages_status_created ON messages(status, created_at);
CREATE INDEX idx_pending_tokens_created ON pending_tokens(created_at);
CREATE INDEX idx_peers_token ON peers(token);
CREATE INDEX idx_workers_status ON workers(status);
CREATE INDEX idx_locks_expires ON locks(expires_at);
PRAGMA user_version = 1;
`;
