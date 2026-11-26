import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { MeshDb } from "./db.js";
import { sendMail } from "./client.js";
import { pairingProof, type NodeIdentity } from "./identity.js";
import { findSendablePeer, resolvePeerTarget } from "./peers.js";

// The outbox (the refonte P2.6): mesh_send writes the remote delivery here
// and returns "queued" — the background sender delivers with ack and
// retries with backoff. The agent never sees "unreachable" again: a
// transient peer outage is the sender's problem, not the asking agent's
// token burn.

export type OutboxPayload = {
  /** The TARGET NODE id (the peer) — resolved fresh at delivery (the peer
   * may have moved: the address/token/proof are never frozen in the row). */
  node_id: string;
  /** For a federated target: the box NAME; the owner is resolved at
   * delivery. For a peer target: the remote box. */
  to_box: string;
  from_box: string | null;
  subject: string;
  body: string;
  reply_to?: string | null;
  kind?: "notify" | "fyi";
  /** The delivery dedup (effectively-once): the sender carries origin_id —
   * a retried delivery collapses at the receiver. */
  origin_id: string;
};

export type OutboxRow = {
  id: string;
  payload: OutboxPayload;
  state: "queued" | "sent" | "failed";
  attempts: number;
  next_at: number;
  last_error: string | null;
  created_at: number;
};

export const OUTBOX_BACKOFF_BASE_MS = 30_000;
export const OUTBOX_BACKOFF_CAP_MS = 10 * 60 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 12;

/** Queue a remote delivery: the row lands, the caller answers "queued". */
export function queueOutbox(db: MeshDb, payload: OutboxPayload, now: number): OutboxRow {
  const id = randomUUID();
  db.conn.run(
    `INSERT INTO outbox (id, payload, state, attempts, next_at, created_at)
     VALUES (?, ?, 'queued', 0, ?, ?)`,
    [id, JSON.stringify(payload), now, now],
  );
  return {
    id,
    payload,
    state: "queued",
    attempts: 0,
    next_at: now,
    last_error: null,
    created_at: now,
  };
}

/** Claim the due rows ATOMICALLY (single-flight across instances): the
 * claimed rows get next_at pushed forward so a concurrent sender skips
 * them. Returns the claimed rows. */
export function claimOutboxDue(db: MeshDb, now: number): OutboxRow[] {
  const due = db.conn.all<{ id: string; payload: string; attempts: number }>(
    "SELECT id, payload, attempts FROM outbox WHERE state = 'queued' AND next_at <= ? ORDER BY created_at ASC LIMIT 20",
    [now],
  );
  const rows: OutboxRow[] = [];
  for (const r of due) {
    const res = db.conn.run(
      "UPDATE outbox SET next_at = ? WHERE id = ? AND state = 'queued' AND next_at <= ?",
      [now + OUTBOX_BACKOFF_BASE_MS, r.id, now],
    );
    if (res.changes === 1) {
      rows.push({
        id: r.id,
        payload: JSON.parse(r.payload) as OutboxPayload,
        state: "queued",
        attempts: r.attempts,
        next_at: now + OUTBOX_BACKOFF_BASE_MS,
        last_error: null,
        created_at: 0,
      });
    }
  }
  return rows;
}

/** Mark a delivery sent. */
export function markOutboxSent(db: MeshDb, id: string, now: number): void {
  db.conn.run("UPDATE outbox SET state = 'sent', next_at = ? WHERE id = ?", [now, id]);
}

/** Mark a delivery failed: the attempts grow, the backoff doubles (capped).
 * Past OUTBOX_MAX_ATTEMPTS the row goes to 'failed' (dead-letter — visible
 * in mesh_status, never re-thrown at an agent). */
export function markOutboxFailed(db: MeshDb, id: string, now: number, error: string): void {
  const row = db.conn.get<{ attempts: number }>("SELECT attempts FROM outbox WHERE id = ?", [id]);
  if (!row) return;
  const attempts = row.attempts + 1;
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    db.conn.run("UPDATE outbox SET state = 'failed', attempts = ?, last_error = ? WHERE id = ?", [
      attempts,
      error,
      id,
    ]);
    return;
  }
  const backoff = Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** attempts, OUTBOX_BACKOFF_CAP_MS);
  db.conn.run("UPDATE outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?", [
    attempts,
    now + backoff,
    error,
    id,
  ]);
}

/** The outbox sender: claim the due rows, deliver each through the caller's
 * transport, mark sent or failed. Returns { sent, failed } for the log. */
export async function processOutbox(
  db: MeshDb,
  now: number,
  deliver: (payload: OutboxPayload) => Promise<string | null>,
): Promise<{ sent: number; failed: number }> {
  const rows = claimOutboxDue(db, now);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const error = await deliver(row.payload);
      if (error === null) {
        markOutboxSent(db, row.id, now);
        sent += 1;
      } else {
        markOutboxFailed(db, row.id, now, error);
        failed += 1;
      }
    } catch (error) {
      markOutboxFailed(db, row.id, now, String(error).slice(0, 200));
      failed += 1;
    }
  }
  return { sent, failed };
}

/** The background sender: every tick, claim the due rows and deliver — the
 * peer conn is resolved FRESH at delivery (a moved peer, a fresh mDNS
 * announce, a re-paired token are picked up without the asking agent ever
 * knowing). "unreachable" triggers a rebrowse. Used by BOTH plugins (v1 and
 * v2 host the same mesh store). */
export function startOutboxSender(
  db: MeshDb,
  identity: NodeIdentity,
  rebrowse: () => void,
  intervalMs = 1_000,
): { stop(): void } {
  appendFileSync("/tmp/opencode/sender.log", "sender CREE\n");
  const timer = setInterval(() => {
    appendFileSync("/tmp/opencode/sender.log", "tick\n");
    void (async () => {
      const due = db.conn.all<{ id: string }>(
        "SELECT id FROM outbox WHERE state = 'queued' AND next_at <= ?",
      ).length;
      appendFileSync("/tmp/opencode/sender.log", `sweep: due=${due}\n`);
      return null;
    })();
    void processOutbox(db, Date.now(), async (payload) => {
      const target = findSendablePeer(db, payload.node_id);
      if (!target) return "no paired peer";
      const conn = resolvePeerTarget(db, payload.node_id);
      if (!conn) return "no known address";
      const sent = await sendMail({
        url: conn.url,
        ...(conn.tls ? { tls: true } : {}),
        ...(conn.pk !== null ? { pk: conn.pk } : {}),
        token: target.token ?? "",
        from: identity.node_id,
        subject: payload.subject,
        body: payload.body,
        proof: pairingProof(identity, target.token ?? ""),
        ...(payload.to_box ? { to: payload.to_box } : {}),
        ...(payload.from_box ? { from_box: payload.from_box } : {}),
        ...(payload.reply_to ? { reply_to: payload.reply_to } : {}),
        origin_id: payload.origin_id,
      });
      if (sent === "unreachable") rebrowse();
      return sent === "ok" ? null : sent;
    });
  }, intervalMs);
  return {
    stop: () => {
      appendFileSync("/tmp/opencode/sender.log", "STOP appele\n");
      clearInterval(timer);
    },
  };
}

/** The lazy sweep: the standard deliver path, callable from the tools (the
 * mesh_inbox/mesh_status entries sweep before reading — the delivery happens
 * when someone looks, without depending on a background timer). */
export function sweepOutbox(
  db: MeshDb,
  identity: NodeIdentity,
  rebrowse: () => void,
): Promise<{ sent: number; failed: number }> {
  return processOutbox(db, Date.now(), async (payload) => {
    const target = findSendablePeer(db, payload.node_id);
    if (!target) return "no paired peer";
    const conn = resolvePeerTarget(db, payload.node_id);
    if (!conn) return "no known address";
    const sent = await sendMail({
      url: conn.url,
      ...(conn.tls ? { tls: true } : {}),
      ...(conn.pk !== null ? { pk: conn.pk } : {}),
      token: target.token ?? "",
      from: identity.node_id,
      subject: payload.subject,
      body: payload.body,
      proof: pairingProof(identity, target.token ?? ""),
      ...(payload.to_box ? { to: payload.to_box } : {}),
      ...(payload.from_box ? { from_box: payload.from_box } : {}),
      ...(payload.reply_to ? { reply_to: payload.reply_to } : {}),
      origin_id: payload.origin_id,
    });
    if (sent === "unreachable") rebrowse();
    return sent === "ok" ? null : sent;
  });
}
