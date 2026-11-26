import { describe, expect, it } from "vitest";
import { openMeshDb } from "../src/lib/db.js";
import {
  askTask,
  getTask,
  mergeFederatedRegistry,
  registerMailbox,
  replyTask,
} from "../src/lib/mail.js";
import {
  claimOutboxDue,
  handleTaskAsk,
  queueTaskAsk,
  queueTaskReply,
  markOutboxFailed,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  processOutbox,
  queueOutbox,
  type OutboxPayload,
} from "../src/lib/outbox.js";

const payload = (over: Partial<OutboxPayload> = {}): OutboxPayload => ({
  node_id: "peer-1",
  to_box: "remote-box",
  from_box: "me",
  subject: "s",
  body: "b",
  origin_id: "origin-1",
  ...over,
});

describe("the outbox (refonte P2.6): queued, retried, effectively-once", () => {
  it("queueOutbox lands the row and claimOutboxDue claims it once (single-flight)", () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    queueOutbox(db, payload(), now);
    const claimed = claimOutboxDue(db, now + 1000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload.to_box).toBe("remote-box");
    // A second claim in the same window: nothing (the next_at was pushed).
    expect(claimOutboxDue(db, now + 1001)).toHaveLength(0);
    db.close();
  });

  it("processOutbox marks sent on a null error and failed on an error string", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    queueOutbox(db, payload({ origin_id: "o-ok" }), now);
    queueOutbox(db, payload({ origin_id: "o-fail", node_id: "peer-dead" }), now);
    const res = await processOutbox(db, now + 1000, async (p) =>
      p.node_id === "peer-dead" ? "unreachable" : null,
    );
    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    const states = db.conn
      .all<{ origin: string; state: string }>(
        "SELECT json_extract(payload, '$.origin_id') AS origin, state FROM outbox",
      )
      .reduce<Record<string, string>>((acc, r) => {
        acc[r.origin] = r.state;
        return acc;
      }, {});
    expect(states["o-ok"]).toBe("sent");
    expect(states["o-fail"]).toBe("queued"); // retried, not dead yet
    db.close();
  });

  it("the backoff doubles per attempt and caps; past MAX the row dead-letters", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    const row = queueOutbox(db, payload({ origin_id: "o-dead" }), now);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      claimOutboxDue(db, now + i * OUTBOX_BACKOFF_BASE_MS);
      markOutboxFailed(db, row.id, now + i * OUTBOX_BACKOFF_BASE_MS, "down");
    }
    const state = db.conn.get<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM outbox WHERE id = ?",
      [row.id],
    );
    expect(state?.state).toBe("failed");
    expect(state?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    db.close();
  });

  it("the backoff never exceeds the cap", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    const row = queueOutbox(db, payload(), now);
    for (let i = 0; i < 5; i += 1) {
      claimOutboxDue(db, now + i * OUTBOX_BACKOFF_BASE_MS);
      markOutboxFailed(db, row.id, now + i * OUTBOX_BACKOFF_BASE_MS, "down");
    }
    const nextAt = db.conn.get<{ next_at: number; attempts: number }>(
      "SELECT next_at, attempts FROM outbox WHERE id = ?",
      [row.id],
    );
    expect(nextAt?.attempts).toBe(5);
    // The backoff is measured from each ATTEMPT: the last failure was at
    // now + 4*BASE, the next retry at most the 10-min cap later.
    const lastFailureAt = now + 4 * OUTBOX_BACKOFF_BASE_MS;
    expect(nextAt!.next_at - lastFailureAt).toBeLessThanOrEqual(10 * 60 * 1000);
    db.close();
  });
});

describe("P2.5 (refonte): the cross-host tasks — the asker's node is the source of truth", () => {
  it("the round trip: ask crosses, the mirror replies, the reply applies back home", () => {
    // === L'ASKER (le node A): la row originale + l'ask via l'outbox ===
    const a = openMeshDb(":memory:");
    registerMailbox(a, { name: "alice", session_id: "s-a", now: 1000 });
    const fed = mergeFederatedRegistry(
      a,
      [
        {
          name: "bob-remote",
          session_id: "ses-b",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
        },
      ],
      "node-b",
    );
    void fed;
    const task = askTask(a, { from_box: "alice", to_box: "bob-remote", question: "quel etat?" });
    queueTaskAsk(a, task, Date.now());
    // La row originale + la row outbox task-ask.
    expect(getTask(a, task.id)?.state).toBe("submitted");
    const askRow = a.conn.get<{ payload: string; state: string }>(
      "SELECT payload, state FROM outbox WHERE json_extract(payload,'$.type') = 'task-ask'",
    )!;
    expect(askRow.state).toBe("queued");

    // === LE RESPONDANT (le node B): /task-ask cree le MIROIR (le meme id) ===
    const b = openMeshDb(":memory:");
    registerMailbox(b, { name: "bob-remote", session_id: "s-b", now: 1000 });
    const askPayload = JSON.parse(askRow.payload) as Parameters<typeof handleTaskAsk>[1];
    handleTaskAsk(b, { ...askPayload, from_box: "node-a/alice" });
    const mirror = getTask(b, task.id)!;
    expect(mirror.state).toBe("submitted");
    expect(mirror.from_box).toBe("node-a/alice");
    // Le message tache est dans la box du respondant.
    expect(
      b.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'bob-remote'")
        ?.n,
    ).toBe(1);

    // === LE RESPONDANT repond: le miroir passe completed, la reply REPART par l'outbox ===
    const rep = replyTask(b, task.id, "bob-remote", "build vert", "completed");
    expect(rep.ok).toBe(true);
    expect(rep.cross).toBe(true);
    // La couche tools (mesh_reply) queue le cross-reply a la frontiere.
    queueTaskReply(b, task.id, "build vert", "completed", Date.now());
    const replyRow = b.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.type') = 'task-reply'",
    )!;
    const replyPayload = JSON.parse(replyRow.payload);
    expect(replyPayload.node_id).toBe("node-a");
    expect(replyPayload.task.state).toBe("completed");

    // === L'ASKER applique la reply (le /task-reply): la row originale + la notification ===
    const applied = replyTask(
      a,
      task.id,
      task.to_box,
      replyPayload.task.result,
      replyPayload.task.state,
    );
    expect(applied.ok).toBe(true);
    expect(applied.notified).toBe(true);
    expect(getTask(a, task.id)?.state).toBe("completed");
    const got = a.conn.get<{ body: string }>(
      "SELECT m.body FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'alice'",
    )!;
    expect(got.body).toContain("build vert");
    a.close();
    b.close();
  });
});
