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
  // A session may own SEVERAL mailboxes (one TUI, several agent hats).
  // Re-registering an existing name rebinds it to this session (handoff).
  // A re-register without a primary keeps the declared one (identity trait,
  // same lifetime as bind_key).
  db.conn.run(
    `INSERT INTO mailboxes (name, session_id, role, pools, bind_key, primary_pool, last_seen, created_at, registered_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET session_id = excluded.session_id,
       role = excluded.role,
       bind_key = COALESCE(excluded.bind_key, mailboxes.bind_key),
       primary_pool = COALESCE(excluded.primary_pool, mailboxes.primary_pool),
       last_seen = excluded.last_seen,
       registered_at = excluded.registered_at,
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
  const row = db.conn.get<MailboxRow>("SELECT * FROM mailboxes WHERE name = ?", [name]);
  return row ? rowToMailbox(row) : null;
}

export function listMailboxes(db: MeshDb): Mailbox[] {
  return db.conn
    .all<MailboxRow>("SELECT * FROM mailboxes ORDER BY created_at ASC")
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
  const resent = db.conn.get<{ message_id: string }>(
    "SELECT message_id FROM recent_mails WHERE hash = ? AND ts > ?",
    [contentHash, created_at - RESEND_WINDOW_MS],
  );
  if (resent) {
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
    `INSERT INTO messages (id, origin_id, from_node, from_box, subject, body, reply_to, wake, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.origin_id ?? id,
      input.from,
      input.from_box ?? null,
      input.subject,
      input.body,
      input.reply_to ?? null,
      input.wake === true ? 1 : 0,
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
  /** Id of that same OLDEST unread delivery: the wake flash carries it so the
   * woken agent can answer with reply_to=<id> — without it, wake-path replies
   * are invisible to mesh_wait's correlation (the 02:17 repro: the reply sat
   * in the box, the waiter starved to its full timeout). */
  id: string | null;
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
    .all<{ box: string; unread: number; wakeable: number; subject: string; id: string | null }>(
      `SELECT d.to_box AS box,
              COUNT(*) AS unread,
              MAX(CASE WHEN m.wake = 1
                        OR ((m.origin_id IS NULL OR m.origin_id = m.id)
                            AND (SELECT COUNT(*) FROM deliveries d2 WHERE d2.message_id = m.id) <= 1)
                       THEN 1 ELSE 0 END) AS wakeable,
              (SELECT m3.subject FROM deliveries d3 JOIN messages m3 ON m3.id = d3.message_id
                WHERE d3.to_box = d.to_box AND d3.status = 'unread'
                ORDER BY d3.created_at ASC LIMIT 1) AS subject,
              (SELECT m4.id FROM deliveries d4 JOIN messages m4 ON m4.id = d4.message_id
                WHERE d4.to_box = d.to_box AND d4.status = 'unread'
                ORDER BY d4.created_at ASC LIMIT 1) AS id
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
      id: row.id,
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
/** The inbound registered_at acceptance window (the PO fix 2): the sender's
 * clock must be within [now - 1h, now + 5 min skew] — an unbounded timestamp
 * (9e15, or a clock ahead) would steal every local name via the LWW. */
const FEDERATED_AT_PAST_TOLERANCE = 60 * 60 * 1000;
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
  if (typeof row.registered_at !== "number" || !Number.isFinite(row.registered_at)) return false;
  if (
    row.registered_at < now - FEDERATED_AT_PAST_TOLERANCE ||
    row.registered_at > now + FEDERATED_AT_FUTURE_SKEW
  ) {
    return false;
  }
  if (typeof row.pools !== "string") return false;
  try {
    const parsed = JSON.parse(row.pools) as unknown;
    if (!Array.isArray(parsed)) return false;
  } catch {
    return false;
  }
  if (row.role !== null && typeof row.role !== "string") return false;
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
  // renamed there) and die here.
  const pushed = new Set(rows.filter((r) => federatedRowValid(r, now)).map((r) => r.name));
  db.conn.run(
    "DELETE FROM mailboxes WHERE node_id = ? AND name NOT IN (" +
      (pushed.size > 0 ? Array.from(pushed, () => "?").join(",") : "NULL") +
      ")",
    [senderNodeId, ...pushed],
  );
  let applied = 0;
  for (const row of rows) {
    if (!federatedRowValid(row, now)) continue;
    const local = db.conn.get<{
      node_id: string | null;
      registered_at: number | null;
      last_seen: number;
    }>("SELECT node_id, registered_at, last_seen FROM mailboxes WHERE name = ?", [row.name]);
    if (local) {
      if (local.node_id === null || local.node_id === "") {
        // This node owns the name. Two guards before a takeover: (1) a LIVE
        // local session (fresh last_seen) keeps its name — the two-orq fight
        // resolves: each keeps its own; (2) the inbound registration must be
        // strictly newer than the local one (the explicit rebind on the
        // other side transferred it).
        if (local.last_seen > now - LIVE_LOCAL_LAST_SEEN_MS) continue;
        const localAt = local.registered_at ?? 0;
        if (row.registered_at <= localAt) continue;
      } else if (local.node_id !== senderNodeId) {
        // A federated row owned by a THIRD node: the sender must be the owner
        // to update it — the third-party re-broadcast never overwrites.
        continue;
      } else if ((local.registered_at ?? 0) >= row.registered_at) {
        continue;
      }
      db.conn.run(
        `UPDATE mailboxes SET session_id = ?, role = ?, pools = ?, primary_pool = ?,
         registered_at = ?, last_seen = ?, bind_key = NULL, node_id = ? WHERE name = ?`,
        [
          row.session_id,
          row.role,
          row.pools,
          row.primary_pool,
          row.registered_at,
          Date.now(),
          senderNodeId,
          row.name,
        ],
      );
    } else {
      db.conn.run(
        `INSERT INTO mailboxes (name, session_id, role, pools, bind_key, primary_pool, last_seen, created_at, registered_at, node_id)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
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
        ],
      );
    }
    applied += 1;
  }
  return applied;
}

/** The local registry rows this node owns (for the /registry-sync push). */
export function localRegistryRows(db: MeshDb): FederatedRegistryRow[] {
  // A NULL registered_at (a row that predates the column) reads as 0 — the
  // OLDEST possible: a peer's newer registration legitimately wins the LWW.
  // Date.now() here would fabricate always-newest rows that steal names at
  // the peers (the PO fix 6).
  return db.conn
    .all<FederatedRegistryRow>(
      "SELECT name, session_id, role, pools, primary_pool, registered_at FROM mailboxes WHERE node_id IS NULL",
    )
    .map((r) => ({ ...r, registered_at: r.registered_at ?? 0 }));
}
