import { randomUUID } from "node:crypto";
import type { MeshDb } from "./db.js";
import { postRegistrySync, postTaskWire, sendMail } from "./client.js";
import { pairingProof, type NodeIdentity } from "./identity.js";
import { findSendablePeer, listPeers, resolvePeerTarget } from "./peers.js";
import {
  deliverMessage,
  federatedByName,
  getTask,
  localRegistryRows,
  mailboxByName,
  mailboxByName as mailboxesByNameLocal,
  type TaskState,
} from "./mail.js";

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
  /** Deliberate broadcast wake (0.17.0): the flag rides the payload so the
   * remote receiver's gate sees it (the 0.34.2: the federated path dropped
   * both fields — an fyi crossed the wire as notify and woke). */
  wake?: boolean;
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

// The nudge registry (the refonte2-B4): queueOutbox WAKES the sender — a
// trigger, never an await. The tools' turns never block on a sweep: the
// row lands, the nudge fires, the background sender delivers.
const nudges = new Set<() => void>();

/** The sender registers its immediate-sweep hook (a nudge = the non-blocking
 * trigger; the interval stays as the safety net). */
export function registerOutboxNudge(nudge: () => void): () => void {
  nudges.add(nudge);
  return () => nudges.delete(nudge);
}

/** Queue a remote delivery: the row lands, the caller answers "queued", the
 * sender is nudged. */
/** The undeliverable-mail bounce (the 0.33.5): a node that receives mail
 * (or a task) for a box it does not own queues a bounce back to the
 * SENDER's box — the ack alone lied ("queued" while the mail sank into the
 * legacy global inbox nobody drains: the orq->blogger wrong-peer loss). */
export function queueBounce(
  db: MeshDb,
  input: {
    nodeId: string;
    toBox: string;
    hostname: string;
    subject: string;
    body: string;
    missingBox: string;
  },
): string {
  return queueOutbox(
    db,
    {
      node_id: input.nodeId,
      to_box: input.toBox,
      from_box: "mesh-mailer",
      subject: `bounce: ${input.subject.slice(0, 80)}`,
      body:
        `undeliverable: la boîte '${input.missingBox}' n'existe pas sur ce nœud (${input.hostname}) — ` +
        `vérifie le peer du destinataire (même hôte: pas de peer). Original: ${input.subject} — ${input.body.slice(0, 200)}`,
      origin_id: `bounce:${randomUUID()}`,
      type: "mail",
    } as OutboxPayload,
    Date.now(),
  ).id;
}

export function queueOutbox(db: MeshDb, payload: OutboxPayload, now: number): OutboxRow {
  const id = randomUUID();
  db.conn.run(
    `INSERT INTO outbox (id, payload, origin_id, state, attempts, next_at, created_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
    [id, JSON.stringify(payload), payload.origin_id, now, now],
  );
  for (const nudge of nudges) {
    try {
      nudge();
    } catch {
      // The nudge must never take the queue down with it.
    }
  }
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
  try {
    db.conn.run("UPDATE outbox SET state = 'sent', next_at = ? WHERE id = ?", [now, id]);
  } catch {
    // The store closed under the in-flight sweep (the dispose race): the
    // end-of-process state, not a delivery failure.
  }
}

/** Mark a delivery failed: the attempts grow, the backoff doubles (capped).
 * Past OUTBOX_MAX_ATTEMPTS the row goes to 'failed' (dead-letter — visible
 * in mesh_status, never re-thrown at an agent). */
export function markOutboxFailed(db: MeshDb, id: string, now: number, error: string): void {
  let row: { attempts: number } | null;
  try {
    row = db.conn.get<{ attempts: number }>("SELECT attempts FROM outbox WHERE id = ?", [id]);
  } catch {
    return; // the store closed under the in-flight sweep (the dispose race)
  }
  if (!row) return;
  const attempts = row.attempts + 1;
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    db.conn.run("UPDATE outbox SET state = 'failed', attempts = ?, last_error = ? WHERE id = ?", [
      attempts,
      error,
      id,
    ]);
    // The dead-letter is NEVER silent (the refonte2-C2): the sender's task
    // (if the payload carries one) goes failed and the task's asker is
    // notified — a lost delivery without a trace was the silent-loss class.
    const payload = JSON.parse(
      db.conn.get<{ payload: string }>("SELECT payload FROM outbox WHERE id = ?", [id])!.payload,
    ) as OutboxPayload;
    const taskId = payload.task?.id ?? payload.origin_id;
    const task = taskId ? getTask(db, taskId) : null;
    if (task && !["completed", "failed", "canceled"].includes(task.state)) {
      try {
        deliverMessage(db, {
          from: "mesh-tasks",
          from_box: task.to_box,
          to_box: task.from_box ?? "",
          subject: `task ${task.id.slice(0, 8)} failed: delivery dead-lettered`,
          body: `The delivery failed ${attempts} times (${error.slice(0, 120)}). The task is FAILED.`,
          kind: "notify",
        });
      } catch {}
      if (mailboxesByNameLocal(db, task.to_box)) {
        db.conn.run("UPDATE tasks SET result = ?, state = 'failed', updated_at = ? WHERE id = ?", [
          `dead-letter: ${error.slice(0, 120)}`,
          now,
          taskId,
        ]);
      }
    }
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

/** The /ack applied (the refonte2-C6): the receiver confirmed the origin —
 * the row goes sent. The origin_id is the dedup key the receiver already
 * holds. */
export function markOutboxSentByOrigin(
  db: MeshDb,
  originId: string,
  now: number,
  fromNodeId?: string,
): number {
  // The node filter (the refonte2-P1): only the OWNER's ack applies — a
  // third-party ack cannot mark someone else's row sent.
  const res = fromNodeId
    ? db.conn.run(
        "UPDATE outbox SET state = 'sent', next_at = ? WHERE origin_id = ? AND json_extract(payload, '$.node_id') = ?",
        [now, originId, fromNodeId],
      )
    : db.conn.run("UPDATE outbox SET state = 'sent', next_at = ? WHERE origin_id = ?", [
        now,
        originId,
      ]);
  return res.changes;
}

/** The outbox sender: claim the due rows, deliver each through the caller's
 * transport, mark sent or failed. Returns { sent, failed } for the log. */
export async function processOutbox(
  db: MeshDb,
  now: number,
  deliver: (payload: OutboxPayload, attempts: number) => Promise<string | null>,
): Promise<{ sent: number; failed: number }> {
  const rows = claimOutboxDue(db, now);
  // The per-peer concurrency (the refonte2-B4): the rows GROUP by node —
  // a dead peer's timeouts never block the other peers' deliveries (the
  // head-of-line class). Within a node: sequential (the ordering holds).
  const byNode = new Map<string, typeof rows>();
  for (const row of rows) {
    const node = row.payload.node_id;
    const group = byNode.get(node) ?? [];
    group.push(row);
    byNode.set(node, group);
  }
  let sent = 0;
  let failed = 0;
  await Promise.all(
    [...byNode.values()].map(async (group) => {
      for (const row of group) {
        try {
          // The attempts ride with the row (the 0.33.3-E): the stream is a
          // first-attempt path only, the retries go POST.
          const error = await deliver(row.payload, row.attempts);
          if (error === "streamed") {
            // Pushed over the stream, NOT acked yet: the row stays queued —
            // the receiver's /ack marks it sent; the claim's 30s next_at is
            // the resend window (the half-dead socket class).
            continue;
          }
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
    }),
  );
  return { sent, failed };
}

/** THE single delivery function (the refonte 2-A): ONE copy of the routing
 * (stream-first, the task endpoints, the mail) — the background sender and
 * the lazy sweep both call it. Two divergent copies shipped a task reply
 * down /mail and marked it sent (the mr-review round-4 B1: an error 401 is
 * truthy, `ok ? null : ok` maps it to null = delivered). The contract:
 * null = delivered, a non-empty string = the failure reason. */
export async function deliverOutboxRow(
  db: MeshDb,
  identity: NodeIdentity,
  rebrowse: () => void,
  hub:
    | { isOpen(nodeId: string): boolean; push(nodeId: string, event: unknown): number }
    | undefined,
  payload: OutboxPayload,
  attempts = 0,
): Promise<string | null> {
  // The task payloads route by the FEDERATED box (the owner resolved at
  // delivery), except task-reply: the EXPLICIT composite node (the
  // name-collision safe — two nodes can carry the same bare box name).
  const nodeQuery =
    payload.type === "task-reply" && payload.node_id
      ? payload.node_id
      : payload.type === "task-ask"
        ? (federatedByName(db, payload.to_box)?.node_id ?? payload.node_id)
        : payload.node_id;
  if (!nodeQuery) return "no target node";
  // The STREAM first — but ONLY on the first attempt (the 0.33.3-E): a
  // stream push is at-most-once (the ack flows back from the receiver's
  // consumer); an UNACKED first attempt falls back to the POST path on the
  // retries (the attempts >= 1 rows go POST — the synchronous response
  // marks the row sent or the error retried).
  if (attempts === 0 && hub?.isOpen(nodeQuery)) {
    const delivered = hub.push(nodeQuery, {
      type: payload.type ?? "mail",
      data: {
        from: identity.node_id,
        from_box: payload.from_box,
        to: payload.to_box,
        subject: payload.subject,
        body: payload.body,
        reply_to: payload.reply_to,
        kind: payload.kind ?? "notify",
        origin_id: payload.origin_id,
        ...(payload.type === "task-ask" ||
        payload.type === "task-reply" ||
        payload.type === "task-input"
          ? { task: payload.task }
          : {}),
      },
    });
    if (delivered > 0) {
      // Pushed, NOT acked: the row stays queued, the attempts INCREMENT
      // (the dead-letter is reachable if no /ack returns); the claim's 30s
      // next_at is the resend window.
      const row = db.conn.get<{ id: string; attempts: number }>(
        "SELECT id, attempts FROM outbox WHERE json_extract(payload, '$.origin_id') = ?",
        [payload.origin_id],
      );
      if (row && row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) {
        markOutboxFailed(db, row.id, Date.now(), "pushed but never acked");
      } else if (row) {
        db.conn.run("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?", [row.id]);
      }
      return "streamed";
    }
  }
  const target = findSendablePeer(db, nodeQuery);
  if (!target) {
    return "no paired peer";
  }
  const conn = resolvePeerTarget(db, nodeQuery);
  if (!conn) {
    return "no known address";
  }
  if (
    payload.type === "task-ask" ||
    payload.type === "task-reply" ||
    payload.type === "task-input"
  ) {
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
    // The kind rides the wire (0.34.2): the dropped kind made every
    // cross-host fyi arrive as notify and wake the remote box (the T2
    // incident).
    ...(payload.kind ? { kind: payload.kind } : {}),
    ...(payload.wake ? { wake: true } : {}),
  });
  if (sent === "unreachable") rebrowse();
  return sent === "ok" ? null : sent;
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
  const sweep = () => {
    void processOutbox(db, Date.now(), (payload, attempts) =>
      deliverOutboxRow(db, identity, rebrowse, hub, payload, attempts),
    );
  };
  const timer = setInterval(sweep, intervalMs);
  const unNudge = registerOutboxNudge(sweep);
  return {
    stop: () => {
      clearInterval(timer);
      unNudge();
    },
  };
}

/** The lazy sweep: ONE deliver copy (deliverOutboxRow) — the delivery
 * happens when someone looks, without depending on a background timer. */
export function sweepOutbox(
  db: MeshDb,
  identity: NodeIdentity,
  rebrowse: () => void,
  hub?: { isOpen(nodeId: string): boolean; push(nodeId: string, event: unknown): number },
): Promise<{ sent: number; failed: number }> {
  return processOutbox(db, Date.now(), (payload) =>
    deliverOutboxRow(db, identity, rebrowse, hub, payload),
  );
}

/** The cross-host task payloads (the refonte P2.5): the task travels as an
 * outbox row, the terminal state comes back through the same channel. The
 * ASKER'S node is the source of truth; the responder's node holds a MIRROR
 * row (the SAME id) so its mesh_reply works locally. */
export type OutboxType = "mail" | "task-ask" | "task-reply" | "task-input";

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

/** The ASKER'S side (0.34.6, the input channel): the asker feeds an input on
 * a paused (input_required) task — the payload crosses to the RESPONDER'S
 * node (the mirror row lives there), the ack is the origin_id. */
export function queueTaskInput(
  db: MeshDb,
  task: {
    id: string;
    from_box: string | null;
    to_box: string;
    input: string;
    target_node: string | null;
  },
  now: number,
): string {
  const row = queueOutbox(
    db,
    {
      node_id: task.target_node ?? "",
      to_box: task.to_box,
      from_box: task.from_box,
      subject: `task ${task.id.slice(0, 8)}`,
      body: task.input,
      // A UNIQUE origin_id PER INPUT (0.34.6 round 2, the PO audit): the
      // task.id collided with the task-ask row (the same id) — one ack
      // marked BOTH, and the deliverMessage dedup swallowed every SECOND
      // input on the same task (the second input_required -> input cycle
      // was silently lost).
      origin_id: `${task.id}:input:${randomUUID()}`,
      type: "task-input",
      task: {
        id: task.id,
        from_box: task.from_box,
        to_box: task.to_box,
        result: task.input,
        state: "working",
      },
    } as OutboxPayload,
    now,
  );
  return row.id;
}

/** The responder's side (POST /task-input): apply the asker's input to the
 * MIRROR row — input_required -> working, the paused deadline resumes. An
 * idempotent apply: a second input on a working/terminal task is a no-op
 * (the dedup by state — the ack returned anyway). */
export function handleTaskInput(db: MeshDb, payload: OutboxPayload): void {
  const t = payload.task;
  if (!t?.id) return;
  const task = db.conn.get<{ state: string; deadline_left: number | null }>(
    "SELECT state, deadline_left FROM tasks WHERE id = ?",
    [t.id],
  );
  if (!task || task.state !== "input_required") return;
  const now = Date.now();
  const resumed = task.deadline_left === null ? null : now + task.deadline_left;
  db.conn.run(
    "UPDATE tasks SET input = ?, state = 'working', updated_at = ?, deadline = ?, deadline_left = NULL WHERE id = ?",
    [t.result ?? "", now, resumed, t.id],
  );
  // The avis to the responder (the local box): the asker's input arrived,
  // the task is back in working — the responder must NOT be woken by the
  // input itself (it is mid-work): the avis rides kind notify but the task
  // flash is the wake — the deadline resumed, the next flash will carry it.
  deliverMessage(db, {
    from: payload.from_box ?? "mesh-tasks",
    from_box: payload.from_box ?? null,
    to_box: t.to_box,
    subject: `task ${t.id.slice(0, 8)} resumed working`,
    body: `asker input: ${t.result ?? ""}\n(task ${t.id.slice(0, 8)}, deadline resumed)`,
    kind: "notify",
    task_id: t.id,
  });
}

/** The responder's side (POST /task-ask): create the MIRROR row (the same
 * id — the reply correlation is the id itself) and deliver the task message
 * to the local responder's box. */
export function handleTaskAsk(db: MeshDb, payload: OutboxPayload, askerNode: string): void {
  const t = payload.task;
  if (!t) return;
  const now = Date.now();
  const existing = db.conn.get<{ id: string }>("SELECT id FROM tasks WHERE id = ?", [t.id]);
  if (existing) return;
  db.conn.run(
    `INSERT INTO tasks (id, from_box, to_box, group_id, question, result, state, asker_node, created_at, updated_at, deadline)
     VALUES (?, ?, ?, ?, ?, NULL, 'submitted', ?, ?, ?, ?)`,
    [
      t.id,
      // The BARE box (the 0.33.3-B): the asking NODE lives in asker_node —
      // the "node/box" composite is dead.
      payload.from_box ?? null,
      t.to_box,
      t.group_id ?? null,
      t.question,
      askerNode,
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

/** The registry re-push (the 0.33.3-F): the sender's COMPLETE local
 * registry POSTs to every paired peer — at plugin setup and at every peer
 * stream (re)connection. The post-reboot convergence: a restarted node
 * refreshes its peers' federated rows without waiting for a drain. */
export async function syncRegistryToPeers(db: MeshDb, identity: NodeIdentity): Promise<number> {
  let pushed = 0;
  for (const peer of listPeers(db)) {
    if (!peer.paired) continue;
    const target = findSendablePeer(db, peer.node_id);
    const conn = resolvePeerTarget(db, peer.node_id);
    if (!target || !conn) continue;
    const res = await postRegistrySync({
      url: conn.url,
      ...(conn.tls ? { tls: true } : {}),
      ...(conn.pk !== null ? { pk: conn.pk } : {}),
      token: target.token ?? "",
      from: identity.node_id,
      proof: pairingProof(identity, target.token ?? ""),
      registry: localRegistryRows(db),
    });
    if (res === "ok") pushed += 1;
  }
  return pushed;
}

/** The responder's side: the reply to a MIRROR task crosses back to the
 * asker's node (the mirror's from_box is NOT a local box). */ export function queueTaskReply(
  db: MeshDb,
  taskId: string,
  result: string,
  state: TaskState,
  now: number,
): string | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  // The mirror detection (the 0.33.3-B): the row carries the asking NODE —
  // a homonym local box (alice on both nodes) never swallows the reply.
  if (task.asker_node == null) return null;
  const row = queueOutbox(
    db,
    {
      node_id: task.asker_node,
      to_box: task.from_box ?? "",
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
