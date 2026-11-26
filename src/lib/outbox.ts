import { randomUUID } from "node:crypto";
import type { MeshDb } from "./db.js";
import { postTaskWire, sendMail } from "./client.js";
import { pairingProof, type NodeIdentity } from "./identity.js";
import { findSendablePeer, resolvePeerTarget } from "./peers.js";
import { deliverMessage, federatedByName, getTask, mailboxByName, type TaskState } from "./mail.js";

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
  /** The payload type (refonte P2.5): mail (default) | task-ask | task-reply
   * — the sender routes the task payloads to the dedicated endpoints. */
  type?: OutboxType;
  /** The task fields for the task payloads. */
  task?: {
    id: string;
    from_box: string | null;
    to_box: string;
    question?: string;
    group_id?: string | null;
    deadline?: number | null;
    result?: string;
    state?: TaskState;
  };
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
  hub?: { isOpen(nodeId: string): boolean; push(nodeId: string, event: unknown): number },
): { stop(): void } {
  const timer = setInterval(() => {
    void processOutbox(db, Date.now(), async (payload) => {
      // The task payloads route by the FEDERATED box (the owner resolved at
      // delivery), not by node_id.
      const nodeQuery =
        payload.type === "task-reply" && payload.node_id
          ? payload.node_id // the explicit asker's node (the name-collision safe)
          : payload.type === "task-ask"
            ? (federatedByName(db, payload.to_box)?.node_id ?? payload.node_id)
            : payload.node_id;
      if (!nodeQuery) return "no target node";
      // The STREAM first (refonte 3.1): an open peer stream gets the event
      // pushed instantly — no POST, no latency.
      if (hub?.isOpen(nodeQuery)) {
        const delivered = hub.push(nodeQuery, {
          type: payload.type ?? "mail",
          data: {
            from: identity.node_id,
            from_box: payload.from_box,
            to: payload.to_box,
            subject: payload.subject,
            body: payload.body,
            reply_to: payload.reply_to,
            origin_id: payload.origin_id,
            ...(payload.type === "task-ask" || payload.type === "task-reply"
              ? { task: payload.task }
              : {}),
          },
        });
        if (delivered > 0) return null;
      }
      const target = findSendablePeer(db, nodeQuery);
      if (!target) return "no paired peer";
      const conn = resolvePeerTarget(db, nodeQuery);
      if (!conn) return "no known address";
      if (payload.type === "task-ask" || payload.type === "task-reply") {
        const ok = await postTaskWire({
          url: conn.url,
          ...(conn.tls ? { tls: true } : {}),
          ...(conn.pk !== null ? { pk: conn.pk } : {}),
          token: target.token ?? "",
          from: identity.node_id,
          proof: pairingProof(identity, target.token ?? ""),
          payload,
        });
        return ok ? null : ok;
      }
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
    stop: () => clearInterval(timer),
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
    // The task payloads route to the dedicated endpoints (the same routing
    // as the background sender — the lazy sweep must not lose them).
    if (payload.type === "task-ask" || payload.type === "task-reply") {
      // task-reply: the EXPLICIT composite node (the name-collision safe);
      // task-ask: the federated owner resolved by name.
      const fedNode =
        payload.type === "task-reply" && payload.node_id
          ? payload.node_id
          : (federatedByName(db, payload.to_box)?.node_id ?? payload.node_id);
      const target = findSendablePeer(db, fedNode);
      if (!target) return "no paired peer";
      const conn = resolvePeerTarget(db, fedNode);
      if (!conn) return "no known address";
      const ok = await postTaskWire({
        url: conn.url,
        ...(conn.tls ? { tls: true } : {}),
        ...(conn.pk !== null ? { pk: conn.pk } : {}),
        token: target.token ?? "",
        from: identity.node_id,
        proof: pairingProof(identity, target.token ?? ""),
        payload,
      });
      return ok === "ok" ? null : ok;
    }
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

/** The cross-host task payloads (the refonte P2.5): the task travels as an
 * outbox row, the terminal state comes back through the same channel. The
 * ASKER'S node is the source of truth; the responder's node holds a MIRROR
 * row (the SAME id) so its mesh_reply works locally. */
export type OutboxType = "mail" | "task-ask" | "task-reply";

/** The asker's side: queue the task ask to the responder's node. */
export function queueTaskAsk(
  db: MeshDb,
  task: {
    id: string;
    from_box: string | null;
    to_box: string;
    question: string;
    group_id: string | null;
    deadline: number | null;
  },
  now: number,
): string {
  const row = queueOutbox(
    db,
    {
      node_id: "",
      to_box: task.to_box,
      from_box: task.from_box,
      subject: `task ${task.id.slice(0, 8)}`,
      body: task.question,
      origin_id: task.id,
      type: "task-ask",
      task: {
        id: task.id,
        from_box: task.from_box,
        to_box: task.to_box,
        question: task.question,
        group_id: task.group_id,
        deadline: task.deadline,
      },
    } as OutboxPayload,
    now,
  );
  return row.id;
}

/** The responder's side (POST /task-ask): create the MIRROR row (the same
 * id — the reply correlation is the id itself) and deliver the task message
 * to the local responder's box. */
export function handleTaskAsk(db: MeshDb, payload: OutboxPayload): void {
  const t = payload.task;
  if (!t) return;
  const now = Date.now();
  const existing = db.conn.get<{ id: string }>("SELECT id FROM tasks WHERE id = ?", [t.id]);
  if (existing) return;
  db.conn.run(
    `INSERT INTO tasks (id, from_box, to_box, group_id, question, result, state, created_at, updated_at, deadline)
     VALUES (?, ?, ?, ?, ?, NULL, 'submitted', ?, ?, ?)`,
    [
      t.id,
      payload.from_box ?? null,
      t.to_box,
      t.group_id ?? null,
      t.question,
      now,
      now,
      t.deadline,
    ],
  );
  deliverMessage(db, {
    from: "mesh-tasks",
    from_box: payload.from_box,
    to_box: t.to_box,
    subject: `task ${t.id.slice(0, 8)}: ${(t.question ?? "").slice(0, 60)}`,
    body:
      `${t.question ?? ""}\n\n` +
      `Reply with: mesh_reply(task_id="${t.id}", result="...", state="completed") ` +
      `— the asker is on another node: the reply travels back automatically.`,
    kind: "notify",
  });
}

/** The responder's side: the reply to a MIRROR task crosses back to the
 * asker's node (the mirror's from_box is NOT a local box). */
export function queueTaskReply(
  db: MeshDb,
  taskId: string,
  result: string,
  state: TaskState,
  now: number,
): string | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  // The mirror detection: the asker's box is not local (a federated row).
  if (mailboxByName(db, task.from_box ?? "")) return null;
  // The asker's remote reference: "node/box" (the /task-ask composite) —
  // the node drives the delivery, the box rides for the asker's records.
  const sep = (task.from_box ?? "").indexOf("/");
  const askerNode = sep > 0 ? task.from_box!.slice(0, sep) : "";
  const askerBox = sep > 0 ? task.from_box!.slice(sep + 1) : (task.from_box ?? "");
  const row = queueOutbox(
    db,
    {
      node_id: askerNode,
      to_box: askerBox,
      from_box: task.to_box,
      subject: `task-reply ${task.id.slice(0, 8)}`,
      body: result,
      origin_id: `${task.id}:${state}`,
      type: "task-reply",
      task: { id: task.id, result, state },
    } as OutboxPayload,
    now,
  );
  return row.id;
}
