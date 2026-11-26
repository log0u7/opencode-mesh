import { createHash, randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";
import { pluginWarn, storeLogDir } from "./plugin-log.js";
import type { MailMessage } from "../types/peer.js";

// Named mailboxes. A message is either:
// - targeted/broadcast: stored once in `messages`, then one row per recipient
//   in `deliveries` (per-box ack, the cross-session drain killer), or
// - legacy global (no to_box): unread lives on the message row itself, same
//   semantics as before mailboxes existed.

export type Mailbox = {
  name: string;
  session_id: string;
  role: string | null;
  pools: string[];
  bind_key: string | null;
  primary_pool: string | null;
  last_seen: number;
  /** NULL = this node owns the box; a node id = a FEDERATED row (the remote
   * registry pushed at its rebind) — addressing-only, never a delivery
   * target, never woken. */
  node_id: string | null;
  /** The LOGICAL clock per name (the refonte 3.2): incremented at each
   * rebind, the federation LWW resolves on it instead of the wall clock. */
  epoch: number;
};

export type RegisterMailboxInput = {
  name: string;
  session_id: string;
  role?: string | null;
  /** Declared primary group (pool id): its lead receives this box's
   * enrollment confirmation. Declarative only — mail routing is unchanged. */
  primary_pool?: string | null;
  /** Instance binding: the registering instance's project key. A later bind
   * from an instance with the same key re-binds the box to its live session. */
  bind_key?: string | null;
  now: number;
};

export type DeliverInput = {
  from: string;
  from_box?: string | null;
  to_box?: string | null;
  subject: string;
  body: string;
  reply_to?: string | null;
  /** notify (default) wakes per the wake rules; fyi NEVER wakes — read at
   * the next drain or flash (the silent DM). */
  kind?: "notify" | "fyi";
  /** Cross-host dedup: the origin message's id. When a message with this
   * origin_id already exists locally, the delivery is skipped (the fanout
   * can hand the same broadcast to a node through several paths). */
  origin_id?: string | null;
  /** Deliberate broadcast (mesh_send wake:true): wake every recipient even
   * though the mail is a pool fanout (Slack model, 0.17.0). Direct mail
   * always wakes; this flag is only meaningful for multi-recipient or
   * fanouted mail. */
  wake?: boolean;
  created_at?: number;
};

export type DeliverResult =
  | { ok: true; id: string; recipients: string[] }
  | { ok: false; error: "unknown_mailbox" | "empty_broadcast" };

export type InboxRow = {
  delivery_id: string;
  id: string;
  from: string;
  from_box: string | null;
  subject: string;
  body: string;
  reply_to: string | null;
  created_at: number;
  /** Present when the session owns several mailboxes: which box got it. */
  box?: string | null;
};

// 7 days: read or not, a message older than this is swept at server boot.
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 60 s rolling window for the sender-side re-send defense: a sender that
// re-executes its sends after a local crash lands its duplicates within
// seconds (seen live: the same DM twice, 14 s apart), while legitimate
// identical content (daily reminders) repeats hours later and passes.
// 6h (0.29.0, was 60s): the minutes-apart re-send class (the 6admin-to-orq
// episode: three identical DMs over 20 minutes, all delivered) dies here —
// the burst retries were already covered, the interruption-resume class was
// not. The rolling recent_mails purge bounds the rows.
export const RESEND_WINDOW_MS = 6 * 60 * 60 * 1000;
/** The absolute collapse window (0.32.0): an identical re-send this fast is
 * mechanical (the wake double-prompt), never a human ping — collapsed even
 * when the original was already read. */
export const RESEND_ABSOLUTE_WINDOW_MS = 2 * 60 * 1000;

// Content key of the re-send defense. to_box stays in the key so a broadcast
// to one box never swallows the same text to another, and reply_to so an
// identical reply to a different message is still a distinct delivery.
function mailContentHash(input: DeliverInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.from,
        input.from_box ?? null,
        input.to_box ?? null,
        input.subject,
        input.body,
        input.reply_to ?? null,
      ]),
    )
    .digest("hex");
}

function parsePools(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rowToMailbox(row: MailboxRow): Mailbox {
  return {
    name: row.name,
    session_id: row.session_id,
    epoch: row.epoch ?? 1,
    role: row.role ?? null,
    pools: parsePools(row.pools),
    bind_key: row.bind_key ?? null,
    primary_pool: row.primary_pool ?? null,
    last_seen: row.last_seen,
    node_id: row.node_id ?? null,
  };
}

type MailboxRow = {
  name: string;
  node_id: string | null;
  epoch?: number;
  session_id: string;
  role: string | null;
  pools: string;
  bind_key: string | null;
  primary_pool: string | null;
  last_seen: number;
  created_at: number;
};

type MessageRow = {
  id: string;
  from_node: string;
  from_box: string | null;
  subject: string;
  body: string;
  reply_to: string | null;
  status: string;
  created_at: number;
};

// ---- registration and presence ----

export function registerMailbox(db: MeshDb, input: RegisterMailboxInput): Mailbox {
  // The "/" is the node/box composite separator (the refonte P2.5): a local
  // box named "a/b" would be indistinguishable from a cross-host mirror
  // reference. Refuse at the boundary.
  if (input.name.includes("/")) {
    throw new Error('a mailbox name cannot contain "/"');
  }
  // A session may own SEVERAL mailboxes (one TUI, several agent hats).
  // Re-registering an existing name rebinds it to this session (handoff).
  // A re-register without a primary keeps the declared one (identity trait,
  // same lifetime as bind_key).
  db.conn.run(
    `INSERT INTO mailboxes (name, session_id, role, pools, bind_key, primary_pool, last_seen, created_at, registered_at, epoch)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET session_id = excluded.session_id,
       role = excluded.role,
       bind_key = COALESCE(excluded.bind_key, mailboxes.bind_key),
       primary_pool = COALESCE(excluded.primary_pool, mailboxes.primary_pool),
       last_seen = excluded.last_seen,
       registered_at = excluded.registered_at,
       epoch = COALESCE(mailboxes.epoch, 0) + 1,
       node_id = NULL`,
    [
      input.name,
      input.session_id,
      input.role ?? null,
      input.bind_key ?? null,
      input.primary_pool ?? null,
      input.now,
      input.now,
      input.now,
    ],
  );
  const row = db.conn.get<MailboxRow>("SELECT * FROM mailboxes WHERE name = ?", [input.name]);
  if (!row) {
    throw new Error("registerMailbox: row missing after upsert");
  }
  return rowToMailbox(row);
}

export function mailboxByBindKey(db: MeshDb, bind_key: string): Mailbox[] {
  return db.conn
    .all<MailboxRow>("SELECT * FROM mailboxes WHERE bind_key = ?", [bind_key])
    .map(rowToMailbox);
}

export function mailboxBySession(db: MeshDb, session_id: string): Mailbox | null {
  const row = db.conn.get<MailboxRow>("SELECT * FROM mailboxes WHERE session_id = ?", [session_id]);
  return row ? rowToMailbox(row) : null;
}

/** Every mailbox bound to a session (a session may wear several hats). */
export function mailboxesBySession(db: MeshDb, session_id: string): Mailbox[] {
  return db.conn
    .all<MailboxRow>("SELECT * FROM mailboxes WHERE session_id = ? ORDER BY created_at ASC", [
      session_id,
    ])
    .map(rowToMailbox);
}

export function mailboxByName(db: MeshDb, name: string): Mailbox | null {
  // LOCAL only (0.31.0): a federated row (node_id set) is addressing-only —
  // a caller deciding "does this box live here?" must answer no, or mail
  // sinks into a box no local session drains (the P1 phantom-box class).
  const row = db.conn.get<MailboxRow>(
    "SELECT * FROM mailboxes WHERE name = ? AND node_id IS NULL",
    [name],
  );
  return row ? rowToMailbox(row) : null;
}

/** The federated registry row for a name (node_id set, pushed by a peer):
 * the routing record — WHICH node owns the name — never a local box. */
export function federatedByName(db: MeshDb, name: string): Mailbox | null {
  const row = db.conn.get<MailboxRow>(
    "SELECT * FROM mailboxes WHERE name = ? AND node_id IS NOT NULL",
    [name],
  );
  return row ? rowToMailbox(row) : null;
}

export function listMailboxes(db: MeshDb): Mailbox[] {
  // LOCAL only (0.31.0): the sidebar, the counters and mesh_pools count the
  // boxes that live HERE. Federated rows surface through the peers section.
  return db.conn
    .all<MailboxRow>("SELECT * FROM mailboxes WHERE node_id IS NULL ORDER BY created_at ASC")
    .map(rowToMailbox);
}

/** The LOCAL mailboxes only (node_id NULL): the delivery targets, the pool
 * members, the wake subjects. Federated rows (node_id set, pushed by a peer
 * at its rebind) are ADDRESSING-ONLY — a foreign session never drains
 * locally, so a local delivery would be a sink (the 0.30.0 review fix). */
export function listLocalOnlyMailboxes(db: MeshDb): Mailbox[] {
  return db.conn
    .all<MailboxRow>("SELECT * FROM mailboxes WHERE node_id IS NULL ORDER BY created_at ASC")
    .map(rowToMailbox);
}

/** A pool exists when any mailbox on this node carries it: pools are derived
 * from membership, there is no dedicated table. */
export function poolExists(db: MeshDb, pool: string): boolean {
  return listMailboxes(db).some((b) => b.pools.includes(pool));
}

export function touchMailbox(db: MeshDb, session_id: string, now: number): void {
  db.conn.run("UPDATE mailboxes SET last_seen = ? WHERE session_id = ?", [now, session_id]);
}

/** Touch one specific box (used when the caller names its sending box). */
export function touchBoxByName(db: MeshDb, name: string, now: number): void {
  db.conn.run("UPDATE mailboxes SET last_seen = ? WHERE name = ?", [now, name]);
}

export function joinPool(db: MeshDb, name: string, pool: string): void {
  const box = mailboxByName(db, name);
  if (!box) return;
  if (box.pools.includes(pool)) return;
  db.conn.run("UPDATE mailboxes SET pools = ? WHERE name = ?", [
    JSON.stringify([...box.pools, pool]),
    name,
  ]);
}

export function leavePool(db: MeshDb, name: string, pool: string): void {
  const box = mailboxByName(db, name);
  if (!box) return;
  if (!box.pools.includes(pool)) return;
  db.conn.run("UPDATE mailboxes SET pools = ? WHERE name = ?", [
    JSON.stringify(box.pools.filter((p) => p !== pool)),
    name,
  ]);
}

// ---- delivery ----

export function deliverMessage(db: MeshDb, input: DeliverInput): DeliverResult {
  const id = randomUUID();
  const created_at = input.created_at ?? Date.now();

  // Cross-host dedup: the same broadcast can arrive through several fanout
  // paths; the origin id makes the second arrival a no-op.
  if (input.origin_id) {
    const existing = db.conn.get<{ id: string }>(
      "SELECT id FROM messages WHERE origin_id = ? LIMIT 1",
      [input.origin_id],
    );
    if (existing) {
      return { ok: true, id: existing.id, recipients: [] };
    }
  }

  // Sender-side re-send defense (0.20.0): the same mail from the same sender
  // to the same box delivered twice within RESEND_WINDOW_MS is a no-op — the
  // second call returns the EXISTING delivery's id, no new row. This is the
  // duplicate-delivery defense for sender-side re-sends (bug 3 sysops, seen
  // live: one DM delivered twice, 14 s apart, two message ids, after the
  // sender re-executed its sends following a local crash). Runs after the
  // origin_id check: cross-host replays dedup there, real re-sends here.
  const contentHash = mailContentHash(input);
  const resent = db.conn.get<{ message_id: string; ts: number }>(
    "SELECT message_id, ts FROM recent_mails WHERE hash = ? AND ts > ?",
    [contentHash, created_at - RESEND_WINDOW_MS],
  );
  if (resent) {
    // The absolute window (0.32.0): an identical re-send within 2 minutes
    // collapses EVEN IF the original was already read. The wake double-prompt
    // class re-sends 13s after the receiver drained — a genuine human ping
    // never re-writes the identical bytes that fast, and the single-flight
    // claim (F1) is the source fix; this window is the belt-and-braces net.
    if (created_at - resent.ts < RESEND_ABSOLUTE_WINDOW_MS) {
      return { ok: true, id: resent.message_id, recipients: [] };
    }
    // The dedup protects the UNREAD backlog (the re-send burst class): an
    // identical re-send AFTER the original was read is an active ping —
    // deliver it fresh (0.29.0 review). The original's read state lives on
    // its deliveries (the DM's box, the broadcast's member boxes — the hash
    // binds the POOL name, not the member) or the message row (the legacy
    // global path has no deliveries).
    const originalUnread =
      input.to_box == null
        ? db.conn.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM messages WHERE id = ? AND status = 'unread'",
            [resent.message_id],
          )?.n
        : db.conn.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ? AND status = 'unread'",
            [resent.message_id],
          )?.n;
    if (originalUnread) {
      // recipients: [] keeps callers from re-fanouting the duplicate (same
      // contract as the origin_id dedup above).
      return { ok: true, id: resent.message_id, recipients: [] };
    }
  }

  // Resolve first: a legacy global mail or a failure never leaves a message row.
  const global = input.to_box == null;
  let recipients: string[];
  if (global) {
    recipients = [];
  } else {
    const resolved = resolveRecipients(db, input);
    if (resolved === null) {
      return { ok: false, error: "unknown_mailbox" };
    }
    if (resolved.length === 0) {
      return { ok: false, error: "empty_broadcast" };
    }
    recipients = resolved;
  }

  db.conn.run(
    `INSERT INTO messages (id, origin_id, from_node, from_box, subject, body, reply_to, wake, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.origin_id ?? id,
      input.from,
      input.from_box ?? null,
      input.subject,
      input.body,
      input.reply_to ?? null,
      input.wake === true ? 1 : 0,
      input.kind ?? "notify",
      global ? "unread" : "delivered",
      created_at,
    ],
  );

  for (const box of recipients) {
    db.conn.run(
      "INSERT INTO deliveries (id, message_id, to_box, status, created_at) VALUES (?, ?, ?, 'unread', ?)",
      [randomUUID(), id, box, created_at],
    );
  }
  // Record the delivery under its content hash: purge the expired hashes at
  // insert (rolling window, KISS), then insert. The freshness lookup above
  // uses the same cutoff, so a live hash is never overwritten here.
  db.conn.run("DELETE FROM recent_mails WHERE ts <= ?", [created_at - RESEND_WINDOW_MS]);
  db.conn.run(
    `INSERT INTO recent_mails (hash, ts, message_id) VALUES (?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET ts = excluded.ts, message_id = excluded.message_id`,
    [contentHash, created_at, id],
  );
  return { ok: true, id, recipients };
}

// null = unknown single mailbox. Callers guarantee to_box is set.
function resolveRecipients(db: MeshDb, input: DeliverInput): string[] | null {
  const target = input.to_box ?? "";
  // The LOCAL mailboxes only (0.30.0): the federated rows are
  // addressing-only — a foreign session never drains locally, so delivering
  // to one is a sink. The unknown_mailbox branch then routes the DM to the
  // owning peer via the federated resolution.
  if (target === "all") {
    return listLocalOnlyMailboxes(db)
      .map((b) => b.name)
      .filter((name) => name !== input.from_box);
  }
  if (target.startsWith("team:")) {
    // Pools are stored under their full "team:<name>" id, matching mesh_join.
    return listLocalOnlyMailboxes(db)
      .filter((b) => b.pools.includes(target) && b.name !== input.from_box)
      .map((b) => b.name);
  }
  const box = mailboxByName(db, target);
  return box && box.node_id === null ? [box.name] : null;
}

// ---- reading ----

function deliveryRows(db: MeshDb, box: string): InboxRow[] {
  return db.conn
    .all<{
      delivery_id: string;
      m_id: string;
      m_from: string;
      m_from_box: string | null;
      m_subject: string;
      m_body: string;
      m_reply_to: string | null;
      m_created: number;
    }>(
      `SELECT d.id AS delivery_id, m.id AS m_id, m.from_node AS m_from, m.from_box AS m_from_box,
              m.subject AS m_subject, m.body AS m_body, m.reply_to AS m_reply_to,
              m.created_at AS m_created
       FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.to_box = ? AND d.status = 'unread'
       ORDER BY d.created_at ASC`,
      [box],
    )
    .map((row) => ({
      delivery_id: row.delivery_id,
      id: row.m_id,
      from: row.m_from,
      from_box: row.m_from_box,
      subject: row.m_subject,
      body: row.m_body,
      reply_to: row.m_reply_to,
      created_at: row.m_created,
    }));
}

function globalRows(db: MeshDb): InboxRow[] {
  return db.conn
    .all<MessageRow>("SELECT * FROM messages WHERE status = 'unread' ORDER BY created_at ASC")
    .map((row) => ({
      delivery_id: "",
      id: row.id,
      from: row.from_node,
      from_box: row.from_box,
      subject: row.subject,
      body: row.body,
      reply_to: row.reply_to,
      created_at: row.created_at,
    }));
}

export function inboxRows(db: MeshDb, session_id: string): InboxRow[] {
  const boxes = mailboxesBySession(db, session_id);
  const rows =
    boxes.length > 0
      ? [...boxes.flatMap((box) => deliveryRows(db, box.name)), ...globalRows(db)]
      : globalRows(db);
  return rows
    .map((row) =>
      boxes.length > 1 ? { ...row, box: deliveryBoxName(db, row.delivery_id, boxes) } : row,
    )
    .sort((a, b) => a.created_at - b.created_at);
}

/** Which of the session's boxes a delivery belongs to (multi-box labeling). */
function deliveryBoxName(db: MeshDb, delivery_id: string, boxes: Mailbox[]): string | null {
  if (delivery_id.length === 0) return null;
  const row = db.conn.get<{ to_box: string }>("SELECT to_box FROM deliveries WHERE id = ?", [
    delivery_id,
  ]);
  return row && boxes.some((b) => b.name === row.to_box) ? row.to_box : null;
}

// First unread reply to a message id, for mesh_wait. Box deliveries take
// priority over legacy global mail.
export function firstReply(db: MeshDb, reply_to: string, session_id: string): InboxRow | null {
  const box = mailboxBySession(db, session_id);
  const rows = box ? [...deliveryRows(db, box.name), ...globalRows(db)] : globalRows(db);
  const reply = rows.find((r) => r.reply_to === reply_to);
  return reply ?? null;
}

export function ackInbox(db: MeshDb, delivery_ids: string[]): void {
  for (const id of delivery_ids) {
    if (id.length === 0) continue;
    db.conn.run("UPDATE deliveries SET status = 'read' WHERE id = ?", [id]);
  }
}

export function ackReply(db: MeshDb, row: InboxRow): void {
  if (row.delivery_id.length > 0) {
    db.conn.run("UPDATE deliveries SET status = 'read' WHERE id = ?", [row.delivery_id]);
  } else {
    db.conn.run("UPDATE messages SET status = 'read' WHERE id = ?", [row.id]);
  }
}

// The repo's SqliteConn wrapper exposes no transaction() method (node:sqlite /
// bun:sqlite both support plain BEGIN/COMMIT through exec), so transactions are
// manual. Single connection, synchronous, and no nested use: safe.
// A reopen that fails must not replace the error the caller is reporting (the
// original failure, or the leak refusal): log it, keep the old engine, and let
// the next wake probe retry.
function safeReopen(db: MeshDb): void {
  try {
    db.reopen?.();
  } catch (error) {
    pluginWarn(storeLogDir(db.path), `reopen failed: ${String(error)}`);
  }
}

export function withTransaction<T>(db: MeshDb, fn: () => T): T {
  if (db.conn.inTransaction()) {
    // A leaked BEGIN pins the WAL snapshot forever (the wake loop then reads
    // a frozen view and re-prompts read mail — the phantom-unread class).
    // Recover: rebuild the connection in place (the instance lives on), warn
    // to the plugin log (console.warn is /dev/null under serve --service),
    // and refuse loudly.
    pluginWarn(
      storeLogDir(db.path),
      "withTransaction: a leaked transaction found, rebuilding the connection",
    );
    safeReopen(db);
    throw new Error(
      "transaction already open on this connection: a BEGIN leaked and must be fixed at the source",
    );
  }
  db.conn.exec("BEGIN");
  try {
    const result = fn();
    db.conn.exec("COMMIT");
    return result;
  } catch (error) {
    let rollbackFailed = false;
    try {
      db.conn.exec("ROLLBACK");
    } catch {
      // The rollback itself failed: the transaction state is unknown — the
      // connection would read a frozen snapshot forever. Rebuild it in place
      // (0.30.0: the leak path that survived 0.28.2's silent swallow).
      rollbackFailed = true;
    }
    if (rollbackFailed) {
      pluginWarn(
        storeLogDir(db.path),
        "withTransaction: the ROLLBACK failed, rebuilding the connection",
      );
      safeReopen(db);
    }
    throw error;
  } finally {
    if (db.conn.inTransaction()) {
      pluginWarn(
        storeLogDir(db.path),
        "withTransaction: transaction still open after the call, rebuilding the connection",
      );
      safeReopen(db);
    }
  }
}

/**
 * Fetch unread inbox rows and, when ack is true, mark them read in ONE SQLite
 * transaction. Before 0.16.1 fetch and ack were two separate write phases: a
 * process killed between them (plugin hot-swap) left deliveries marked read
 * but never served, so a real mail was lost (seen live on ricinus).
 *
 * Residual window, documented on purpose: the process can still die after the
 * COMMIT and before the response reaches the model over RPC. The rows are then
 * read-marked but unserved. This window is inherent to RPC over a dying
 * process; the transaction shrinks it to microseconds instead of the whole
 * fetch, ack, return span. Narrowing it further would mean re-delivering
 * recent reads on boot, which re-serves duplicates after every normal
 * restart: worse than the bug it would fix.
 */
export function inboxRead(db: MeshDb, session_id: string, ack: boolean): InboxRow[] {
  return withTransaction(db, () => {
    const rows = inboxRows(db, session_id);
    if (ack && rows.length > 0) {
      ackInbox(
        db,
        rows.map((r) => r.delivery_id),
      );
      // Legacy global rows have no delivery: ack the message rows instead.
      ackMessages(
        db,
        rows.filter((r) => r.delivery_id === "").map((r) => r.id),
      );
    }
    return rows;
  });
}

/**
 * First unread reply for mesh_wait, with the same atomic fetch+ack as
 * inboxRead (same hot-swap race, same fix, same residual window).
 */
export function waitReplyRead(db: MeshDb, reply_to: string, session_id: string): InboxRow | null {
  return withTransaction(db, () => {
    const row = firstReply(db, reply_to, session_id);
    if (row) ackReply(db, row);
    return row;
  });
}

/** The wait matcher (0.31.0): the exact reply_to match first, then the
 * sender match — ANY message from the request's recipient box that arrived
 * after the request. A reply that bypassed the auto-fill (a legacy wire
 * path, a DB-level write) still returns the waiter: the correlation no
 * longer depends on anyone's discipline. The matched row is acked. */
export function waitReplyBroad(db: MeshDb, reply_to: string, session_id: string): InboxRow | null {
  return withTransaction(db, () => {
    const exact = firstReply(db, reply_to, session_id);
    if (exact) {
      ackReply(db, exact);
      return exact;
    }
    const request = db.conn.get<{ created_at: number }>(
      "SELECT created_at FROM messages WHERE id = ?",
      [reply_to],
    );
    const delivery = db.conn.get<{ to_box: string }>(
      "SELECT to_box FROM deliveries WHERE message_id = ? ORDER BY created_at DESC LIMIT 1",
      [reply_to],
    );
    const box = mailboxBySession(db, session_id);
    if (!request || !delivery || !box) return null;
    const stray = deliveryRows(db, box.name).find(
      (r) => r.from_box === delivery.to_box && r.created_at > request.created_at,
    );
    if (stray) {
      ackReply(db, stray);
      return stray;
    }
    return null;
  });
}

/** The unread rows that do NOT answer `reply_to` — the wake-path replies
 * (bare, reply_to NULL: the flash carries the subject, not the id) that would
 * otherwise starve a mesh_wait caller to its full timeout. Listed in the
 * wait's timeout message so the caller recovers instead of waiting blind. */
export function unmatchedUnread(db: MeshDb, reply_to: string, session_id: string): InboxRow[] {
  const box = mailboxBySession(db, session_id);
  const rows = box ? [...deliveryRows(db, box.name), ...globalRows(db)] : globalRows(db);
  return rows.filter((r) => r.reply_to !== reply_to);
}

// ---- legacy API kept for the remote wire path and existing callers ----

export function receiveMessage(
  db: MeshDb,
  input: { from: string; subject: string; body: string; reply_to?: string; from_box?: string },
): MailMessage {
  const id = randomUUID();
  const created_at = Date.now();
  db.conn.run(
    "INSERT INTO messages (id, from_node, from_box, subject, body, reply_to, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'unread', ?)",
    [
      id,
      input.from,
      input.from_box ?? null,
      input.subject,
      input.body,
      input.reply_to ?? null,
      created_at,
    ],
  );
  return {
    id,
    from: input.from,
    subject: input.subject,
    body: input.body,
    status: "unread",
    created_at,
  };
}

export function unreadMessages(db: MeshDb): MailMessage[] {
  return db.conn
    .all<MessageRow>("SELECT * FROM messages WHERE status = 'unread' ORDER BY created_at ASC")
    .map(rowToMessage);
}

export function unreadCount(db: MeshDb): number {
  return (
    db.conn.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE status = 'unread'")
      ?.count ?? 0
  );
}

export function unreadBoxCount(db: MeshDb, box: string): number {
  return (
    db.conn.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM deliveries WHERE to_box = ? AND status = 'unread'",
      [box],
    )?.count ?? 0
  );
}

// Wake gate (token economy, 0.16.0): a pool broadcast reaches a box through
// the fanout, and the fanouted message row keeps its ORIGIN id (journal.ts
// `forwarded` semantics: origin_id differs from the local id; legacy rows
// have origin_id NULL). Pool mail is read on natural turns — only a DIRECT
// mail (origin_id equals the local id, or NULL legacy) may wake the session.
export type WakeBoxStat = {
  box: string;
  unread: number;
  wakeable: boolean;
  /** Subject of the box's OLDEST unread delivery (the wake preview). */
  subject: string;
};

/** Per-box unread stats for the wake loop, in ONE grouped statement: before
 * 0.21.0 the tick ran two queries per mailbox (unread count + wake gate) plus
 * one more at prompt time (preview subject) — N boxes cost 3N reads per tick.
 * A message wakes when it is deliberate (`wake = 1`) OR direct: exactly one
 * local recipient and no foreign origin (origin_id null or equal to the local
 * id). A multi-recipient broadcast or a cross-host fanout without the flag is
 * quiet: channels are quiet by default, the sender flags the mention. Legacy
 * rows (pre-origin_id) count as direct, like every other gate. */
export function wakeBoxStats(db: MeshDb): WakeBoxStat[] {
  return db.conn
    .all<{ box: string; unread: number; wakeable: number; subject: string }>(
      `SELECT d.to_box AS box,
              COUNT(*) AS unread,
              MAX(CASE WHEN m.kind = 'fyi' THEN 0
                        WHEN m.wake = 1
                        OR ((m.origin_id IS NULL OR m.origin_id = m.id)
                            AND (SELECT COUNT(*) FROM deliveries d2 WHERE d2.message_id = m.id) <= 1)
                       THEN 1 ELSE 0 END) AS wakeable,
              (SELECT m3.subject FROM deliveries d3 JOIN messages m3 ON m3.id = d3.message_id
                WHERE d3.to_box = d.to_box AND d3.status = 'unread'
                ORDER BY d3.created_at ASC, d3.id ASC LIMIT 1) AS subject
       FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.status = 'unread'
         AND d.to_box NOT IN (SELECT name FROM mailboxes WHERE node_id IS NOT NULL)
       GROUP BY d.to_box`,
    )
    .map((row) => ({
      box: row.box,
      unread: row.unread,
      wakeable: row.wakeable === 1,
      subject: row.subject,
    }));
}

export function ackMessages(db: MeshDb, ids: string[]): void {
  for (const id of ids) {
    db.conn.run("UPDATE messages SET status = 'read' WHERE id = ?", [id]);
  }
}

// ---- retention ----

export function purgeExpired(db: MeshDb, ttl_ms: number, now: number): void {
  const cutoff = now - ttl_ms;
  db.conn.run(
    "DELETE FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)",
    [cutoff],
  );
  db.conn.run("DELETE FROM messages WHERE created_at < ?", [cutoff]);
}

function rowToMessage(row: MessageRow): MailMessage {
  return {
    id: row.id,
    from: row.from_node,
    subject: row.subject,
    body: row.body,
    status: row.status === "read" ? "read" : "unread",
    created_at: row.created_at,
  };
}

// ---- registry federation (0.30.0) ----

export type FederatedRegistryRow = {
  name: string;
  session_id: string;
  role: string | null;
  pools: string;
  primary_pool: string | null;
  registered_at: number;
  /** The LOGICAL clock per name (the refonte 3.2): the LWW resolves on it
   * when present; absent = a pre-3.2 peer, the legacy wall-clock rules. */
  epoch?: number;
};

/**
 * The federation merge (the LWW single-writer design): an inbound row for a
 * name this node owns locally resolves the ownership by (registered_at,
 * node_id) — the newer registration wins the NAME (an explicit rebind on the
 * other side transfers it); an inbound row for a name this node does not own
 * upserts as FEDERATED (node_id = the sender). Federated boxes resolve
 * mesh_send addressing cross-node but are never woken (their session_id is
 * foreign — sessionKnown false in the wake loop). The sender's own rows are
 * authoritative for its names: the merge is idempotent per row.
 */
/** The inbound registered_at acceptance bound (the PO fix 2): only the
 * FUTURE side is bounded — an unbounded timestamp (9e15, a clock ahead)
 * would steal every local name via the LWW. The past side is unbounded:
 * registered_at is the original registration time and never moves. */
const FEDERATED_AT_FUTURE_SKEW = 5 * 60 * 1000;
/** A local box with a fresh last_seen is a LIVE session: its name cannot be
 * taken by a foreign registry row (the two-orq fight resolves: each keeps
 * its own). The staleness bound is generous (the session may idle). */
const LIVE_LOCAL_LAST_SEEN_MS = 60 * 60 * 1000;

/** Per-row validation (the PO fix 3): only well-typed rows enter the merge —
 * a bad row is SKIPPED, the batch survives. registered_at must be a finite
 * number inside the acceptance window (the clock bound above). */
function federatedRowValid(row: FederatedRegistryRow, now: number): boolean {
  if (typeof row.name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(row.name)) return false;
  if (typeof row.session_id !== "string" || row.session_id.length === 0) return false;
  if (row.session_id.length > 128) return false;
  if (typeof row.registered_at !== "number" || !Number.isFinite(row.registered_at)) return false;
  // Only the FUTURE skew is bounded (the 9e15 steal class). No past bound:
  // registered_at is the ORIGINAL registration time and never moves — a
  // long-lived box (orq, stable names) is older than any tolerance, and the
  // takeover LWW guard (row.registered_at <= localAt) already refuses a
  // backdated row for a name we own.
  if (row.registered_at > now + FEDERATED_AT_FUTURE_SKEW) {
    return false;
  }
  if (typeof row.pools !== "string") return false;
  try {
    const parsed = JSON.parse(row.pools) as unknown;
    if (!Array.isArray(parsed)) return false;
    // Every pool id is a full "team:<name>" — anything else would inject a
    // phantom pool into the local membership view.
    if (!parsed.every((p) => typeof p === "string" && /^team:[A-Za-z0-9._-]+$/.test(p))) {
      return false;
    }
  } catch {
    return false;
  }
  if (row.role !== null && typeof row.role !== "string") return false;
  if (typeof row.role === "string" && row.role.length > 64) return false;
  if (row.primary_pool !== null && typeof row.primary_pool !== "string") return false;
  return true;
}

export function mergeFederatedRegistry(
  db: MeshDb,
  rows: FederatedRegistryRow[],
  senderNodeId: string,
): number {
  const now = Date.now();
  // The full-state replacement (the PO fix 4): each push carries the
  // sender's COMPLETE local registry — the federated rows owned by the
  // sender that are ABSENT from the push are stale (the box was deleted or
  // renamed there) and die here. One transaction: a mid-merge crash never
  // leaves half a batch (rows deleted, their replacements absent).
  return withTransaction(db, () => {
    const pushed = new Set(rows.filter((r) => federatedRowValid(r, now)).map((r) => r.name));
    // An EMPTY push retires ALL of the sender's federated rows (the full-state
    // contract): the name NOT IN (NULL) placeholder would compare NULL against
    // every row and delete NOTHING — stale rows keep routing cross-node DMs
    // to a dead box (the mr-review finding).
    if (pushed.size === 0) {
      db.conn.run("DELETE FROM mailboxes WHERE node_id = ?", [senderNodeId]);
    } else {
      db.conn.run(
        "DELETE FROM mailboxes WHERE node_id = ? AND name NOT IN (" +
          Array.from(pushed, () => "?").join(",") +
          ")",
        [senderNodeId, ...pushed],
      );
    }
    let applied = 0;
    for (const row of rows) {
      if (!federatedRowValid(row, now)) continue;
      const local = db.conn.get<{
        node_id: string | null;
        registered_at: number | null;
        last_seen: number;
        bind_key: string | null;
        epoch: number | null;
      }>(
        "SELECT node_id, registered_at, last_seen, bind_key, epoch FROM mailboxes WHERE name = ?",
        [row.name],
      );
      if (local) {
        if (local.node_id === null || local.node_id === "") {
          // This node owns the name. Three guards before a takeover: (1) a LIVE
          // local session (fresh last_seen) keeps its name — the two-orq fight
          // resolves: each keeps its own; (2) a BOUND name (bind_key set — an
          // instance binding) is never ceded, quiet session or not: the bind is
          // the operator's claim, the staleness does not reopen it; (3) the
          // inbound registration must be strictly newer than the local one (the
          // explicit rebind on the other side transferred it).
          if (local.bind_key !== null && local.bind_key !== "") continue;
          if (local.last_seen > now - LIVE_LOCAL_LAST_SEEN_MS) continue;
          // The EPOCH first (the refonte 3.2): the logical clock per name —
          // a wall clock can lie (the clock-skew class), an epoch cannot.
          // The TRANSITIONAL guard: an epoch-less inbound (a pre-3.2 peer)
          // NEVER takes a local name — the takeover requires the new
          // protocol; the legacy wall-clock transfer is retired.
          if ((row.epoch ?? 0) === 0) continue;
          const localEpoch = local.epoch ?? 0;
          if ((row.epoch ?? 0) <= localEpoch) continue;
        } else if (local.node_id !== senderNodeId) {
          // A federated row owned by a THIRD node: the sender must be the owner
          // to update it — the third-party re-broadcast never overwrites.
          continue;
        } else if ((row.epoch ?? 0) > 0) {
          if ((row.epoch ?? 0) <= (local.epoch ?? 0)) continue;
        } else if ((local.registered_at ?? 0) >= row.registered_at) {
          continue;
        }
        db.conn.run(
          `UPDATE mailboxes SET session_id = ?, role = ?, pools = ?, primary_pool = ?,
         registered_at = ?, last_seen = ?, bind_key = NULL, node_id = ?,
         epoch = ? WHERE name = ?`,
          [
            row.session_id,
            row.role,
            row.pools,
            row.primary_pool,
            row.registered_at,
            Date.now(),
            senderNodeId,
            row.epoch ?? (local.epoch ?? 0) + 1,
            row.name,
          ],
        );
      } else {
        db.conn.run(
          `INSERT INTO mailboxes (name, session_id, role, pools, bind_key, primary_pool, last_seen, created_at, registered_at, node_id, epoch)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          [
            row.name,
            row.session_id,
            row.role,
            row.pools,
            row.primary_pool,
            Date.now(),
            Date.now(),
            row.registered_at,
            senderNodeId,
            row.epoch ?? 1,
          ],
        );
      }
      applied += 1;
    }
    return applied;
  });
}

/** The pending question a reply should answer, WITHOUT agent discipline:
 * the last message `toBox` sent to `fromBox` (delivered in fromBox's box,
 * inside the window) that no message from fromBox answers yet. The send
 * path fills reply_to from it when the agent left it empty — the storm
 * root cause (bare replies invisible to the correlation) dies at the
 * source. Explicit reply_to always wins; nothing pending = NULL. */
export function lastUnansweredFrom(
  db: MeshDb,
  fromBox: string,
  toBox: string,
  sinceMs = 30 * 60 * 1000,
): string | null {
  const row = db.conn.get<{ id: string }>(
    `SELECT m.id FROM messages m
     JOIN deliveries d ON d.message_id = m.id
     WHERE d.to_box = ? AND m.from_box = ? AND m.created_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.from_box = ?
       )
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [fromBox, toBox, Date.now() - sinceMs, fromBox],
  );
  return row?.id ?? null;
}

/** The flash single-flight (0.32.0): claim the box's announceable unreads
 * ATOMICALLY in the shared database — the decision "already flashed" lives
 * in the store every instance sees, not in per-instance memory (two plugin
 * instances' wake loops each iterate ALL boxes with their own pendingPrompt
 * maps: neither saw the other's gate, 6admin got prompted 13s apart and
 * answered twice). Returns the claimed row count: 0 = nothing fresh (or
 * another instance just claimed it) — skip the prompt. Rows whose flash is
 * older than staleAfterMs are RE-claimed: that is the reminder path (the
 * fatigue mute re-prompts through it), 0 = first flash only. */
export function claimFlash(
  db: MeshDb,
  box: string,
  now: number,
  staleAfterMs: number,
): { claimed: number; at: number } {
  const res = db.conn.run(
    `UPDATE deliveries SET flashed_at = ?
     WHERE to_box = ? AND status = 'unread'
       AND (flashed_at IS NULL OR flashed_at <= ?)`,
    [now, box, now - staleAfterMs],
  );
  return { claimed: res.changes, at: now };
}

/** Release a flash claim whose prompt FAILED: the rows go back to NULL so
 * the next tick re-claims them — a claimed-but-never-announced delivery is
 * the silent-starvation class (the flash died, the mail looks announced). */
export function releaseFlash(db: MeshDb, box: string, at: number): void {
  // Restore the PRE-claim state: NULL flashed_at AND unread. The
  // content-bearing flash CONSUMES the rows (status read in the claim
  // UPDATE) — a failed prompt must un-consume them, or the re-claim
  // (WHERE status = 'unread') never sees them again: silent loss.
  db.conn.run(
    "UPDATE deliveries SET flashed_at = NULL, status = 'unread' WHERE to_box = ? AND flashed_at = ?",
    [box, at],
  );
}

/** The content-bearing flash (0.33 refonte P1.1): claim the box's
 * announceable unreads AND, when the whole batch fits the character budget,
 * CONSUME it in the same UPDATE (flashed_at set, status read) and return the
 * payload. The wake prompt then carries the mail itself: the agent reads the
 * content in the flash and skips the mesh_inbox turn — one turn per wake
 * instead of two. An oversized batch claims WITHOUT content (the compact
 * flash path: mesh_inbox carries the bodies at the next turn). Atomic: the
 * read, the budget check and the claim+consume happen in one transaction. */
export function claimFlashWithContent(
  db: MeshDb,
  box: string,
  now: number,
  staleAfterMs: number,
  maxChars: number,
): { claimed: number; at: number; content: string | null } {
  return withTransaction(db, () => {
    const rows = db.conn.all<{
      id: string;
      from_box: string | null;
      subject: string;
      body: string;
    }>(
      `SELECT m.id, m.from_box, m.subject, m.body
         FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.to_box = ? AND d.status = 'unread'
           AND (d.flashed_at IS NULL OR d.flashed_at <= ?)
         ORDER BY d.created_at ASC`,
      [box, now - staleAfterMs],
    );
    const content = rows
      .map((r) => `[${r.id.slice(0, 8)}] ${r.from_box ?? "?"}: ${r.subject} — ${r.body}`)
      .join("\n");
    const fits = content.length <= maxChars;
    const res = db.conn.run(
      `UPDATE deliveries SET flashed_at = ?${fits ? ", status = 'read'" : ""}
       WHERE to_box = ? AND status = 'unread'
         AND (flashed_at IS NULL OR flashed_at <= ?)`,
      [now, box, now - staleAfterMs],
    );
    return { claimed: res.changes, at: now, content: fits ? content : null };
  });
}

// ---- tasks (the refonte P2: the A2A lifecycle, server-side correlation) ----

export type TaskState =
  | "submitted"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled";

export const TASK_OPEN_STATES = ["submitted", "working", "input_required"] as const;

export type TaskRow = {
  id: string;
  from_box: string | null;
  to_box: string;
  group_id: string | null;
  question: string;
  result: string | null;
  state: TaskState;
  created_at: number;
  updated_at: number;
  deadline: number | null;
};

function rowToTask(row: Record<string, unknown>): TaskRow {
  return row as unknown as TaskRow;
}

/** mesh_ask: submit a task — the row lands and the responder is notified
 * (a notify message carrying the task id and the reply instruction). The
 * correlation is server-side: the reply comes through mesh_reply(task_id),
 * reply_to is no longer part of the contract. Returns immediately. */
export function askTask(
  db: MeshDb,
  input: {
    from_box: string | null;
    to_box: string;
    question: string;
    group_id?: string | null;
    deadline?: number | null;
  },
): TaskRow {
  const id = randomUUID();
  const now = Date.now();
  db.conn.run(
    `INSERT INTO tasks (id, from_box, to_box, group_id, question, result, state, created_at, updated_at, deadline)
     VALUES (?, ?, ?, ?, ?, NULL, 'submitted', ?, ?, ?)`,
    [
      id,
      input.from_box,
      input.to_box,
      input.group_id ?? null,
      input.question,
      now,
      now,
      input.deadline ?? null,
    ],
  );
  const id8 = id.slice(0, 8);
  // A FEDERATED target (refonte P2.5): the ask travels through the outbox
  // (the tools layer queues task-ask) — a local delivery would sink into an
  // addressing-only row.
  if (!mailboxByName(db, input.to_box)) {
    const row = getTask(db, id);
    if (!row) throw new Error("the task row vanished after the insert");
    return row;
  }
  deliverMessage(db, {
    from: "mesh-tasks",
    from_box: input.from_box,
    to_box: input.to_box,
    subject: `task ${id8}: ${input.question.slice(0, 60)}`,
    body:
      `${input.question}\n\n` +
      `Reply with: mesh_reply(task_id="${id}", result="...", state="completed") ` +
      `— state also accepts "failed" and "input_required". The asker is notified on terminal and input_required states.`,
    kind: "notify",
  });
  return {
    id,
    from_box: input.from_box,
    to_box: input.to_box,
    group_id: input.group_id ?? null,
    question: input.question,
    result: null,
    state: "submitted",
    created_at: now,
    updated_at: now,
    deadline: input.deadline ?? null,
  };
}

/** The task by id (or null). */
export function getTask(db: MeshDb, id: string): TaskRow | null {
  const row = db.conn.get<Record<string, unknown>>("SELECT * FROM tasks WHERE id = ?", [id]);
  return row ? rowToTask(row) : null;
}

/** Is the group fully answered (every task terminal or input_required)? */
function groupReady(db: MeshDb, groupId: string): boolean {
  const open = db.conn.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE group_id = ? AND state NOT IN ('completed','failed','canceled','input_required')`,
    [groupId],
  );
  return (open?.n ?? 0) === 0;
}

/** The digest for a group: one line per task. */
function groupDigest(db: MeshDb, groupId: string): string {
  const rows = db.conn.all<{ id: string; state: string; result: string | null; question: string }>(
    "SELECT id, state, result, question FROM tasks WHERE group_id = ? ORDER BY created_at ASC",
    [groupId],
  );
  return rows
    .map((r) => `[${r.id.slice(0, 8)}] ${r.state}: ${r.result ?? r.question.slice(0, 60)}`)
    .join("\n");
}

/** mesh_reply: the responder answers a task. ONLY the task's to_box owner
 * may reply. Terminal states (and input_required) notify the asker; a
 * group notifies ONCE, when ALL its tasks are answered (the digest — the
 * collective ask costs one wake instead of one per task). */
export function replyTask(
  db: MeshDb,
  taskId: string,
  replyingBox: string,
  result: string,
  state: TaskState = "completed",
): { ok: boolean; error?: string; notified: boolean; cross?: boolean } {
  // BEGIN IMMEDIATE (the refonte2-C1): the concurrent replies to the same
  // group serialize — two simultaneous last-replies cannot both fire the
  // digest (the duplicate class); the sweep racing a reply serializes too.
  db.conn.exec("BEGIN IMMEDIATE");
  try {
    const out = replyTaskInner(db, taskId, replyingBox, result, state);
    db.conn.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.conn.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function replyTaskInner(
  db: MeshDb,
  taskId: string,
  replyingBox: string,
  result: string,
  state: TaskState = "completed",
): { ok: boolean; error?: string; notified: boolean; cross?: boolean } {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "unknown task", notified: false };
  if (task.to_box !== replyingBox)
    return { ok: false, error: "only the task's target mailbox may reply", notified: false };
  if (["completed", "failed", "canceled"].includes(task.state))
    return { ok: false, error: `the task is already ${task.state}`, notified: false };
  const now = Date.now();
  db.conn.run("UPDATE tasks SET result = ?, state = ?, updated_at = ? WHERE id = ?", [
    result,
    state,
    now,
    taskId,
  ]);
  // The asker notification: terminal states always; input_required too (a
  // pause is a deliberate answer the asker must see). "working" never wakes.
  // The asker notification: terminal states always; input_required too (a
  // pause is a deliberate answer the asker must see). working/submitted never.
  const notifyNow = ["completed", "failed", "canceled", "input_required"].includes(state);
  if (!notifyNow) return { ok: true, notified: false };
  // The MIRROR tasks (the cross-host): the group gate does NOT apply — the
  // group's other tasks live on the ASKER'S node, the replies cross
  // individually and the ASKER aggregates the digest.
  if (task.group_id && !task.from_box?.includes("/") && !groupReady(db, task.group_id))
    return { ok: true, notified: false };
  if (!task.from_box) return { ok: true, notified: false };
  // The MIRROR detection (refonte P2.5): the asker's box is not a LOCAL box
  // — the task came from another node. The reply crosses BACK through the
  // outbox (the tools layer queues task-reply); no local notification.
  if (!mailboxByName(db, task.from_box)) return { ok: true, notified: false, cross: true };
  // The GROUP digest fires ONCE (the refonte2-C1): group_notified_at marks
  // the moment — the LATER transitions (input_required -> completed, a
  // second failure...) notify INDIVIDUALLY, never re-digest (the duplicate
  // class: the digest re-firing at every transition).
  if (task.group_id) {
    const groupNotified = db.conn.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE group_id = ? AND group_notified_at IS NOT NULL",
      [task.group_id],
    )?.n;
    if (groupNotified !== undefined && groupNotified > 0) {
      deliverMessage(db, {
        from: "mesh-tasks",
        from_box: task.to_box,
        to_box: task.from_box,
        subject: `task ${task.id.slice(0, 8)} ${state}`,
        body: `${result}\n(task ${task.id.slice(0, 8)}, state: ${state})`,
        kind: "notify",
      });
      return { ok: true, notified: true };
    }
    db.conn.run("UPDATE tasks SET group_notified_at = ? WHERE group_id = ?", [now, task.group_id]);
  }
  const body = task.group_id
    ? `The group is answered:\n${groupDigest(db, task.group_id)}`
    : `${result}\n(task ${taskId.slice(0, 8)}, state: ${state})`;
  deliverMessage(db, {
    from: "mesh-tasks",
    from_box: task.to_box,
    to_box: task.from_box,
    subject: `task ${taskId.slice(0, 8)} ${state}`,
    body,
    kind: "notify",
  });
  return { ok: true, notified: true };
}

/** The deadline sweeper: expired open tasks fail WITHOUT intervention and
 * the asker is notified (the group rules apply). Returns the swept count. */
export function sweepTasks(db: MeshDb, now: number): number {
  // BEGIN IMMEDIATE (the refonte2-C1): the sweep races a reply — the
  // serialization kills the double-digest / double-notification class.
  db.conn.exec("BEGIN IMMEDIATE");
  try {
    const expired = db.conn.all<{ id: string }>(
      `SELECT id FROM tasks WHERE deadline IS NOT NULL AND deadline < ? AND state IN ('submitted','working','input_required')`,
      [now],
    );
    for (const row of expired) {
      const task = getTask(db, row.id);
      if (!task) continue;
      replyTaskInner(db, row.id, task.to_box, "deadline exceeded", "failed");
    }
    db.conn.exec("COMMIT");
    return expired.length;
  } catch (error) {
    try {
      db.conn.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

/** mesh_tasks: the compact listing (no blocking). group filters; the caller's
 * boxes see the tasks they asked OR are asked. */
export function listTasks(db: MeshDb, boxes: string[], groupId?: string): TaskRow[] {
  if (boxes.length === 0) return [];
  const placeholders = boxes.map(() => "?").join(",");
  const rows = db.conn.all<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE (from_box IN (${placeholders}) OR to_box IN (${placeholders}))${
      groupId ? " AND group_id = ?" : ""
    } ORDER BY created_at DESC LIMIT 50`,
    groupId ? [...boxes, ...boxes, groupId] : [...boxes, ...boxes],
  );
  return rows.map(rowToTask);
}

/** The local registry rows this node owns (for the /registry-sync push). */
export function localRegistryRows(db: MeshDb): FederatedRegistryRow[] {
  // A NULL registered_at (a row that predates the column) reads as 0 — the
  // OLDEST possible: a peer's newer registration legitimately wins the LWW.
  // Date.now() here would fabricate always-newest rows that steal names at
  // the peers (the PO fix 6).
  return db.conn
    .all<FederatedRegistryRow>(
      "SELECT name, session_id, role, pools, primary_pool, registered_at, epoch FROM mailboxes WHERE node_id IS NULL",
    )
    .map((r) => ({ ...r, registered_at: r.registered_at ?? 0, epoch: r.epoch ?? 1 }));
}

// ---- the board (the refonte P4: the shared status state, not DMs) ----

export const BOARD_KEYS = ["task", "blocker", "state", "eta"] as const;
export type BoardKey = (typeof BOARD_KEYS)[number];

/** mesh_board_set: write ONE status key for the box. NO wake — the board is
 * shared state: nobody is interrupted by an update, whoever needs it reads
 * it (mesh_board_get). The keys are FIXED (the schema above) so the reads
 * stay comparable across the fleet. */
export function boardSet(db: MeshDb, box: string, key: BoardKey, value: string, now: number): void {
  db.conn.run(
    `INSERT INTO board (box, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(box, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [box, key, value, now],
  );
}

/** mesh_board_get: the compact read — ONE line per box, the keys in the
 * fixed order. The pool filter keeps the boxes carrying that pool. */
export function boardGet(db: MeshDb, pool?: string): Array<{ box: string; line: string }> {
  const boxes = listLocalOnlyMailboxes(db).filter((b) => !pool || b.pools.includes(pool));
  const out: Array<{ box: string; line: string }> = [];
  for (const box of boxes) {
    const rows = db.conn.all<{ key: string; value: string; updated_at: number }>(
      "SELECT key, value, updated_at FROM board WHERE box = ? ORDER BY updated_at DESC",
      [box.name],
    );
    if (rows.length === 0) continue;
    const order = new Map(BOARD_KEYS.map((k, i) => [k, i]));
    rows.sort(
      (a, b) => (order.get(a.key as BoardKey) ?? 99) - (order.get(b.key as BoardKey) ?? 99),
    );
    out.push({ box: box.name, line: rows.map((r) => `${r.key}=${r.value}`).join("; ") });
  }
  return out;
}
