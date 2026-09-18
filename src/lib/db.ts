import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openSqlite, type SqliteConn } from "./sqlite.js";

export type MeshDb = {
  conn: SqliteConn;
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peers (
  node_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  addresses TEXT NOT NULL DEFAULT '[]',
  paired INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  path TEXT PRIMARY KEY,
  owner_node TEXT NOT NULL,
  owner_session TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_tokens (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  pid INTEGER,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
`;

export function openMeshDb(path: string): MeshDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const conn = openSqlite(path);
  conn.run("PRAGMA journal_mode = WAL");
  conn.run("PRAGMA busy_timeout = 5000");
  conn.exec(SCHEMA);

  return { conn, close: () => conn.close() };
}
