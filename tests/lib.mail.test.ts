import { describe, expect, it } from "vitest";

import { ackMessages, receiveMessage, unreadCount, unreadMessages } from "../src/lib/mail.js";
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
