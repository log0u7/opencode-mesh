import { randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";
import type { MailMessage } from "../types/peer.js";

export function receiveMessage(
  db: MeshDb,
  input: { from: string; subject: string; body: string },
): MailMessage {
  const message: MailMessage = {
    id: randomUUID(),
    from: input.from,
    to: "self",
    session_id: null,
    subject: input.subject,
    body: input.body,
    status: "unread",
    created_at: Date.now(),
  };

  db.conn.run(
    "INSERT INTO messages (id, from_node, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'unread', ?)",
    [message.id, message.from, message.subject, message.body, message.created_at],
  );

  return message;
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

export function ackMessages(db: MeshDb, ids: string[]): void {
  for (const id of ids) {
    db.conn.run("UPDATE messages SET status = 'read' WHERE id = ?", [id]);
  }
}

type MessageRow = {
  id: string;
  from_node: string;
  subject: string;
  body: string;
  status: string;
  created_at: number;
};

function rowToMessage(row: MessageRow): MailMessage {
  return {
    id: row.id,
    from: row.from_node,
    to: "self",
    session_id: null,
    subject: row.subject,
    body: row.body,
    status: row.status === "read" ? "read" : "unread",
    created_at: row.created_at,
  };
}
