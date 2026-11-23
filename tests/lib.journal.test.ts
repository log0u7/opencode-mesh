import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { deliverMessage, joinPool, registerMailbox } from "../src/lib/mail.js";
import { journalQuery, JOURNAL_LIMIT_DEFAULT, JOURNAL_LIMIT_MAX } from "../src/lib/journal.js";

function setup() {
  const db = openMeshDb(":memory:");
  let at = 1000;
  const boxes = (names: string[]) => {
    for (const name of names) {
      registerMailbox(db, { name, session_id: `s-${name}`, now: at++ });
    }
  };
  // Deterministic timestamps: every mail gets its own slot.
  const send = (input: Omit<Parameters<typeof deliverMessage>[1], "created_at">) =>
    deliverMessage(db, { ...input, created_at: at++ * 1000 });
  return { db, boxes, send };
}

describe("journalQuery", () => {
  it("returns newest-first metadata and never exposes bodies", () => {
    const { db, boxes, send } = setup();
    boxes(["alice", "bob"]);
    send({ from: "n1", from_box: "alice", to_box: "bob", subject: "hi", body: "SECRET-BODY" });
    send({ from: "n1", from_box: "bob", to_box: "alice", subject: "yo", body: "ALSO-SECRET" });

    const rows = journalQuery(db, {});
    expect(rows.map((r) => r.subject)).toEqual(["yo", "hi"]);
    expect(rows[0]).toMatchObject({
      ts: expect.any(Number),
      from: "bob",
      to: ["alice"],
      subject: "yo",
      kind: "dm",
      forwarded: false,
    });
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("body");
      expect(JSON.stringify(row)).not.toContain("SECRET-BODY");
    }
    db.close();
  });

  it("classifies one delivery as dm and several as pool", () => {
    const { db, boxes, send } = setup();
    boxes(["alice", "bob", "carol"]);
    // Pool broadcast: bob and carol carry team:x, the sender is excluded.
    joinPool(db, "bob", "team:x");
    joinPool(db, "carol", "team:x");
    send({ from: "n1", from_box: "alice", to_box: "team:x", subject: "status", body: "b" });
    send({ from: "n1", from_box: "alice", to_box: "bob", subject: "dm", body: "b" });

    const rows = journalQuery(db, {});
    expect(rows.map((r) => [r.subject, r.kind, r.to])).toEqual([
      ["dm", "dm", ["bob"]],
      ["status", "pool", ["bob", "carol"]],
    ]);
    db.close();
  });

  it("marks cross-host arrivals as forwarded, local ones not", () => {
    const { db, boxes, send } = setup();
    boxes(["bob"]);
    send({ from: "n1", from_box: "alice", to_box: "bob", subject: "local", body: "b" });
    // Fanout arrival: the origin id was minted by the remote node.
    const remote = deliverMessage(db, {
      from: "n-remote",
      from_box: "carol",
      to_box: "bob",
      subject: "from-far",
      body: "b",
      origin_id: "origin-remote-1",
      created_at: 5_000_000,
    });
    expect(remote.ok).toBe(true);

    const rows = journalQuery(db, {});
    expect(rows.map((r) => [r.subject, r.forwarded])).toEqual([
      ["from-far", true],
      ["local", false],
    ]);
    db.close();
  });

  it("filters by mailbox as sender or recipient", () => {
    const { db, boxes, send } = setup();
    boxes(["alice", "bob", "carol", "dave"]);
    send({ from: "n1", from_box: "alice", to_box: "bob", subject: "a>b", body: "b" });
    send({ from: "n1", from_box: "bob", to_box: "carol", subject: "b>c", body: "b" });
    send({ from: "n1", from_box: "carol", to_box: "dave", subject: "c>d", body: "b" });

    const rows = journalQuery(db, { mailbox: "bob" });
    expect(rows.map((r) => r.subject)).toEqual(["b>c", "a>b"]);
    db.close();
  });

  it("filters by since (epoch ms, inclusive)", () => {
    const { db, boxes, send } = setup();
    boxes(["alice", "bob"]);
    send({ from: "n1", from_box: "alice", to_box: "bob", subject: "old", body: "b" });
    send({ from: "n1", from_box: "alice", to_box: "bob", subject: "new", body: "b" });

    const newest = journalQuery(db, {})[0]!.ts;
    const rows = journalQuery(db, { since: newest });
    expect(rows.map((r) => r.subject)).toEqual(["new"]);
    db.close();
  });

  it("defaults the limit to 50 and caps it at 200", () => {
    const { db, boxes, send } = setup();
    boxes(["alice", "bob"]);
    for (let i = 0; i < 205; i++) {
      send({ from: "n1", from_box: "alice", to_box: "bob", subject: `m${i}`, body: "b" });
    }
    expect(journalQuery(db, {})).toHaveLength(JOURNAL_LIMIT_DEFAULT);
    expect(journalQuery(db, { limit: 500 })).toHaveLength(JOURNAL_LIMIT_MAX);
    expect(journalQuery(db, { limit: 2 }).map((r) => r.subject)).toEqual(["m204", "m203"]);
    // Not a number / below 1 falls back to the default.
    expect(journalQuery(db, { limit: Number.NaN })).toHaveLength(JOURNAL_LIMIT_DEFAULT);
    expect(journalQuery(db, { limit: 0 })).toHaveLength(JOURNAL_LIMIT_DEFAULT);
    db.close();
  });

  it("pool=true keeps only multi-recipient entries", () => {
    const { db, boxes, send } = setup();
    boxes(["alice", "bob", "carol"]);
    joinPool(db, "bob", "team:x");
    joinPool(db, "carol", "team:x");
    send({ from: "n1", from_box: "alice", to_box: "team:x", subject: "pool", body: "b" });
    send({ from: "n1", from_box: "bob", to_box: "carol", subject: "dm", body: "b" });

    expect(journalQuery(db, { pool: true }).map((r) => r.subject)).toEqual(["pool"]);
    db.close();
  });

  it("reports legacy global mail with no recipients as a pool broadcast", () => {
    const { db, boxes, send } = setup();
    boxes(["alice"]);
    send({ from: "n9", subject: "legacy", body: "b" });

    const rows = journalQuery(db, {});
    expect(rows[0]).toMatchObject({ subject: "legacy", kind: "pool", to: null });
    db.close();
  });
});
