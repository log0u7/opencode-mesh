import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import {
  ackInbox,
  mailboxesBySession,
  deliverMessage,
  firstReply,
  inboxRows,
  joinPool,
  leavePool,
  listMailboxes,
  mailboxByName,
  mailboxBySession,
  purgeExpired,
  receiveMessage,
  registerMailbox,
  unreadMessages,
} from "../src/lib/mail.js";

function db() {
  return openMeshDb(":memory:");
}

describe("mailbox registration", () => {
  it("registers a box bound to a session and finds it both ways", () => {
    const d = db();
    registerMailbox(d, { name: "purser", session_id: "s1", now: 1000 });

    expect(mailboxByName(d, "purser")?.session_id).toBe("s1");
    expect(mailboxBySession(d, "s1")?.name).toBe("purser");
    d.close();
  });

  it("a session may own several boxes (one TUI, several agent hats)", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(d, { name: "b", session_id: "s1", now: 2000 });

    expect(mailboxByName(d, "a")?.session_id).toBe("s1");
    expect(mailboxByName(d, "b")?.session_id).toBe("s1");
    d.close();
  });

  it("rebinding a name to a new session is a handoff, not a duplicate", () => {
    const d = db();
    registerMailbox(d, { name: "purser", session_id: "s1", now: 1000 });
    registerMailbox(d, { name: "purser", session_id: "s2", now: 2000 });

    expect(mailboxByName(d, "purser")?.session_id).toBe("s2");
    expect(mailboxBySession(d, "s1")).toBeNull();
    d.close();
  });

  it("stores role and pools for the org convention", () => {
    const d = db();
    registerMailbox(d, { name: "qm", session_id: "s1", role: "manager", now: 1000 });
    joinPool(d, "qm", "team:quartermaster");

    const box = mailboxByName(d, "qm");
    expect(box?.role).toBe("manager");
    expect(box?.pools).toEqual(["team:quartermaster"]);

    leavePool(d, "qm", "team:quartermaster");
    expect(mailboxByName(d, "qm")?.pools).toEqual([]);
    d.close();
  });

  it("join is idempotent, leave of a non-member is a no-op", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    joinPool(d, "a", "team:x");
    joinPool(d, "a", "team:x");
    expect(mailboxByName(d, "a")?.pools).toEqual(["team:x"]);
    leavePool(d, "a", "team:y");
    expect(mailboxByName(d, "a")?.pools).toEqual(["team:x"]);
    d.close();
  });

  it("stores the declared primary pool, null when absent, kept across a handoff", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    expect(mailboxByName(d, "a")?.primary_pool).toBeNull();

    registerMailbox(d, { name: "b", session_id: "s1", primary_pool: "team:x", now: 1000 });
    expect(mailboxByName(d, "b")?.primary_pool).toBe("team:x");

    // Handoff (re-register without a primary) preserves the declaration.
    registerMailbox(d, { name: "b", session_id: "s2", now: 2000 });
    expect(mailboxByName(d, "b")?.primary_pool).toBe("team:x");
    d.close();
  });
});

describe("targeted delivery", () => {
  it("routes mail to the named box only: no cross-drain", () => {
    const d = db();
    registerMailbox(d, { name: "purser", session_id: "s1", now: 1000 });
    registerMailbox(d, { name: "quartermaster", session_id: "s2", now: 1000 });

    const result = deliverMessage(d, {
      from: "node",
      from_box: "theforeman",
      to_box: "purser",
      subject: "r8 go",
      body: "build is green",
      created_at: 2000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toEqual(["purser"]);

    const purser = inboxRows(d, "s1");
    expect(purser).toHaveLength(1);
    expect(purser[0]?.subject).toBe("r8 go");
    expect(purser[0]?.from_box).toBe("theforeman");
    expect(purser[0]?.delivery_id).toBeTruthy();

    const qm = inboxRows(d, "s2");
    expect(qm).toHaveLength(0);
    d.close();
  });

  it("errors on an unknown mailbox and leaves no orphan message", () => {
    const d = db();
    const result = deliverMessage(d, {
      from: "node",
      to_box: "nobody",
      subject: "s",
      body: "b",
      created_at: 1000,
    });
    expect(result).toEqual({ ok: false, error: "unknown_mailbox" });
    expect(unreadMessages(d)).toHaveLength(0);
    d.close();
  });

  it("acks by delivery id and keeps other deliveries unread", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    const r1 = deliverMessage(d, {
      from: "n",
      to_box: "a",
      subject: "one",
      body: "1",
      created_at: 2000,
    });
    deliverMessage(d, { from: "n", to_box: "a", subject: "two", body: "2", created_at: 3000 });
    if (!r1.ok) throw new Error("delivery failed");

    const first = inboxRows(d, "s1")[0];
    ackInbox(d, [first?.delivery_id ?? ""]);

    const remaining = inboxRows(d, "s1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.subject).toBe("two");
    d.close();
  });

  it("delivers replies threaded by reply_to and firstReply finds them for the recipient", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    const q = deliverMessage(d, {
      from: "n",
      to_box: "a",
      subject: "question",
      body: "?",
      created_at: 2000,
    });
    if (!q.ok) throw new Error("delivery failed");

    deliverMessage(d, {
      from: "n",
      to_box: "a",
      subject: "re: question",
      body: "answer",
      reply_to: q.id,
      created_at: 3000,
    });

    // The question itself is not its own reply.
    expect(firstReply(d, q.id, "s1")?.subject).toBe("re: question");
    expect(firstReply(d, "nope", "s1")).toBeNull();
    d.close();
  });
});

describe("pool broadcast", () => {
  function teamDb() {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(d, { name: "b", session_id: "s2", now: 1000 });
    registerMailbox(d, { name: "c", session_id: "s3", now: 1000 });
    joinPool(d, "a", "team:x");
    joinPool(d, "b", "team:x");
    return d;
  }

  it("delivers one copy per pool member, excluding the sender", () => {
    const d = teamDb();
    const result = deliverMessage(d, {
      from: "node",
      from_box: "a",
      to_box: "team:x",
      subject: "status",
      body: "done",
      created_at: 2000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients.sort()).toEqual(["b"]);

    expect(inboxRows(d, "s1")).toHaveLength(0);
    expect(inboxRows(d, "s2")[0]?.subject).toBe("status");
    expect(inboxRows(d, "s3")).toHaveLength(0);
    d.close();
  });

  it("broadcasts to every mailbox with 'all', excluding the sender", () => {
    const d = teamDb();
    const result = deliverMessage(d, {
      from: "node",
      from_box: "a",
      to_box: "all",
      subject: "org change",
      body: "...",
      created_at: 2000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients.sort()).toEqual(["b", "c"]);
    d.close();
  });

  it("broadcast to an empty pool is an explicit error, not silence", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    const result = deliverMessage(d, {
      from: "node",
      from_box: "a",
      to_box: "team:empty",
      subject: "s",
      body: "b",
      created_at: 2000,
    });
    expect(result).toEqual({ ok: false, error: "empty_broadcast" });
    d.close();
  });
});

describe("legacy global inbox compatibility", () => {
  it("mail without a target box stays global and reaches unregistered sessions", () => {
    const d = db();
    receiveMessage(d, { from: "node-a", subject: "remote", body: "hi" });

    const global = unreadMessages(d);
    expect(global).toHaveLength(1);
    expect(global[0]?.subject).toBe("remote");
    d.close();
  });

  it("a registered session still sees legacy global mail in its inbox", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    receiveMessage(d, { from: "node-a", subject: "remote", body: "hi" });
    deliverMessage(d, {
      from: "node",
      to_box: "a",
      subject: "local",
      body: "b",
      created_at: 2000,
    });

    const rows = inboxRows(d, "s1");
    expect(rows.map((r) => r.subject).sort()).toEqual(["local", "remote"]);
    expect(rows.find((r) => r.subject === "remote")?.delivery_id).toBe("");
    d.close();
  });
});

describe("presence and purge", () => {
  it("lists mailboxes with role, pools and last_seen", () => {
    const d = db();
    registerMailbox(d, { name: "qm", session_id: "s1", role: "manager", now: 1000 });
    joinPool(d, "qm", "team:x");

    const boxes = listMailboxes(d);
    expect(boxes).toEqual([
      {
        name: "qm",
        session_id: "s1",
        role: "manager",
        pools: ["team:x"],
        bind_key: null,
        primary_pool: null,
        last_seen: 1000,
      },
    ]);
    d.close();
  });

  it("purge drops messages (and their deliveries) older than the ttl only", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(d, {
      from: "n",
      to_box: "a",
      subject: "old",
      body: "b",
      created_at: 1000,
    });
    deliverMessage(d, {
      from: "n",
      to_box: "a",
      subject: "fresh",
      body: "b",
      created_at: 1_000_000,
    });

    purgeExpired(d, 10_000, 500_000);
    const subjects = inboxRows(d, "s1").map((r) => r.subject);
    expect(subjects).toEqual(["fresh"]);
    d.close();
  });
});

describe("multi-box sessions", () => {
  it("inboxRows aggregates all the session's boxes and labels them", () => {
    const d = db();
    registerMailbox(d, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(d, { name: "b", session_id: "s1", now: 2000 });
    deliverMessage(d, { from: "n", to_box: "a", subject: "for a", body: "1", created_at: 3000 });
    deliverMessage(d, { from: "n", to_box: "b", subject: "for b", body: "2", created_at: 4000 });

    const rows = inboxRows(d, "s1");
    expect(rows).toHaveLength(2);
    const bySubject = new Map(rows.map((r) => [r.subject, r]));
    expect(bySubject.get("for a")?.box).toBe("a");
    expect(bySubject.get("for b")?.box).toBe("b");
    d.close();
  });

  it("single-box sessions keep unlabeled rows (compat)", () => {
    const d = db();
    registerMailbox(d, { name: "solo", session_id: "s1", now: 1000 });
    deliverMessage(d, { from: "n", to_box: "solo", subject: "s", body: "b", created_at: 1000 });
    const rows = inboxRows(d, "s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.box).toBeUndefined();
    d.close();
  });
});
