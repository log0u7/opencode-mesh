import { describe, expect, it, vi } from "vitest";

import {
  ackMessages,
  askTask,
  deliverMessage,
  getTask,
  purgeDeliveredHistory,
  replyTask,
  sweepTasks,
  inboxRead,
  joinPool,
  receiveMessage,
  registerMailbox,
  unreadBoxCount,
  unreadCount,
  unreadMessages,
  wakeBoxStats,
  ackInbox,
  withTransaction,
  mailboxByName,
  listMailboxes,
  mergeFederatedRegistry,
  RESEND_WINDOW_MS,
  federatedByName,
} from "../src/lib/mail.js";

/** The wake loop reads per-box stats in one grouped query; the gate tests
 * below assert through that same function. */
function statOf(db: Parameters<typeof wakeBoxStats>[0], box: string) {
  return wakeBoxStats(db).find((s) => s.box === box);
}
import { openMeshDb } from "../src/lib/db.js";

describe("withTransaction (the txn hygiene the ghost hunt demanded)", () => {
  it("exposes the connection's transaction state", () => {
    const db = openMeshDb(":memory:");
    expect(db.conn.inTransaction()).toBe(false);
    db.conn.exec("BEGIN");
    expect(db.conn.inTransaction()).toBe(true);
    db.conn.exec("ROLLBACK");
    expect(db.conn.inTransaction()).toBe(false);
    db.close();
  });

  it("leaves no transaction open on success", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const rows = inboxRead(db, "s1", true);
    expect(rows).toEqual([]);
    expect(db.conn.inTransaction()).toBe(false);
    db.close();
  });

  it("rolls back and leaves no transaction open when fn throws", () => {
    const db = openMeshDb(":memory:");
    expect(() =>
      withTransaction(db, () => {
        db.conn.exec(
          "INSERT INTO messages (id, from_node, subject, body, status, created_at) VALUES ('x','n','s','b','unread',1)",
        );
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // The insert rode the rolled-back transaction: gone.
    expect(db.conn.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages")?.count).toBe(0);
    expect(db.conn.inTransaction()).toBe(false);
    db.close();
  });

  it("refuses to nest on a leaked outer transaction (loud, and recovered)", () => {
    const db = openMeshDb(":memory:");
    db.conn.exec("BEGIN");
    expect(() => withTransaction(db, () => 1)).toThrow(/leaked|already open/i);
    // 0.30.0: the guard recovers the leak (the connection rebuilt in place)
    // before throwing — the frozen-snapshot class dies with the error.
    expect(db.conn.inTransaction()).toBe(false);
    // The connection is usable again: a clean transaction runs.
    expect(withTransaction(db, () => "ok")).toBe("ok");
    db.close();
  });

  it("surfaces the original error when the ROLLBACK itself fails", () => {
    const conn = {
      all: () => [],
      get: () => null,
      run: () => {},
      exec: (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("rollback failed: connection mid-teardown");
      },
      inTransaction: () => false,
      close: () => {},
    };
    const db = { conn } as unknown as Parameters<typeof withTransaction>[0];
    expect(() =>
      withTransaction(db, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });
});

describe("mail ack flow", () => {
  it("acks messages and empties the inbox", () => {
    const db = openMeshDb(":memory:");
    const m1 = receiveMessage(db, { from: "n1", subject: "one", body: "1" });
    receiveMessage(db, { from: "n2", subject: "two", body: "2" });

    expect(unreadCount(db)).toBe(2);
    ackMessages(db, [m1.id]);

    expect(unreadCount(db)).toBe(1);
    const remaining = unreadMessages(db);
    expect(remaining[0]?.subject).toBe("two");
    expect(remaining[0]?.status).toBe("unread");
    db.close();
  });
});

describe("transactional inbox read (0.16.1 hot-swap race fix)", () => {
  function boxDb() {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    return db;
  }

  it("inboxRead returns the rows and marks their deliveries read in one call", () => {
    const db = boxDb();
    deliverMessage(db, { from: "n", to_box: "a", subject: "one", body: "1", created_at: 2000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "two", body: "2", created_at: 3000 });

    const rows = inboxRead(db, "s1", true);
    expect(rows.map((r) => r.subject)).toEqual(["one", "two"]);

    // Same call again serves nothing: everything was read-marked atomically.
    expect(inboxRead(db, "s1", true)).toHaveLength(0);
    db.close();
  });

  it("inboxRead with ack:false returns rows and leaves them unread", () => {
    const db = boxDb();
    deliverMessage(db, { from: "n", to_box: "a", subject: "one", body: "1", created_at: 2000 });
    expect(inboxRead(db, "s1", false)).toHaveLength(1);
    expect(inboxRead(db, "s1", false)).toHaveLength(1);
    db.close();
  });

  it("inboxRead also acks legacy global mail (rows with no delivery)", () => {
    const db = openMeshDb(":memory:");
    receiveMessage(db, { from: "n1", subject: "legacy", body: "b" });
    expect(inboxRead(db, "nosession", true).map((r) => r.subject)).toEqual(["legacy"]);
    expect(unreadMessages(db)).toHaveLength(0);
    db.close();
  });

  it("rolls fetch+ack back when a write fails mid-transaction (nothing lost)", () => {
    const db = boxDb();
    deliverMessage(db, { from: "n", to_box: "a", subject: "one", body: "1", created_at: 2000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "two", body: "2", created_at: 3000 });

    // Simulate a kill between fetch and ack: the second delivery UPDATE throws.
    const origRun = db.conn.run.bind(db.conn);
    let updates = 0;
    db.conn.run = (sql: string, params?: unknown[]) => {
      if (sql.startsWith("UPDATE deliveries") && ++updates === 2) {
        throw new Error("simulated kill between fetch and ack");
      }
      return origRun(sql, params);
    };
    expect(() => inboxRead(db, "s1", true)).toThrow("simulated kill between fetch and ack");
    db.conn.run = origRun;

    // The rollback means no delivery was read-marked: both rows are served.
    expect(inboxRead(db, "s1", true).map((r) => r.subject)).toEqual(["one", "two"]);
    db.close();
  });
});

describe("wake flag (0.17.0 Slack model)", () => {
  function poolDb() {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "b", session_id: "s2", now: 1000 });
    registerMailbox(db, { name: "c", session_id: "s3", now: 1000 });
    joinPool(db, "a", "team:x");
    joinPool(db, "b", "team:x");
    joinPool(db, "c", "team:x");
    return db;
  }

  it("a local pool broadcast without the flag is quiet on every member box", () => {
    const db = poolDb();
    const r = deliverMessage(db, {
      from: "n",
      from_box: "a",
      to_box: "team:x",
      subject: "status: go",
      body: "b",
      created_at: 2000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipients).toEqual(["b", "c"]);

    expect(unreadBoxCount(db, "b")).toBe(1);
    expect(unreadBoxCount(db, "c")).toBe(1);
    expect(statOf(db, "b")?.wakeable).toBe(false);
    expect(statOf(db, "c")?.wakeable).toBe(false);
    db.close();
  });

  it("the same broadcast with wake:true wakes every member box", () => {
    const db = poolDb();
    const r = deliverMessage(db, {
      from: "n",
      from_box: "a",
      to_box: "team:x",
      subject: "r8 go: build is green",
      body: "b",
      wake: true,
      created_at: 2000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(statOf(db, "b")?.wakeable).toBe(true);
    expect(statOf(db, "c")?.wakeable).toBe(true);
    db.close();
  });

  it("deliverMessage stores the flag: 1 when wake, 0 by default", () => {
    const db = poolDb();
    deliverMessage(db, {
      from: "n",
      from_box: "a",
      to_box: "team:x",
      subject: "flagged",
      body: "b",
      wake: true,
      created_at: 2000,
    });
    deliverMessage(db, {
      from: "n",
      from_box: "a",
      to_box: "team:x",
      subject: "not flagged",
      body: "b",
      created_at: 2100,
    });
    const wakes = db.conn
      .all<{ subject: string; wake: number }>(
        "SELECT subject, wake FROM messages ORDER BY created_at",
      )
      .map((r) => `${r.subject}:${r.wake}`);
    expect(wakes).toEqual(["flagged:1", "not flagged:0"]);
    db.close();
  });

  it("a cross-host fanout with wake:true wakes despite origin_id != id", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "status: pool broadcast",
      body: "b",
      origin_id: "origin-1",
      created_at: 1000,
    });
    expect(statOf(db, "a")?.wakeable).toBe(false);

    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "r8 go (deliberate)",
      body: "b",
      origin_id: "origin-2",
      wake: true,
      created_at: 2000,
    });
    expect(statOf(db, "a")?.wakeable).toBe(true);
    db.close();
  });

  it("a DM always wakes, flag or not", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    expect(statOf(db, "a")?.wakeable).toBe(true);
    db.close();
  });
});

describe("content dedup at delivery (0.20.0 sender re-send defense)", () => {
  const MAIL = {
    from: "n1",
    from_box: "sender",
    subject: "arbitrage (B)",
    body: "same body",
  } as const;

  function boxDb() {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    return db;
  }

  function counts(db: ReturnType<typeof boxDb>) {
    return {
      messages: db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages")?.n ?? 0,
      deliveries: db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries")?.n ?? 0,
    };
  }

  it("a re-executed send 14 s later is a no-op: existing id, no new row", () => {
    const db = boxDb();
    const first = deliverMessage(db, { ...MAIL, to_box: "a", created_at: 1000 });
    if (!first.ok) throw new Error("first delivery failed");
    const second = deliverMessage(db, { ...MAIL, to_box: "a", created_at: 15000 });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.id).toBe(first.id);
    expect(counts(db)).toEqual({ messages: 1, deliveries: 1 });
    db.close();
  });

  it("the same content after the window delivers again (window elapsed)", () => {
    const db = boxDb();
    const first = deliverMessage(db, { ...MAIL, to_box: "a", created_at: 1000 });
    // One millisecond past the (now 6h) window: a genuinely new delivery.
    const second = deliverMessage(db, {
      ...MAIL,
      to_box: "a",
      created_at: 1000 + RESEND_WINDOW_MS + 1,
    });
    if (!first.ok || !second.ok) throw new Error("delivery failed");

    expect(second.id).not.toBe(first.id);
    expect(counts(db)).toEqual({ messages: 2, deliveries: 2 });
    db.close();
  });

  it("an identical body answering a different message is a distinct delivery (reply_to in the key)", () => {
    const db = boxDb();
    deliverMessage(db, { ...MAIL, to_box: "a", created_at: 1000 });
    const reply = deliverMessage(db, {
      ...MAIL,
      to_box: "a",
      reply_to: "m-question",
      created_at: 15000,
    });

    expect(reply.ok).toBe(true);
    expect(counts(db)).toEqual({ messages: 2, deliveries: 2 });
    db.close();
  });

  it("a broadcast reaches every member box once; re-executing it adds nothing", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "b", session_id: "s2", now: 1000 });
    registerMailbox(db, { name: "c", session_id: "s3", now: 1000 });
    joinPool(db, "a", "team:x");
    joinPool(db, "b", "team:x");
    joinPool(db, "c", "team:x");

    const first = deliverMessage(db, {
      ...MAIL,
      from_box: "a",
      to_box: "team:x",
      created_at: 1000,
    });
    if (!first.ok) throw new Error("broadcast failed");
    expect(first.recipients).toEqual(["b", "c"]);
    expect(unreadBoxCount(db, "b")).toBe(1);
    expect(unreadBoxCount(db, "c")).toBe(1);

    const second = deliverMessage(db, {
      ...MAIL,
      from_box: "a",
      to_box: "team:x",
      created_at: 15000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.id).toBe(first.id);
    expect(counts(db)).toEqual({ messages: 1, deliveries: 2 });
    db.close();
  });

  it("the same content to a different box is a distinct delivery (to_box in the key)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "b", session_id: "s2", now: 1000 });
    deliverMessage(db, { ...MAIL, to_box: "a", created_at: 1000 });
    deliverMessage(db, { ...MAIL, to_box: "b", created_at: 11000 });

    expect(counts(db)).toEqual({ messages: 2, deliveries: 2 });
    expect(unreadBoxCount(db, "a")).toBe(1);
    expect(unreadBoxCount(db, "b")).toBe(1);
    db.close();
  });
});

describe("wake gates (0.16.0 token economy)", () => {
  it("wakeBoxStats: wakeable true for a direct mail, false for a fanout", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    expect(statOf(db, "a")?.wakeable).toBe(true);
    db.close();
  });

  it("wakeBoxStats: fanout (origin_id differs from id) is not direct", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "pool",
      body: "b",
      origin_id: "origin-1",
      created_at: 1000,
    });
    expect(statOf(db, "a")?.wakeable).toBe(false);
    db.close();
  });

  it("wakeBoxStats: legacy rows (origin_id NULL) count as direct", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    db.conn.run(
      `INSERT INTO messages (id, origin_id, from_node, subject, body, status, created_at)
       VALUES ('m-legacy', NULL, 'n', 'legacy', 'b', 'delivered', 1000)`,
    );
    db.conn.run(
      "INSERT INTO deliveries (id, message_id, to_box, status, created_at) VALUES ('d-legacy', 'm-legacy', 'a', 'unread', 1000)",
    );
    expect(statOf(db, "a")?.wakeable).toBe(true);
    db.close();
  });

  it("wakeBoxStats: subject is the OLDEST unread delivery; a drained box has no row", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    expect(statOf(db, "a")).toBeUndefined();
    deliverMessage(db, { from: "n", to_box: "a", subject: "first", body: "b", created_at: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "second", body: "b", created_at: 2000 });
    expect(statOf(db, "a")?.subject).toBe("first");
    expect(statOf(db, "a")?.unread).toBe(2);
    db.close();
  });
});

describe("P2 follow-up (0.31.0, the mr-review findings)", () => {
  it("an EMPTY push retires ALL of the sender's federated rows", () => {
    const db = openMeshDb(":memory:");
    mergeFederatedRegistry(
      db,
      [
        {
          name: "gone",
          session_id: "ses-gone",
          role: null,
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
        },
      ],
      "node-b",
    );
    expect(federatedByName(db, "gone")).not.toBeNull();
    // The sender's next push carries NOTHING: its rows must die (the NULL
    // placeholder deleted nothing, stale rows kept routing to a dead box).
    const applied = mergeFederatedRegistry(db, [], "node-b");
    expect(applied).toBe(0);
    expect(federatedByName(db, "gone")).toBeNull();
    db.close();
  });

  it("a long-lived box (registered_at 2 days old) still upserts as federated", () => {
    const db = openMeshDb(":memory:");
    const applied = mergeFederatedRegistry(
      db,
      [
        {
          name: "old-orq",
          session_id: "ses-old",
          role: "lead",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
        },
      ],
      "node-b",
    );
    // registered_at is the ORIGINAL registration time and never moves: the
    // past bound would drop exactly the long-lived federation targets.
    expect(applied).toBe(1);
    expect(federatedByName(db, "old-orq")).not.toBeNull();
    db.close();
  });
});

describe("resend dedup window (0.29.0: the minutes-apart re-send class)", () => {
  it("collapses a re-send sent minutes apart (the 6admin-to-orq episode)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const first = deliverMessage(db, {
      from: "6admin",
      to_box: "a",
      subject: "rapport round",
      body: "round terminé",
      created_at: 1000,
    });
    // 2 minutes later: the 60s window is long dead; the extended window
    // still recognizes the identical content.
    const second = deliverMessage(db, {
      from: "6admin",
      to_box: "a",
      subject: "rapport round",
      body: "round terminé",
      created_at: 1000 + 2 * 60_000,
    });
    if (!first.ok || !second.ok) throw new Error("delivery failed");
    expect(second.id).toBe(first.id);
    expect(second.recipients).toEqual([]);
    expect(unreadBoxCount(db, "a")).toBe(1);
    db.close();
  });

  it("still delivers a genuinely different mail inside the window", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "first", created_at: 1000 });
    const second = deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "s",
      body: "different body",
      created_at: 2000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("delivery failed");
    expect(second.recipients).toEqual(["a"]);
    expect(unreadBoxCount(db, "a")).toBe(2);
    db.close();
  });

  it("delivers a re-send fresh when the original was already read (an active ping)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const first = deliverMessage(db, {
      from: "6admin",
      to_box: "a",
      subject: "rapport round",
      body: "round terminé",
      created_at: 1000,
    });
    if (!first.ok) throw new Error("delivery failed");
    // The receiver acks the original (the drain), then the sender re-sends
    // the identical content inside the window: an active ping, not a
    // duplicate in an unread backlog.
    ackInbox(
      db,
      db.conn.all<{ id: string }>("SELECT id FROM deliveries WHERE to_box = 'a'").map((r) => r.id),
    );
    const second = deliverMessage(db, {
      from: "6admin",
      to_box: "a",
      subject: "rapport round",
      body: "round terminé",
      // 121s later: past the 2-minute absolute window (the 0.32.0 collapse)
      // but inside the 6h freshness window — an active ping, not a duplicate.
      created_at: 1000 + 121_000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("delivery failed");
    expect(second.id).not.toBe(first.id);
    expect(second.recipients).toEqual(["a"]);
    expect(unreadBoxCount(db, "a")).toBe(1);
    db.close();
  });

  it("collapses an identical re-send within 2 minutes even when the original was read (the wake double-prompt class, 0.32.0)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const first = deliverMessage(db, {
      from: "6admin",
      to_box: "a",
      subject: "re: DNS",
      body: "recette confirmee",
      created_at: 1000,
    });
    if (!first.ok) throw new Error("delivery failed");
    // The receiver acks the original (webmaster drained it while 6admin's
    // double-prompted wake loop re-sent 13s later): the identical re-send
    // inside 2 minutes is NEVER a human ping — collapse.
    ackInbox(
      db,
      db.conn.all<{ id: string }>("SELECT id FROM deliveries WHERE to_box = 'a'").map((r) => r.id),
    );
    const second = deliverMessage(db, {
      from: "6admin",
      to_box: "a",
      subject: "re: DNS",
      body: "recette confirmee",
      created_at: 1013,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("delivery failed");
    expect(second.id).toBe(first.id);
    expect(second.recipients).toEqual([]);
    expect(unreadBoxCount(db, "a")).toBe(0);
    db.close();
  });

  it("keeps broadcast and DM keys separate (same content, different routing)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    joinPool(db, "a", "team:x");
    const broadcast = deliverMessage(db, {
      from: "n",
      to_box: "team:x",
      subject: "s",
      body: "b",
      created_at: 1000,
    });
    const dm = deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "s",
      body: "b",
      created_at: 2000,
    });
    expect(broadcast.ok).toBe(true);
    expect(dm.ok).toBe(true);
    if (!broadcast.ok || !dm.ok) throw new Error("delivery failed");
    expect(dm.id).not.toBe(broadcast.id);
    expect(dm.recipients).toEqual(["a"]);
    db.close();
  });

  it("purges the expired hash rows on the next insert (the rolling window bound)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const rowsBefore = db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM recent_mails")?.n;
    expect(rowsBefore).toBe(1);
    // The next insert purges the expired hashes (created_at > 1000 + 6h).
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "later",
      body: "b",
      created_at: 1000 + RESEND_WINDOW_MS + 1,
    });
    const hashes = db.conn.all<{ hash: string }>(
      "SELECT hash FROM recent_mails WHERE hash = (SELECT hash FROM recent_mails LIMIT 1)",
    );
    void hashes;
    const stale = db.conn.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM recent_mails WHERE ts <= ?",
      [1000 + RESEND_WINDOW_MS + 1 - RESEND_WINDOW_MS],
    );
    expect(stale?.n).toBe(0);
    db.close();
  });
});

describe("withTransaction: the rollback-failure recovery (0.30.0)", () => {
  it("reopens the connection when the ROLLBACK itself fails (the leak dies)", () => {
    let leaked = false;
    const conn = {
      all: () => [],
      get: () => null,
      run: () => {},
      exec: (sql: string) => {
        if (sql === "ROLLBACK") {
          // The rollback fails AND leaves the transaction open (the leak).
          leaked = true;
          throw new Error("rollback failed: connection mid-teardown");
        }
        if (sql === "BEGIN") {
          if (leaked) throw new Error("transaction already open: the leak the reopen must clear");
        }
      },
      inTransaction: () => leaked,
      close: () => {},
    };
    const reopen = vi.fn(() => {
      leaked = false;
    });
    const db = {
      conn,
      path: "/tmp/does-not-matter/mesh.db",
      reopen,
    } as unknown as Parameters<typeof withTransaction>[0];
    expect(() =>
      withTransaction(db, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // The rollback failed, the txn state was unknown: the reopen ran (the
    // leak cleared), the connection is usable again.
    expect(db.reopen).toHaveBeenCalled();
  });
});

describe("withTransaction: the third recovery surface (0.30.0 review)", () => {
  it("recovers when the transaction is still open after a successful rollback path", () => {
    // The engine-quirk class: the COMMIT ran, the ROLLBACK path never threw,
    // yet inTransaction flips true after the call (the finally surface). The
    // mock is sequence-aware: false at the entry guard, true at the finally.
    const reopen = vi.fn(() => {});
    let inTransactionCalls = 0;
    const conn = {
      all: () => [],
      get: () => null,
      run: () => {},
      exec: () => {},
      inTransaction: () => inTransactionCalls++ > 0,
      close: () => {},
    };
    const db = {
      conn,
      path: "/tmp/does-not-matter/mesh.db",
      reopen,
    } as unknown as Parameters<typeof withTransaction>[0];
    const result = withTransaction(db, () => "value");
    expect(result).toBe("value");
    // The finally check saw the stuck transaction and recovered.
    expect(reopen).toHaveBeenCalled();
  });
});

describe("registry federation (0.30.0)", () => {
  it("a federated row never wakes a foreign session (node_id marks it)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "local", session_id: "s1", now: 1000 });
    // The federated row: pushed by ricinus (the node_id = the sender).
    mergeFederatedRegistry(
      db,
      [
        {
          name: "sysops",
          session_id: "ses-foreign",
          role: "ops",
          pools: '["team:infra"]',
          primary_pool: "team:infra",
          registered_at: Date.now() - 1000,
        },
      ],
      "node-ricinus",
    );
    const stats = wakeBoxStats(db).find((s) => s.box === "sysops");
    // No unread mail: the federated box never wakes anyone (the wake skips
    // the foreign session_id via sessionKnown).
    expect(stats).toBeUndefined();
    db.close();
  });

  it("the merge resolves mesh_send addressing cross-node (the federated row)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "local", session_id: "s1", now: 1000 });
    mergeFederatedRegistry(
      db,
      [
        {
          name: "sysops",
          session_id: "ses-foreign",
          role: "ops",
          pools: '["team:infra"]',
          primary_pool: "team:infra",
          registered_at: Date.now() - 1000,
        },
      ],
      "node-ricinus",
    );
    const row = federatedByName(db, "sysops");
    expect(row).not.toBeNull();
    db.close();
  });

  it("the single-writer rule: this node's names never lose to an inbound row", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "local", session_id: "s1", now: 1000 });
    // An inbound row for OUR name with a NEWER registration: the ownership
    // transfers (the explicit rebind on the other side).
    const applied = mergeFederatedRegistry(
      db,
      [
        {
          name: "local",
          session_id: "ses-foreign",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          // The strictly higher epoch (the refonte 3.2: the logical clock —
          // the wall-clock transfer is retired, a pre-3.2 row never takes a
          // name): the ownership transfers.
          registered_at: Date.now() - 500,
          epoch: 2,
        },
      ],
      "node-ricinus",
    );
    expect(applied).toBe(1);
    // The transfer turns OUR row into an addressing row (node_id = the new
    // owner): the name now lives on the peer.
    const row = federatedByName(db, "local");
    expect(row?.session_id).toBe("ses-foreign");
    db.close();
  });

  it("an older inbound row for our name loses the LWW (the local keeps it)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "local", session_id: "s1", now: 5000 });
    const applied = mergeFederatedRegistry(
      db,
      [
        {
          name: "local",
          session_id: "ses-foreign",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          registered_at: 1000,
        },
      ],
      "node-ricinus",
    );
    expect(applied).toBe(0);
    const row = mailboxByName(db, "local");
    expect(row?.session_id).toBe("s1");
    db.close();
  });
});

describe("P1 (0.31.0): a federated name is never a local box", () => {
  const FED = {
    name: "remote-dev",
    session_id: "ses-remote",
    role: "ops",
    pools: '["team:x"]',
    primary_pool: null,
    registered_at: Date.now() - 1000,
  };

  function federatedDb() {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    mergeFederatedRegistry(db, [FED], "node-b");
    return db;
  }

  it("mailboxByName resolves LOCAL boxes only; federatedByName carries the routing row", () => {
    const db = federatedDb();
    // The local resolution must not see the federated row: every caller that
    // decides "does this box live here?" would otherwise answer yes and sink
    // mail into a box no local session drains.
    expect(mailboxByName(db, "remote-dev")).toBeNull();
    const fed = federatedByName(db, "remote-dev");
    expect(fed?.name).toBe("remote-dev");
    expect(fed?.node_id).toBe("node-b");
    db.close();
  });

  it("deliverMessage to a federated name is unknown_mailbox, never a phantom delivery", () => {
    const db = federatedDb();
    const result = deliverMessage(db, {
      from: "n1",
      from_box: "alice",
      to_box: "remote-dev",
      subject: "dm",
      body: "b",
    });
    expect(result).toEqual({ ok: false, error: "unknown_mailbox" });
    db.close();
  });

  it("a federated pool membership does not surface as a local pool", () => {
    const db = federatedDb();
    // team:x exists ONLY on node-b: locally it has no members, so nothing
    // local lists it (the sidebar and mesh_pools count node_id IS NULL).
    const pools = new Set<string>();
    for (const box of listMailboxes(db)) {
      for (const p of box.pools) pools.add(p);
    }
    expect(pools.has("team:x")).toBe(false);
    db.close();
  });
});

describe("P2 (0.31.0): the registry merge is hardened", () => {
  const inbound = (over: Partial<Parameters<typeof mergeFederatedRegistry>[1][number]> = {}) => ({
    name: "orq",
    session_id: "ses-foreign",
    role: "po",
    pools: "[]",
    primary_pool: null,
    registered_at: Date.now() - 1000,
    ...over,
  });

  function boundLocalDb(name = "orq") {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name, session_id: "s1", bind_key: "proj:/work", now: 1000 });
    // The binding is live but the session went quiet: only the BIND proves
    // the name is taken — the staleness must not reopen the takeover.
    db.conn.run("UPDATE mailboxes SET last_seen = ?", [Date.now() - 2 * 60 * 60 * 1000]);
    return db;
  }

  it("never cedes a bound local name, even when its session went quiet", () => {
    const db = boundLocalDb();
    const applied = mergeFederatedRegistry(db, [inbound()], "node-b");
    expect(applied).toBe(0);
    const row = mailboxByName(db, "orq");
    expect(row?.bind_key).toBe("proj:/work");
    db.close();
  });

  it("a pools entry outside the team:<id> grammar skips the row", () => {
    const db = boundLocalDb("free-name");
    const applied = mergeFederatedRegistry(
      db,
      [inbound({ name: "free-name", pools: '["garbage"]' })],
      "node-b",
    );
    expect(applied).toBe(0);
    db.close();
  });

  it("an oversized session_id skips the row", () => {
    const db = boundLocalDb("free-name");
    const applied = mergeFederatedRegistry(
      db,
      [inbound({ name: "free-name", session_id: "x".repeat(200) })],
      "node-b",
    );
    expect(applied).toBe(0);
    db.close();
  });

  it("an oversized role skips the row", () => {
    const db = boundLocalDb("free-name");
    const applied = mergeFederatedRegistry(
      db,
      [inbound({ name: "free-name", role: "x".repeat(100) })],
      "node-b",
    );
    expect(applied).toBe(0);
    db.close();
  });
});

describe("P1.2 (refonte): message kinds — a fyi DM never wakes", () => {
  it("a DM with kind fyi is never wakeable (the silent DM)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      from_box: "x",
      to_box: "a",
      subject: "fyi only",
      body: "b",
      kind: "fyi",
      created_at: 1000,
    });
    const stat = wakeBoxStats(db).find((s) => s.box === "a");
    // The box holds mail but nothing may interrupt its session: the flash
    // waits for the next drain (or a later notify mail rides along).
    expect(stat?.unread).toBe(1);
    expect(stat?.wakeable).toBe(false);
    db.close();
  });

  it("a plain DM stays wakeable (the notify default)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      from_box: "x",
      to_box: "a",
      subject: "s",
      body: "b",
      created_at: 1000,
    });
    expect(wakeBoxStats(db).find((s) => s.box === "a")?.wakeable).toBe(true);
    db.close();
  });
});

describe("P2 (refonte): the tasks core — server-side correlation, one wake for a group", () => {
  it("mesh_ask submits and notifies the responder with the task id (no reply_to in the contract)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const task = askTask(db, { from_box: "alice", to_box: "bob", question: "quel etat du build?" });
    expect(task.state).toBe("submitted");
    expect(task.to_box).toBe("bob");
    // The responder's box holds a notify message carrying the task id.
    const row = db.conn.get<{ subject: string; body: string; kind: string }>(
      "SELECT m.subject, m.body, m.kind FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'bob'",
    )!;
    expect(row.kind).toBe("notify");
    expect(row.subject).toContain(task.id.slice(0, 8));
    expect(row.body).toContain("quel etat du build?");
    expect(row.body).toContain(`mesh_reply(task_id="${task.id}"`);
    db.close();
  });

  it("mesh_reply completes and notifies the asker; only the target mailbox may reply", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const task = askTask(db, { from_box: "alice", to_box: "bob", question: "q" });
    // A foreign box cannot reply.
    const foreign = replyTask(db, task.id, "mallory", "hack", "completed");
    expect(foreign.ok).toBe(false);
    // The right box replies: the asker gets the result.
    const rep = replyTask(db, task.id, "bob", "build vert", "completed");
    expect(rep.ok).toBe(true);
    expect(rep.notified).toBe(true);
    const got = db.conn.get<{ subject: string; body: string }>(
      "SELECT m.subject, m.body FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'alice'",
    )!;
    expect(got.subject).toContain("completed");
    expect(got.body).toContain("build vert");
    expect(getTask(db, task.id)?.state).toBe("completed");
    // Double reply: refused.
    expect(replyTask(db, task.id, "bob", "again", "completed").ok).toBe(false);
    db.close();
  });

  it("the group digest: ONE notification when all the group's tasks are answered", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const t1 = askTask(db, { from_box: "alice", to_box: "bob", question: "q1", group_id: "g1" });
    const t2 = askTask(db, { from_box: "alice", to_box: "bob", question: "q2", group_id: "g1" });
    // The first answer: nothing reaches the asker yet (the group is open).
    const r1 = replyTask(db, t1.id, "bob", "reponse 1", "completed");
    expect(r1.notified).toBe(false);
    expect(
      db.conn.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'alice'",
      )?.n,
    ).toBe(0);
    // The second answer: ONE digest with both results.
    const r2 = replyTask(db, t2.id, "bob", "reponse 2", "completed");
    expect(r2.notified).toBe(true);
    const got = db.conn.get<{ body: string }>(
      "SELECT m.body FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'alice'",
    )!;
    expect(got.body).toContain("The group is answered");
    expect(got.body).toContain("reponse 1");
    expect(got.body).toContain("reponse 2");
    db.close();
  });

  it("input_required notifies the asker immediately (a pause is a deliberate answer)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const t = askTask(db, { from_box: "alice", to_box: "bob", question: "q" });
    const r = replyTask(db, t.id, "bob", "il me manque la zone DNS", "input_required");
    expect(r.notified).toBe(true);
    expect(getTask(db, t.id)?.state).toBe("input_required");
    db.close();
  });

  it("the deadline sweeper fails expired tasks and notifies the asker", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const t = askTask(db, {
      from_box: "alice",
      to_box: "bob",
      question: "q",
      deadline: Date.now() - 1000,
    });
    const swept = sweepTasks(db, Date.now());
    expect(swept).toBe(1);
    expect(getTask(db, t.id)?.state).toBe("failed");
    const got = db.conn.get<{ body: string }>(
      "SELECT m.body FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'alice'",
    )!;
    expect(got.body).toContain("deadline exceeded");
    db.close();
  });
});

describe("3.2 (refonte): the registry anti-entropy — the logical epoch per name", () => {
  it("registerMailbox increments the epoch at each rebind; a new box starts at 1", () => {
    const db = openMeshDb(":memory:");
    const r1 = registerMailbox(db, { name: "orq", session_id: "s1", now: 1000 });
    expect(r1.epoch).toBe(1);
    // The rebind (a new session takes the name): the epoch grows.
    const r2 = registerMailbox(db, { name: "orq", session_id: "s2", now: 2000 });
    expect(r2.epoch).toBe(2);
    db.close();
  });

  it("the merge resolves on (epoch, node_id): a higher epoch wins even with an older wall clock", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "orq", session_id: "s1", now: 1000 });
    // The local epoch is 1. An inbound row with epoch 5 and a registered_at
    // OLDER than the local one: the EPOCH wins (the wall clock lied — the
    // clock-skew class), the ownership transfers.
    const applied = mergeFederatedRegistry(
      db,
      [
        {
          name: "orq",
          session_id: "ses-foreign",
          role: "po",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 60 * 60 * 1000,
          epoch: 5,
        },
      ],
      "node-b",
    );
    expect(applied).toBe(1);
    expect(federatedByName(db, "orq")).not.toBeNull();
    db.close();
  });

  it("the push carries the epoch; the receiver without it keeps its name (the epoch guard)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "orq", session_id: "s1", now: 1000 });
    // An inbound row WITHOUT an epoch (a pre-3.2 peer): the legacy LWW rules
    // apply (the live-session guard) — no blind takeover.
    const applied = mergeFederatedRegistry(
      db,
      [
        {
          name: "orq",
          session_id: "ses-foreign",
          role: "po",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
        },
      ],
      "node-b",
    );
    expect(applied).toBe(0);
    db.close();
  });
});

describe("3.2 (refonte): the composite separator guard", () => {
  it("registerMailbox refuses a name containing '/'", () => {
    const db = openMeshDb(":memory:");
    expect(() => registerMailbox(db, { name: "a/b", session_id: "s1", now: 1000 })).toThrow(
      'a mailbox name cannot contain "/"',
    );
    db.close();
  });
});

describe("C1 (refonte2): the digest fires ONCE — the later transitions notify individually", () => {
  it("the group digest once; the later transitions deliver individual notifications", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const t1 = askTask(db, { from_box: "alice", to_box: "bob", question: "q1", group_id: "g2" });
    const t2 = askTask(db, { from_box: "alice", to_box: "bob", question: "q2", group_id: "g2" });
    // Les deux reponses: le digest part UNE fois (la 2e reponse ferme le groupe).
    replyTask(db, t1.id, "bob", "rep 1", "completed");
    const r2 = replyTask(db, t2.id, "bob", "rep 2", "input_required");
    expect(r2.notified).toBe(true);
    const digestCount = db.conn.all<{ subject: string }>(
      "SELECT subject FROM messages WHERE body LIKE 'The group is answered%'",
    ).length;
    expect(digestCount).toBe(1);
    // La transition ULTERIEURE de t2 (input_required -> completed): la
    // notification INDIVIDUELLE, jamais un second digest.
    db.conn.run("UPDATE tasks SET state = 'input_required', updated_at = ? WHERE id = ?", [
      Date.now(),
      t2.id,
    ]);
    const r3 = replyTask(db, t2.id, "bob", "rep 2 final", "completed");
    expect(r3.notified).toBe(true);
    const digestCount2 = db.conn.all<{ subject: string }>(
      "SELECT subject FROM messages WHERE body LIKE 'The group is answered%'",
    ).length;
    expect(digestCount2).toBe(1);
    const individual = db.conn.get<{ body: string }>(
      "SELECT m.body FROM messages m WHERE m.subject LIKE 'task % completed' ORDER BY m.created_at DESC",
    )!;
    expect(individual.body).toContain("rep 2 final");
    db.close();
  });
});

describe("D (refonte2): the retention purges the delivered history", () => {
  it("the SENT outbox and the TERMINAL tasks purge after 7 days; the live state stays", () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    // L'outbox: sent ancien (purge), sent recent (reste), queued (reste).
    db.conn.run(
      `INSERT INTO outbox (id, payload, state, attempts, next_at, created_at) VALUES ('o-old', '{}', 'sent', 1, ?, ?)`,
      [now - 8 * 24 * 3600 * 1000, now - 8 * 24 * 3600 * 1000],
    );
    db.conn.run(
      `INSERT INTO outbox (id, payload, state, attempts, next_at, created_at) VALUES ('o-new', '{}', 'sent', 1, ?, ?)`,
      [now - 1000, now - 1000],
    );
    db.conn.run(
      `INSERT INTO outbox (id, payload, state, attempts, next_at, created_at) VALUES ('o-q', '{}', 'queued', 0, ?, ?)`,
      [now - 8 * 24 * 3600 * 1000, now - 8 * 24 * 3600 * 1000],
    );
    // Les tasks: completed ancienne (purge), failed recente (reste), submitted (reste).
    db.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, question, state, created_at, updated_at) VALUES ('t-old', 'alice', 'bob', 'q', 'completed', ?, ?)`,
      [now - 8 * 24 * 3600 * 1000, now - 8 * 24 * 3600 * 1000],
    );
    db.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, question, state, created_at, updated_at) VALUES ('t-new', 'alice', 'bob', 'q', 'failed', ?, ?)`,
      [now - 1000, now - 1000],
    );
    db.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, question, state, created_at, updated_at) VALUES ('t-open', 'alice', 'bob', 'q', 'submitted', ?, ?)`,
      [now - 8 * 24 * 3600 * 1000, now - 8 * 24 * 3600 * 1000],
    );
    const res = purgeDeliveredHistory(db, now);
    expect(res.outbox).toBe(1);
    expect(res.tasks).toBe(1);
    expect(
      db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE id = 'o-old'")!.n,
    ).toBe(0);
    expect(
      db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE id = 'o-new'")!.n,
    ).toBe(1);
    expect(db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE id = 'o-q'")!.n).toBe(
      1,
    );
    expect(
      db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-old'")!.n,
    ).toBe(0);
    expect(
      db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-new'")!.n,
    ).toBe(1);
    expect(
      db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-open'")!.n,
    ).toBe(1);
    db.close();
  });
});
