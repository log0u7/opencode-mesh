import { randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";
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
  last_seen: number;
};

export type RegisterMailboxInput = {
  name: string;
  session_id: string;
  role?: string | null;
  now: number;
};

export type DeliverInput = {
  from: string;
  from_box?: string | null;
  to_box?: string | null;
  subject: string;
  body: string;
  reply_to?: string | null;
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
};

// 7 days: read or not, a message older than this is swept at server boot.
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    last_seen: row.last_seen,
  };
}

type MailboxRow = {
  name: string;
  session_id: string;
  role: string | null;
  pools: string;
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
  // One box per session: registering under a new name releases the old one.
  // Re-registering an existing name rebinds it to this session (handoff).
  db.conn.run("DELETE FROM mailboxes WHERE session_id = ? AND name != ?", [
    input.session_id,
    input.name,
  ]);
  db.conn.run(
    `INSERT INTO mailboxes (name, session_id, role, pools, last_seen, created_at)
     VALUES (?, ?, ?, '[]', ?, ?)
     ON CONFLICT(name) DO UPDATE SET session_id = excluded.session_id,
       role = excluded.role, last_seen = excluded.last_seen`,
    [input.name, input.session_id, input.role ?? null, input.now, input.now],
  );
  const row = db.conn.get<MailboxRow>("SELECT * FROM mailboxes WHERE name = ?", [input.name]);
  if (!row) {
    throw new Error("registerMailbox: row missing after upsert");
  }
  return rowToMailbox(row);
}

export function mailboxBySession(db: MeshDb, session_id: string): Mailbox | null {
  const row = db.conn.get<MailboxRow>("SELECT * FROM mailboxes WHERE session_id = ?", [session_id]);
  return row ? rowToMailbox(row) : null;
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

export function touchMailbox(db: MeshDb, session_id: string, now: number): void {
  db.conn.run("UPDATE mailboxes SET last_seen = ? WHERE session_id = ?", [now, session_id]);
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
    `INSERT INTO messages (id, from_node, from_box, subject, body, reply_to, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.from,
      input.from_box ?? null,
      input.subject,
      input.body,
      input.reply_to ?? null,
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
  return { ok: true, id, recipients };
}

// null = unknown single mailbox. Callers guarantee to_box is set.
function resolveRecipients(db: MeshDb, input: DeliverInput): string[] | null {
  const target = input.to_box ?? "";
  if (target === "all") {
    return listMailboxes(db)
      .map((b) => b.name)
      .filter((name) => name !== input.from_box);
  }
  if (target.startsWith("team:")) {
    // Pools are stored under their full "team:<name>" id, matching mesh_join.
    return listMailboxes(db)
      .filter((b) => b.pools.includes(target) && b.name !== input.from_box)
      .map((b) => b.name);
  }
  const box = mailboxByName(db, target);
  return box ? [box.name] : null;
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
  const box = mailboxBySession(db, session_id);
  const rows = box ? [...deliveryRows(db, box.name), ...globalRows(db)] : globalRows(db);
  return rows.sort((a, b) => a.created_at - b.created_at);
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
