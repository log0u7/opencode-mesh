import { describe, expect, it } from "vitest";

import {
  ackMessages,
  deliverMessage,
  firstPendingSubject,
  hasDirectUnread,
  receiveMessage,
  registerMailbox,
  unreadCount,
  unreadMessages,
} from "../src/lib/mail.js";
import { openMeshDb } from "../src/lib/db.js";

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

describe("wake gates (0.16.0 token economy)", () => {
  it("hasDirectUnread: true for a direct mail, false for a fanout", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    expect(hasDirectUnread(db, "a")).toBe(true);
    db.close();
  });

  it("hasDirectUnread: fanout (origin_id differs from id) is not direct", () => {
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
    expect(hasDirectUnread(db, "a")).toBe(false);
    db.close();
  });

  it("hasDirectUnread: legacy rows (origin_id NULL) count as direct", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    db.conn.run(
      `INSERT INTO messages (id, origin_id, from_node, subject, body, status, created_at)
       VALUES ('m-legacy', NULL, 'n', 'legacy', 'b', 'delivered', 1000)`,
    );
    db.conn.run(
      "INSERT INTO deliveries (id, message_id, to_box, status, created_at) VALUES ('d-legacy', 'm-legacy', 'a', 'unread', 1000)",
    );
    expect(hasDirectUnread(db, "a")).toBe(true);
    db.close();
  });

  it("firstPendingSubject: oldest unread delivery, null when drained", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    expect(firstPendingSubject(db, "a")).toBeNull();
    deliverMessage(db, { from: "n", to_box: "a", subject: "first", body: "b", created_at: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "second", body: "b", created_at: 2000 });
    expect(firstPendingSubject(db, "a")).toBe("first");
    db.close();
  });
});
