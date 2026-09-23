import { randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";
import type { MailMessage } from "../types/peer.js";

export function receiveMessage(
  db: MeshDb,
  input: { from: string; subject: string; body: string },
): MailMessage {
  const id = randomUUID();
  const created_at = Date.now();

  db.conn.run(
    "INSERT INTO messages (id, from_node, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'unread', ?)",
    [id, input.from, input.subject, input.body, created_at],
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
    subject: row.subject,
    body: row.body,
    status: row.status === "read" ? "read" : "unread",
    created_at: row.created_at,
  };
}
