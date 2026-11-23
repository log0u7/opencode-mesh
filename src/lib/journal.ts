import type { MeshDb } from "./db.js";

// Read-only traffic journal: a query over the existing `messages` table (joined
// to `deliveries` for recipients). No new writes, no new tables — the record
// already exists, this is the on-demand window into it. Bodies are deliberately
// absent: the journal answers WHO/WHAT/WHEN, bodies stay readable via mesh_inbox.

export type JournalRow = {
  /** Creation time, epoch ms. */
  ts: number;
  /** Sender mailbox when named, else the originating node id. */
  from: string;
  /** Resolved recipient mailboxes (one row per delivery); null for legacy
   * global mail. The raw target ("team:x", "all") is not persisted: deliveries
   * store the resolved boxes, so pool membership is reconstructed, not replayed. */
  to: string[] | null;
  subject: string;
  /** One delivery = dm; several (or none: legacy global broadcast) = pool. */
  kind: "dm" | "pool";
  /** origin_id differs from the local id: the mail arrived through cross-host
   * fanout (a remote node originated it). Locally-originated mail keeps
   * origin_id === id, legacy rows have origin_id NULL. */
  forwarded: boolean;
};

export type JournalQueryInput = {
  /** Epoch ms lower bound (inclusive) on message creation time. */
  since?: number;
  /** Keep entries where the mailbox is the sender OR a recipient. */
  mailbox?: string;
  /** Max entries, newest first. Default 50, capped at 200. */
  limit?: number;
  /** Only pool/broadcast traffic (more than one recipient). */
  pool?: boolean;
};

export const JOURNAL_LIMIT_DEFAULT = 50;
export const JOURNAL_LIMIT_MAX = 200;

type RawRow = {
  id: string;
  origin_id: string | null;
  from_node: string;
  from_box: string | null;
  subject: string;
  created_at: number;
  n_deliveries: number;
  to_boxes: string | null;
};

export function journalQuery(db: MeshDb, input: JournalQueryInput = {}): JournalRow[] {
  const rawLimit = input.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(rawLimit, JOURNAL_LIMIT_MAX)
      : JOURNAL_LIMIT_DEFAULT;

  // Counts and recipient lists live in correlated subqueries, not a join: a
  // mailbox filter must keep the FULL recipient set of a matched message
  // (a pool mail filtered down to one member stays a pool mail).
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (typeof input.mailbox === "string" && input.mailbox.length > 0) {
    conditions.push(
      "(m.from_box = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.to_box = ?))",
    );
    params.push(input.mailbox, input.mailbox);
  }
  if (typeof input.since === "number" && Number.isFinite(input.since)) {
    conditions.push("m.created_at >= ?");
    params.push(input.since);
  }
  if (input.pool === true) {
    conditions.push("(SELECT COUNT(*) FROM deliveries d WHERE d.message_id = m.id) > 1");
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db.conn.all<RawRow>(
    `SELECT m.id AS id, m.origin_id AS origin_id, m.from_node AS from_node,
            m.from_box AS from_box, m.subject AS subject, m.created_at AS created_at,
            (SELECT COUNT(*) FROM deliveries d WHERE d.message_id = m.id) AS n_deliveries,
            (SELECT GROUP_CONCAT(d2.to_box) FROM deliveries d2 WHERE d2.message_id = m.id) AS to_boxes
     FROM messages m
     ${where}
     ORDER BY m.created_at DESC
     LIMIT ?`,
    [...params, limit],
  );

  return rows.map((row) => ({
    ts: row.created_at,
    from: row.from_box ?? row.from_node,
    to: row.to_boxes === null ? null : row.to_boxes.split(","),
    subject: row.subject,
    kind: row.n_deliveries === 1 ? "dm" : "pool",
    forwarded: row.origin_id !== null && row.origin_id !== row.id,
  }));
}
