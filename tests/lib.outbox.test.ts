import { describe, expect, it } from "vitest";
import { openMeshDb } from "../src/lib/db.js";
import {
  claimOutboxDue,
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
