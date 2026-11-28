import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openSqlite, type SqliteConn } from "./sqlite.js";

export type MeshDb = {
  conn: SqliteConn;
  /** The store file path (the plugin log lives beside it). */
  path: string;
  /** Rebuild the underlying connection in place: the recovery for a leaked
   * transaction (the frozen-WAL-snapshot class) and a failed rollback. */
  reopen(): void;
  close(): void;
};

// Bump when a schema change needs a migration step; the version anchors future
// migrations that cannot be expressed as idempotent `CREATE ... IF NOT EXISTS`.
const SCHEMA_VERSION = 26;

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
  task_id TEXT,
  flash_count INTEGER NOT NULL DEFAULT 0,
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
  mailbox TEXT,
  spawned_by TEXT,
  spawn_mode TEXT NOT NULL DEFAULT 'worktree'
);
-- v13: distant-spawn nonces are persisted (0.24.1): a receiver restart no
-- longer re-opens the 5 min replay window.
CREATE TABLE IF NOT EXISTS spawn_nonces (
  nonce TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
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
  // v15: mailboxes.node_id — the registry federation (0.30.0): NULL = this
  // node owns the box; a node id = a FEDERATED row (the remote registry
  // pushed at its rebind). Federated boxes resolve mesh_send addressing
  // cross-node but are never woken (their session_id is foreign).
  if (!mailboxColumns.includes("node_id")) {
    conn.exec("ALTER TABLE mailboxes ADD COLUMN node_id TEXT");
  }
  // v16: mailboxes.registered_at — the LWW version for the federation merge
  // (the ownership conflict resolves on (registered_at, node_id); NULL =
  // unknown age, backfilled from created_at so existing rows keep their age).
  if (!mailboxColumns.includes("registered_at")) {
    conn.exec("ALTER TABLE mailboxes ADD COLUMN registered_at INTEGER");
    conn.exec("UPDATE mailboxes SET registered_at = created_at WHERE registered_at IS NULL");
  }
  // v17: deliveries.flashed_at — the flash single-flight (0.32.0). The claim
  // "this delivery has been announced to its session" lives in the SHARED
  // database instead of per-instance memory (two plugin instances' wake
  // loops could not see each other's pendingPrompt maps: the double-flash
  // class — 6admin re-prompted 13s apart, two identical replies). NULL =
  // never flashed.
  const deliveryColumns = conn
    .all<{ name: string }>("PRAGMA table_info(deliveries)")
    .map((row) => row.name);
  if (!deliveryColumns.includes("flashed_at")) {
    conn.exec("ALTER TABLE deliveries ADD COLUMN flashed_at INTEGER");
  } // v26: deliveries.task_id + deliveries.flash_count (the 0.33.4): the
  // task avis link (the flash consumes, mesh_tasks marks read) and the
  // PERSISTED fatigue (the reclaim window doubles per flash, the state
  // survives the restarts — the in-memory mute maps are gone).
  if (!deliveryColumns.includes("task_id")) {
    conn.exec("ALTER TABLE deliveries ADD COLUMN task_id TEXT");
  }
  if (!deliveryColumns.includes("flash_count")) {
    conn.exec("ALTER TABLE deliveries ADD COLUMN flash_count INTEGER NOT NULL DEFAULT 0");
  }
  // v22: mailboxes.epoch — the LOGICAL clock per name (the refonte 3.2):
  // incremented at each rebind, replaces registered_at (wall clock, the
  // clock-skew class) in the federation LWW. Legacy rows backfill to 1.
  if (!mailboxColumns.includes("epoch")) {
    conn.exec("ALTER TABLE mailboxes ADD COLUMN epoch INTEGER");
    conn.exec("UPDATE mailboxes SET epoch = 1 WHERE epoch IS NULL");
  }
  // v18: messages.kind — notify (wakes per the wake rules) vs fyi (never
  // wakes: read at the next drain or flash). Legacy rows read as notify.
  if (!messageColumns.includes("kind")) {
    conn.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'notify'");
  }
  // v19: tasks — the A2A task lifecycle (the refonte P2): mesh_ask submits,
  // the responder mesh_reply's, the correlation is server-side (the asker's
  // notification fires on terminal/input_required states only). group_id
  // batches a collective ask into ONE digest.
  // v20: the outbox (the refonte P2.6) — mesh_send writes and returns
  // "queued"; the background sender delivers with ack and retries with
  // backoff. The agent never sees "unreachable" again.
  const outboxColumns = conn.all<{ name: string }>("PRAGMA table_info(outbox)").map((r) => r.name);
  if (outboxColumns.length === 0) {
    conn.exec(`
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_outbox_state_next ON outbox(state, next_at);
    `);
  }
  // v24: outbox.origin_id + the index (the refonte2-P1): the /ack resolves
  // WITHOUT the full json_extract scan, and the mark filters the node.
  if (!outboxColumns.includes("origin_id")) {
    conn.exec("ALTER TABLE outbox ADD COLUMN origin_id TEXT");
    conn.exec("UPDATE outbox SET origin_id = json_extract(payload, '$.origin_id')");
    conn.exec("CREATE INDEX idx_outbox_origin ON outbox(origin_id)");
  }
  // v21: the board (the refonte P4) — the SHARED status state, not DMs:
  // box + key + value, the keys fixed (task/blocker/state/eta), written
  // WITHOUT waking anyone, read compactly by whoever needs it.
  const boardColumns = conn.all<{ name: string }>("PRAGMA table_info(board)").map((r) => r.name);
  if (boardColumns.length === 0) {
    conn.exec(`
      CREATE TABLE board (
        box TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (box, key)
      );
    `);
  }
  // The columns read BEFORE the create (the emptiness gate), re-read AFTER
  // it (the 0.33.3): a fresh table ships the new columns — the stale empty
  // array would ALTER them into duplicates.
  let taskColumns = conn.all<{ name: string }>("PRAGMA table_info(tasks)").map((r) => r.name);
  if (taskColumns.length === 0) {
    conn.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        from_box TEXT,
        to_box TEXT NOT NULL,
        group_id TEXT,
        question TEXT NOT NULL,
        result TEXT,
        state TEXT NOT NULL DEFAULT 'submitted',
        target_node TEXT,
        asker_node TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deadline INTEGER
      );
      CREATE INDEX idx_tasks_to_state ON tasks(to_box, state);
      CREATE INDEX idx_tasks_group ON tasks(group_id);
    `);
    taskColumns = conn.all<{ name: string }>("PRAGMA table_info(tasks)").map((r) => r.name);
  }
  // v23: tasks.group_notified_at (the refonte2-C1): the group digest fires
  // ONCE — the later transitions notify individually.
  if (!taskColumns.includes("group_notified_at")) {
    conn.exec("ALTER TABLE tasks ADD COLUMN group_notified_at INTEGER");
  }
  // 0.34.3: tasks.deadline_left — the deadline PAUSED while the task waits on
  // a human (input_required), resumed when it returns to working. A NULL
  // deadline reads as no-expiry to the sweeper: the pause stores the remaining
  // time and clears the deadline in one UPDATE.
  if (!taskColumns.includes("deadline_left")) {
    conn.exec("ALTER TABLE tasks ADD COLUMN deadline_left INTEGER");
  }
  // v25: tasks.target_node + tasks.asker_node (the 0.33.3): the cross-node
  // task routing stops parsing the "node/box" composite — target_node is
  // the node owning to_box (filled at mesh_ask), asker_node is the asking
  // node on a MIRROR row (filled by handleTaskAsk from the authenticated
  // peer). NULL target_node = a local task.
  if (!taskColumns.includes("target_node")) {
    conn.exec("ALTER TABLE tasks ADD COLUMN target_node TEXT");
  }
  if (!taskColumns.includes("asker_node")) {
    conn.exec("ALTER TABLE tasks ADD COLUMN asker_node TEXT");
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
  // v12: workers.spawned_by — marks a distant spawn (0.24.0): the node id of
  // the paired peer that requested the worker, for the per-peer quota.
  if (!workerColumns.includes("spawned_by")) {
    conn.exec("ALTER TABLE workers ADD COLUMN spawned_by TEXT");
  }
  // v14: workers.spawn_mode (0.25.0) — which of the three spawn modes the
  // child runs in (session: no cwd override, project: an existing directory,
  // worktree: the git isolation). Every 0.24.x row was a worktree spawn, so
  // the default back-fills them correctly; mesh_worker_remove uses it to
  // NEVER touch a directory the mesh did not create.
  if (!workerColumns.includes("spawn_mode")) {
    conn.exec("ALTER TABLE workers ADD COLUMN spawn_mode TEXT NOT NULL DEFAULT 'worktree'");
  }
  conn.exec(INDEXES_V3);
  conn.exec("CREATE INDEX IF NOT EXISTS idx_messages_origin ON messages(origin_id);");
  conn.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function openMeshDb(path: string): MeshDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  let conn = openSqlite(path);
  conn.run("PRAGMA journal_mode = WAL");
  conn.run("PRAGMA busy_timeout = 5000");
  migrate(conn);

  // The delegating connection: every call forwards to the CURRENT engine.
  // reopen() rebuilds it in place — the recovery for a leaked transaction
  // (the frozen-WAL-snapshot class) and a failed rollback; the instance
  // lives on, no orphan is spawned (this is NOT the rejected conn-level
  // self-heal: it never reopens after an explicit close, and it exists to
  // keep THIS instance's wake loop honest, not to revive a disposed one).
  const reopen = () => {
    if (closedByUs) return;
    // An in-memory store cannot be rebuilt: a fresh ":memory:" engine is a
    // different, EMPTY database. Roll the leaked transaction back instead.
    if (path.includes(":memory:")) {
      try {
        conn.exec("ROLLBACK");
      } catch {}
      return;
    }
    // Open the replacement FIRST, swap, then close the old engine. Closing
    // first left the instance on a closed engine forever when the reopen
    // itself failed (EMFILE, disk, permissions): every later call threw and
    // the probe could never retry. The old engine still closes right here,
    // so the leaked transaction's fd + shm READ lock die now, not at GC.
    const fresh = openSqlite(path);
    try {
      fresh.run("PRAGMA journal_mode = WAL");
      fresh.run("PRAGMA busy_timeout = 5000");
      migrate(fresh);
    } catch (error) {
      try {
        fresh.close();
      } catch {}
      throw error;
    }
    const old = conn;
    conn = fresh;
    try {
      old.close();
    } catch {}
  };
  let closedByUs = false;
  const delegating: SqliteConn = {
    all: (sql, params) => conn.all(sql, params),
    get: (sql, params) => conn.get(sql, params),
    run: (sql, params) => conn.run(sql, params),
    exec: (sql) => conn.exec(sql),
    inTransaction: () => conn.inTransaction(),
    close: () => {
      // The explicit close: the instance is disposed — reopen() must never
      // revive it (the 0.28.2 orphan invariant, now enforced).
      closedByUs = true;
      conn.close();
    },
  };
  return { conn: delegating, path, reopen, close: () => delegating.close() };
}
