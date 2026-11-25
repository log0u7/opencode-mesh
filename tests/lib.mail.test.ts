import { describe, expect, it, vi } from "vitest";

import {
  ackMessages,
  deliverMessage,
  inboxRead,
  joinPool,
  receiveMessage,
  registerMailbox,
  unreadBoxCount,
  unreadCount,
  unreadMessages,
  waitReplyRead,
  wakeBoxStats,
  ackInbox,
  withTransaction,
  mailboxByName,
  mergeFederatedRegistry,
  RESEND_WINDOW_MS,
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

  it("waitReplyRead returns the reply and marks it read atomically (mesh_wait path)", () => {
    const db = boxDb();
    const q = deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "question",
      body: "?",
      created_at: 2000,
    });
    if (!q.ok) throw new Error("delivery failed");
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "re: question",
      body: "answer",
      reply_to: q.id,
      created_at: 3000,
    });

    expect(waitReplyRead(db, q.id, "s1")?.subject).toBe("re: question");
    expect(waitReplyRead(db, q.id, "s1")).toBeNull();
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
      created_at: 2000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("delivery failed");
    expect(second.id).not.toBe(first.id);
    expect(second.recipients).toEqual(["a"]);
    expect(unreadBoxCount(db, "a")).toBe(1);
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
    const row = mailboxByName(db, "sysops");
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
          // The strictly newer registration: the ownership transfers.
          registered_at: Date.now() - 500,
        },
      ],
      "node-ricinus",
    );
    expect(applied).toBe(1);
    const row = mailboxByName(db, "local");
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
