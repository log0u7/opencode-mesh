import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openSqlite, type SqliteConn } from "./sqlite.js";

export type MeshDb = {
  conn: SqliteConn;
  close(): void;
};

// Bump when a schema change needs a migration step; the version anchors future
// migrations that cannot be expressed as idempotent `CREATE ... IF NOT EXISTS`.
const SCHEMA_VERSION = 11;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peers (
  node_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  addresses TEXT NOT NULL DEFAULT '[]',
  paired INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  public_key TEXT,
  last_seen INTEGER NOT NULL,
  tls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  origin_id TEXT,
  from_node TEXT NOT NULL,
  from_box TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  wake INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unread',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mailboxes (
  name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT,
  pools TEXT NOT NULL DEFAULT '[]',
  bind_key TEXT,
  primary_pool TEXT,
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  to_box TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  created_at INTEGER NOT NULL
);
-- v10: sender-side re-send defense (0.20.0). Pure addition: an existing v9
-- database is brought up by the idempotent SCHEMA re-run, no guarded ALTER.
CREATE TABLE IF NOT EXISTS recent_mails (
  hash TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  message_id TEXT NOT NULL
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
  finished_at INTEGER,
  mailbox TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_tokens_created ON pending_tokens(created_at);
CREATE INDEX IF NOT EXISTS idx_peers_token ON peers(token);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);
`;

const INDEXES_V3 = `
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_deliveries_box_status ON deliveries(to_box, status);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id);
`;

function migrate(conn: SqliteConn): void {
  const current = conn.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) {
    return;
  }
  // Every statement in SCHEMA is idempotent, so a version-0 database (fresh or
  // pre-versioning) is brought up to date by re-running it.
  conn.exec(SCHEMA);
  // v2: pairing proofs are verified against a pinned public key, so peers gain
  // the column. ALTER TABLE is not idempotent: guard it on the live schema.
  const peerColumns = conn.all<{ name: string }>("PRAGMA table_info(peers)").map((row) => row.name);
  if (!peerColumns.includes("public_key")) {
    conn.exec("ALTER TABLE peers ADD COLUMN public_key TEXT");
  }
  // v7: peers.tls — new pairings speak TLS on the mesh port; discovered peers
  // carry the flag their mDNS record advertised.
  if (!peerColumns.includes("tls")) {
    conn.exec("ALTER TABLE peers ADD COLUMN tls INTEGER NOT NULL DEFAULT 0");
  }
  // v3: named mailboxes. messages gains from_box/reply_to; guarded ALTERs for
  // databases created before v3 (fresh installs already have the columns).
  const messageColumns = conn
    .all<{ name: string }>("PRAGMA table_info(messages)")
    .map((row) => row.name);
  if (!messageColumns.includes("from_box")) {
    conn.exec("ALTER TABLE messages ADD COLUMN from_box TEXT");
  }
  if (!messageColumns.includes("reply_to")) {
    conn.exec("ALTER TABLE messages ADD COLUMN reply_to TEXT");
  }
  // v4: mailboxes.bind_key (instance binding for restart-proof wake).
  const mailboxColumns = conn
    .all<{ name: string }>("PRAGMA table_info(mailboxes)")
    .map((row) => row.name);
  if (!mailboxColumns.includes("bind_key")) {
    conn.exec("ALTER TABLE mailboxes ADD COLUMN bind_key TEXT");
  }
  // v5: messages.origin_id (cross-host broadcast dedup).
  if (!messageColumns.includes("origin_id")) {
    conn.exec("ALTER TABLE messages ADD COLUMN origin_id TEXT");
  }
  // v9: messages.wake — a deliberate broadcast (mesh_send wake:true) wakes its
  // recipients even though it is a pool fanout (Slack model, 0.17.0). The
  // messages table is never rebuilt (the v6 rebuild only touches mailboxes),
  // so a guarded ALTER here cannot be lost to a later rebuild in this pass.
  if (!messageColumns.includes("wake")) {
    conn.exec("ALTER TABLE messages ADD COLUMN wake INTEGER NOT NULL DEFAULT 0");
  }
  // v6: mailboxes loses UNIQUE(session_id) — a session may own several boxes
  // (one TUI, several agent hats). SQLite cannot drop a constraint: rebuild.
  const mailboxesSql =
    conn.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mailboxes'",
    )?.sql ?? "";
  if (mailboxesSql.includes("session_id TEXT NOT NULL UNIQUE")) {
    conn.exec(
      "CREATE TABLE mailboxes_new (name TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT, pools TEXT NOT NULL DEFAULT '[]', bind_key TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL)",
    );
    conn.exec(
      "INSERT INTO mailboxes_new SELECT name, session_id, role, pools, bind_key, last_seen, created_at FROM mailboxes",
    );
    conn.exec("DROP TABLE mailboxes");
    conn.exec("ALTER TABLE mailboxes_new RENAME TO mailboxes");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_mailboxes_session ON mailboxes(session_id)");
  }
  // v8: mailboxes.primary_pool — the box's declared primary group; the lead of
  // that pool receives its enrollment confirmation. Checked AFTER the v6
  // rebuild above: a rebuilt table carries only the pre-v6 columns.
  const mailboxColumnsLive = conn
    .all<{ name: string }>("PRAGMA table_info(mailboxes)")
    .map((row) => row.name);
  if (!mailboxColumnsLive.includes("primary_pool")) {
    conn.exec("ALTER TABLE mailboxes ADD COLUMN primary_pool TEXT");
  }
  // v11: workers.mailbox — marks an enrolled spawn (0.23.0): the worker was
  // born a fleet agent with a mailbox name, so the reaper can leave its pools.
  // Pure addition, guarded ALTER like peers.public_key.
  const workerColumns = conn
    .all<{ name: string }>("PRAGMA table_info(workers)")
    .map((row) => row.name);
  if (!workerColumns.includes("mailbox")) {
    conn.exec("ALTER TABLE workers ADD COLUMN mailbox TEXT");
  }
  conn.exec(INDEXES_V3);
  conn.exec("CREATE INDEX IF NOT EXISTS idx_messages_origin ON messages(origin_id);");
  conn.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function openMeshDb(path: string): MeshDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const conn = openSqlite(path);
  conn.run("PRAGMA journal_mode = WAL");
  conn.run("PRAGMA busy_timeout = 5000");
  migrate(conn);

  return { conn, close: () => conn.close() };
}
