import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import type { NodeIdentity } from "../src/lib/identity.js";
import { deliverMessage, inboxRows, mailboxByName, registerMailbox } from "../src/lib/mail.js";
import { buildToolSpecs, type MeshContext, type ToolSpec } from "../src/tools.js";

function setup() {
  const db = openMeshDb(":memory:");
  const mesh: MeshContext = {
    db,
    identity: { node_id: "n1" } as NodeIdentity,
    dataDir: "",
    serverAddress: "127.0.0.1",
    port: 4399,
    worktreeClient: null as never,
    spawnFn: null as never,
  };
  const specs = new Map<string, ToolSpec>(buildToolSpecs(mesh).map((s) => [s.name, s]));
  const call = (
    name: string,
    args: Record<string, unknown> = {},
    sessionID = "s1",
  ): Promise<string> => specs.get(name)!.execute(args, { sessionID });
  return { db, call };
}

describe("mesh_register", () => {
  it("registers a mailbox for the session", async () => {
    const { call } = setup();
    expect(await call("mesh_register", { name: "alice", role: "manager" })).toBe(
      "mailbox alice registered for this session",
    );
  });

  it("rejects invalid names", async () => {
    const { call } = setup();
    expect(await call("mesh_register", { name: "" })).toMatch(/^error:/);
    expect(await call("mesh_register", { name: "a".repeat(65) })).toMatch(/^error:/);
    expect(await call("mesh_register", { name: "bad name!" })).toMatch(/^error:/);
  });

  it("stores the primary pool when it exists and reports it via mesh_status", async () => {
    const { call } = setup();
    // The pool exists once any box carries it: a first box joins, then the
    // new box declares it primary.
    await call("mesh_register", { name: "orchestrator" }, "s0");
    await call("mesh_join", { pool: "team:infra" }, "s0");
    expect(await call("mesh_register", { name: "alice", primary: "team:infra" }, "s1")).toBe(
      "mailbox alice registered for this session",
    );
    const status = JSON.parse(await call("mesh_status")) as {
      mailboxes: Array<{ name: string; primary?: string }>;
    };
    expect(status.mailboxes.find((m) => m.name === "alice")?.primary).toBe("team:infra");
  });

  it("rejects a primary pool that does not exist", async () => {
    const { call } = setup();
    await expect(call("mesh_register", { name: "alice", primary: "team:ghost" })).resolves.toMatch(
      /^error: unknown pool team:ghost/,
    );
  });

  it("without primary the box has none and mesh_status omits the field", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    const status = JSON.parse(await call("mesh_status")) as {
      mailboxes: Array<{ name: string; primary?: string }>;
    };
    expect(status.mailboxes.find((m) => m.name === "alice")?.primary).toBeUndefined();
    expect(mailboxByName(db, "alice")?.primary_pool).toBeNull();
  });

  it("re-registering without primary keeps the declared one", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "lead" }, "s0");
    await call("mesh_join", { pool: "team:x" }, "s0");
    await call("mesh_register", { name: "alice", primary: "team:x" }, "s1");
    await call("mesh_register", { name: "alice", role: "new" }, "s1");
    const status = JSON.parse(await call("mesh_status")) as {
      mailboxes: Array<{ name: string; primary?: string }>;
    };
    expect(status.mailboxes.find((m) => m.name === "alice")?.primary).toBe("team:x");
  });
});

describe("mesh_send", () => {
  it("errors without peer or to", async () => {
    const { call } = setup();
    expect(await call("mesh_send", { subject: "s", body: "b" })).toMatch(/^error:/);
  });

  it("errors on unknown mailbox", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "alice" });
    expect(await call("mesh_send", { to: "bob", subject: "s", body: "b" })).toBe(
      "error: unknown mailbox/pool bob",
    );
  });

  it("delivers to a known box and each session reads only its own mail", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    const out = await call("mesh_send", { to: "bob", subject: "hi", body: "hello" }, "s1");
    const sent = JSON.parse(out) as { id: string; recipients: string[] };
    expect(sent.recipients).toEqual(["bob"]);

    const bobInbox = JSON.parse(await call("mesh_inbox", {}, "s2")) as Array<{
      delivery_id: string;
      from_box: string | null;
      subject: string;
    }>;
    expect(bobInbox).toHaveLength(1);
    expect(bobInbox[0]!.from_box).toBe("alice");
    expect(bobInbox[0]!.subject).toBe("hi");
    expect(bobInbox[0]!.delivery_id).not.toBe("");

    // The cross-drain killer is dead: the sender's session sees nothing.
    expect(await call("mesh_inbox", {}, "s1")).toBe("inbox empty");
    // Ack on read: second read is empty too.
    expect(await call("mesh_inbox", {}, "s2")).toBe("inbox empty");
  });

  it("broadcasts to pool members excluding the sender", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_register", { name: "carol" }, "s3");
    await call("mesh_join", { pool: "team:x" }, "s2");
    await call("mesh_join", { pool: "team:x" }, "s3");
    const out = await call("mesh_send", { to: "team:x", subject: "s", body: "b" }, "s1");
    const sent = JSON.parse(out) as { recipients: string[] };
    expect([...sent.recipients].sort()).toEqual(["bob", "carol"]);
    expect(JSON.parse(await call("mesh_inbox", {}, "s2"))).toHaveLength(1);
    expect(JSON.parse(await call("mesh_inbox", {}, "s3"))).toHaveLength(1);
  });

  it("errors on a broadcast with no recipients", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_join", { pool: "team:solo" }, "s1");
    expect(await call("mesh_send", { to: "team:solo", subject: "s", body: "b" }, "s1")).toBe(
      "error: broadcast team:solo has no recipients",
    );
  });
});

describe("mesh_inbox", () => {
  it("keeps the legacy global feed for unregistered sessions", async () => {
    const { db, call } = setup();
    const sent = deliverMessage(db, { from: "n9", subject: "legacy", body: "b" });
    const inbox = JSON.parse(await call("mesh_inbox", {}, "s-unreg")) as Array<{
      delivery_id: string;
      id: string;
    }>;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.delivery_id).toBe("");
    expect(inbox[0]!.id).toBe(sent.id);
    // Acked through the legacy message path.
    expect(await call("mesh_inbox", {}, "s-unreg")).toBe("inbox empty");
  });
});

describe("mesh_wait", () => {
  it("returns a reply delivered mid-poll and acks it", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    const out = await call("mesh_send", { to: "bob", subject: "q", body: "?" }, "s1");
    const sent = JSON.parse(out) as { id: string };

    const waiting = call("mesh_wait", { id: sent.id, timeout: 2 }, "s1");
    setTimeout(() => {
      deliverMessage(db, {
        from: "n1",
        from_box: "bob",
        to_box: "alice",
        subject: "a",
        body: "!",
        reply_to: sent.id,
      });
    }, 300);
    const row = JSON.parse(await waiting) as { reply_to: string; from_box: string | null };
    expect(row.reply_to).toBe(sent.id);
    expect(row.from_box).toBe("bob");
    expect(await call("mesh_inbox", {}, "s1")).toBe("inbox empty");
  });

  it("times out with the timeout message", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    expect(await call("mesh_wait", { id: "nope", timeout: 1 }, "s1")).toBe(
      "timeout: no reply to nope within 1s",
    );
  });
});

describe("mesh_join / mesh_leave / mesh_pools", () => {
  it("requires registration before joining", async () => {
    const { call } = setup();
    expect(await call("mesh_join", { pool: "team:x" })).toBe("error: run mesh_register first");
  });

  it("aggregates pool membership", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_join", { pool: "team:x" }, "s1");
    await call("mesh_join", { pool: "team:x" }, "s2");
    await call("mesh_leave", { pool: "team:x" }, "s2");
    await call("mesh_join", { pool: "team:y" }, "s2");
    const pools = JSON.parse(await call("mesh_pools")) as Record<string, string[]>;
    expect(pools).toEqual({ "team:x": ["alice"], "team:y": ["bob"] });
  });
});

describe("mesh_status", () => {
  it("lists mailboxes with age_s and the global unread count", async () => {
    const { call } = setup();
    await call("mesh_register", { name: "alice", role: "manager" }, "s1");
    const status = JSON.parse(await call("mesh_status")) as {
      mailboxes: Array<{
        name: string;
        role: string | null;
        pools: string[];
        last_seen: number;
        age_s: number;
      }>;
      unread: number;
    };
    expect(status.mailboxes).toHaveLength(1);
    const box = status.mailboxes[0]!;
    expect(box.name).toBe("alice");
    expect(box.role).toBe("manager");
    expect(box.pools).toEqual([]);
    expect(box.last_seen).toBeGreaterThan(0);
    expect(box.age_s).toBe(0);
    expect(status.unread).toBe(0);
  });

  it("routes mesh_send with peer=<own node id> as a local delivery when to= is given", async () => {
    const { db, call } = setup();
    registerMailbox(db, { name: "orchestrator", session_id: "s-orch", now: 1000 });
    registerMailbox(db, { name: "qm", session_id: "s-qm", now: 1000 });

    const out = await call(
      "mesh_send",
      { peer: "n1", to: "orchestrator", subject: "re: x", body: "answer" },
      "s-qm",
    );
    const parsed = JSON.parse(out) as { recipients: string[] };
    expect(parsed.recipients).toEqual(["orchestrator"]);
    expect(inboxRows(db, "s-orch")[0]?.subject).toBe("re: x");
    db.close();
  });

  it("errors with guidance when peer=<own node id> and no to=", async () => {
    const { call } = setup();
    const out = await call("mesh_send", { peer: "n1", subject: "s", body: "b" }, "s1");
    expect(out).toContain("is THIS node");
    expect(out).toContain("to=<mailbox>");
  });
});
