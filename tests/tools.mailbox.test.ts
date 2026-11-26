import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import type { NodeIdentity } from "../src/lib/identity.js";
import {
  deliverMessage,
  inboxRows,
  joinPool,
  mailboxByName,
  registerMailbox,
} from "../src/lib/mail.js";
import { pairWithToken } from "../src/lib/peers.js";
import {
  buildToolSpecs,
  buildWaitTimeoutMessage,
  meshWaitClamp,
  type MeshContext,
  type ToolSpec,
} from "../src/tools.js";
import type { HostCapa } from "../src/lib/capa.js";

function setup(capa?: () => Promise<HostCapa>) {
  const db = openMeshDb(":memory:");
  const mesh: MeshContext = {
    db,
    identity: { node_id: "n1" } as NodeIdentity,
    dataDir: "",
    serverAddress: "127.0.0.1",
    port: 4399,
    bindKey: "test-project:/work/project",
    worktreeClient: null as never,
    spawnFn: null as never,
    ...(capa !== undefined ? { capa } : {}),
  };
  const specs = new Map<string, ToolSpec>(buildToolSpecs(mesh).map((s) => [s.name, s]));
  const call = (
    name: string,
    args: Record<string, unknown> = {},
    sessionID = "s1",
  ): Promise<string> => specs.get(name)!.execute(args, { sessionID });
  return { db, call };
}

describe("mesh_status capa", () => {
  it("carries the host capabilities when the provider answers", async () => {
    const { call } = setup(async () => ({
      cpu: { cores: 4, loadAvg: 0.5 },
      ram: { totalMb: 16000, usedMb: 8000 },
      workersInFlight: 1,
      sessionsRunning: 2,
    }));
    const status = JSON.parse(await call("mesh_status")) as { capa?: HostCapa };
    expect(status.capa?.cpu.cores).toBe(4);
    expect(status.capa?.workersInFlight).toBe(1);
  });

  it("omits the capa field when no provider is wired", async () => {
    const { call } = setup();
    const status = JSON.parse(await call("mesh_status")) as { capa?: unknown };
    expect("capa" in status).toBe(false);
  });
});

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

  it("auto-joins a primary pool the box has not joined yet", async () => {
    const { db, call } = setup();
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
    // The declared primary is joined automatically: one call settles the
    // box, the role and the primary group.
    expect(mailboxByName(db, "alice")?.pools).toContain("team:infra");
    const pools = JSON.parse(await call("mesh_pools")) as Record<string, string[]>;
    expect(pools["team:infra"]).toContain("alice");
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
      from_box: string | null;
      subject: string;
    }>;
    expect(bobInbox).toHaveLength(1);
    expect(bobInbox[0]!.from_box).toBe("alice");
    expect(bobInbox[0]!.subject).toBe("hi");
    // 0.29.0: delivery_id left the agent view (an internal key; mesh_wait
    // matches on reply_to).
    expect("delivery_id" in bobInbox[0]!).toBe(false);

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
    if (!sent.ok) return;
    const inbox = JSON.parse(await call("mesh_inbox", {}, "s-unreg")) as Array<{
      id: string;
    }>;
    expect(inbox).toHaveLength(1);
    // 0.29.0: delivery_id left the agent view (the legacy path's empty
    // delivery_id was an internal marker anyway).
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

  it("times out cleanly for an unregistered session (mailboxBySession null, global-only path)", async () => {
    const { call } = setup();
    expect(await call("mesh_wait", { id: "nope", timeout: 1 }, "s-unreg")).toBe(
      "timeout: no reply to nope within 1s",
    );
  });

  it("on timeout, lists the uncorrelated replies sitting in the box (the wake-path answers, 0.30.1)", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_register", { name: "carol" }, "s3");
    const out = await call("mesh_send", { to: "bob", subject: "q", body: "?" }, "s1");
    const sent = JSON.parse(out) as { id: string };
    // A reply from a THIRD box: not the request's recipient, so the sender
    // match cannot fire — the wait reaches its timeout and lists the stray.
    deliverMessage(db, {
      from: "n1",
      from_box: "carol",
      to_box: "alice",
      subject: "re: q",
      body: "!",
      created_at: Date.now() + 10,
    });
    const result = await call("mesh_wait", { id: sent.id, timeout: 1 }, "s1");
    expect(result).toContain(`timeout: no reply to ${sent.id} within 1s`);
    expect(result).toContain("uncorrelated");
    expect(result).toContain("carol");
    expect(result).toContain("re: q");
    expect(result).toContain("mesh_inbox");
  });
});

describe("P3+ (0.32.0): mesh_status exposes the loaded plugin version", () => {
  it("carries plugin_version: the runtime truth the agents could only guess (the convergence lesson)", async () => {
    const { call } = setup();
    const out = await call("mesh_status", {}, "s1");
    const status = JSON.parse(out) as { plugin_version: string };
    expect(status.plugin_version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("P3 (0.31.0): the reply correlation is server-side", () => {
  it("a bare answer auto-carries reply_to = the pending question it answers", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    const out = await call("mesh_send", { to: "bob", subject: "q", body: "?" }, "s1");
    const sent = JSON.parse(out) as { id: string };
    // Bob answers WITHOUT reply_to — the discipline the agents never had.
    await call("mesh_send", { to: "alice", subject: "re: q", body: "!" }, "s2");
    const row = db.conn.get<{ reply_to: string | null }>(
      "SELECT reply_to FROM messages WHERE from_box = 'bob' AND subject = 're: q'",
    );
    expect(row?.reply_to).toBe(sent.id);
  });

  it("an explicit reply_to wins over the auto-fill", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_send", { to: "bob", subject: "q", body: "?" }, "s1");
    await call(
      "mesh_send",
      { to: "alice", subject: "re: q", body: "!", reply_to: "explicit-id" },
      "s2",
    );
    const row = db.conn.get<{ reply_to: string | null }>(
      "SELECT reply_to FROM messages WHERE from_box = 'bob'",
    );
    expect(row?.reply_to).toBe("explicit-id");
  });

  it("nothing pending: the answer carries no invented reply_to", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_send", { to: "alice", subject: "cold call", body: "hi" }, "s2");
    const row = db.conn.get<{ reply_to: string | null }>(
      "SELECT reply_to FROM messages WHERE from_box = 'bob'",
    );
    expect(row?.reply_to).toBeNull();
  });
});

describe("P4 (0.31.0): mesh_wait is bounded and correlates on the sender", () => {
  it("a reply that bypassed the auto-fill still returns the wait (sender match)", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    const out = await call("mesh_send", { to: "bob", subject: "q", body: "?" }, "s1");
    const sent = JSON.parse(out) as { id: string };
    const t0 = Date.now();
    const waiting = call("mesh_wait", { id: sent.id, timeout: 5 }, "s1");
    // DB-level delivery: the answer bypasses mesh_send, so NO auto-fill —
    // reply_to stays NULL (a legacy/wire-path reply). The wait must still
    // return on the sender + arrival-after-request match.
    setTimeout(() => {
      deliverMessage(db, {
        from: "n1",
        from_box: "bob",
        to_box: "alice",
        subject: "re: q",
        body: "!",
      });
    }, 300);
    const row = JSON.parse(await waiting) as { from_box: string | null; subject: string };
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(row.from_box).toBe("bob");
    expect(row.subject).toBe("re: q");
  });

  it("the timeout message names the clamp — the caller never reads an unexplained early death (the orq repro, 0.32.0)", () => {
    // orq: timeout 60 requested, the result said "within 30s" with no word
    // about the clamp — read as a mechanical abort or an agent silence.
    const msg = buildWaitTimeoutMessage("id-x", 30, 60, []);
    expect(msg).toContain("within 30s");
    expect(msg).toContain("requested 60s");
    expect(msg).toContain("clamped");
    // An explicit short timeout: no clamp note.
    const plain = buildWaitTimeoutMessage("id-y", 5, 5, []);
    expect(plain).not.toContain("clamped");
  });

  it("the clamp caps the requested timeout at 30s", () => {
    expect(meshWaitClamp(300)).toBe(30);
    expect(meshWaitClamp(undefined)).toBe(30);
    expect(meshWaitClamp(5)).toBe(5);
  });
});

describe("mesh_journal", () => {
  it("returns the header line plus compact JSON metadata without bodies", async () => {
    const { db, call } = setup();
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    deliverMessage(db, {
      from: "n1",
      from_box: "alice",
      to_box: "bob",
      subject: "hi",
      body: "SECRET-BODY",
      created_at: 5000,
    });
    const out = await call("mesh_journal");
    expect(out).toMatch(/^journal: 1 entries \(from /);
    expect(out).toContain("machine-local)");
    const rows = JSON.parse(out.slice(out.indexOf("\n") + 1)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: "alice", to: ["bob"], subject: "hi", kind: "dm" });
    expect(rows[0]).not.toHaveProperty("body");
  });

  it("parses since as ISO or epoch ms", async () => {
    const { db, call } = setup();
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    deliverMessage(db, {
      from: "n1",
      from_box: "alice",
      to_box: "bob",
      subject: "old",
      body: "b",
      created_at: Date.now() - 60_000,
    });
    deliverMessage(db, {
      from: "n1",
      from_box: "alice",
      to_box: "bob",
      subject: "new",
      body: "b",
      created_at: Date.now(),
    });
    const iso = await call("mesh_journal", {
      since: new Date(Date.now() - 30_000).toISOString(),
    });
    expect(iso).toContain('"new"');
    expect(iso).not.toContain('"old"');
    const epoch = await call("mesh_journal", { since: String(Date.now() - 30_000) });
    expect(epoch).toContain('"new"');
    expect(epoch).not.toContain('"old"');
  });

  it("rejects an unparseable since", async () => {
    const { call } = setup();
    expect(await call("mesh_journal", { since: "not-a-date" })).toMatch(
      /^error: since must be an ISO date or epoch ms/,
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

  it("mesh_send stores wake on the message only when the flag is passed (0.17.0)", async () => {
    const { db, call } = setup();
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "b", session_id: "s2", now: 1000 });
    joinPool(db, "a", "team:x");
    joinPool(db, "b", "team:x");

    await call("mesh_send", { to: "team:x", subject: "flagged", body: "b", wake: true }, "s1");
    await call("mesh_send", { to: "team:x", subject: "quiet", body: "b" }, "s1");

    const wakes = db.conn
      .all<{ subject: string; wake: number }>(
        "SELECT subject, wake FROM messages ORDER BY created_at",
      )
      .map((r) => `${r.subject}:${r.wake}`);
    expect(wakes).toEqual(["flagged:1", "quiet:0"]);
    db.close();
  });

  it("refuses to send to a TLS peer with no pinned key — no silent TOFU (0.18.0)", async () => {
    const { db, call } = setup();
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    // A pairing from the pre-pinned-key era: tls = 1 (0.11+ default), the
    // peer row carries NO public_key. resolvePeerTarget then yields pk=null
    // and the TLS transport would accept ANY certificate.
    pairWithToken(db, {
      node_id: "legacy-peer",
      hostname: "legacy",
      fingerprint: "ff",
      token: "tok-legacy",
      addresses: ["127.0.0.1:4399"],
    });
    const out = await call("mesh_send", { peer: "legacy-peer", subject: "s", body: "b" }, "s1");
    expect(out).toBe(
      "error: peer legacy-peer is TLS but has no pinned key — re-pair with mesh_pair",
    );
    db.close();
  });
});
