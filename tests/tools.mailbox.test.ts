import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import type { NodeIdentity } from "../src/lib/identity.js";
import {
  deliverMessage,
  inboxRows,
  joinPool,
  mailboxByName,
  mergeFederatedRegistry,
  registerMailbox,
} from "../src/lib/mail.js";
import { pairWithToken } from "../src/lib/peers.js";
import { buildToolSpecs, type MeshContext, type ToolSpec } from "../src/tools.js";
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
    // 0.29.0: delivery_id left the agent view (an internal key; the reply
    // correlation is reply_to).
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

describe("P1.2 (refonte): the send kind defaults by target", () => {
  it("a DM defaults to notify, a pool to fyi, an explicit fyi DM stays silent", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_join", { pool: "team:x" }, "s1");
    await call("mesh_join", { pool: "team:x" }, "s2");
    await call("mesh_send", { to: "bob", subject: "dm", body: "?" }, "s1");
    await call("mesh_send", { to: "team:x", subject: "pool", body: "!" }, "s1");
    await call("mesh_send", { to: "bob", subject: "fyi dm", body: "fyi", kind: "fyi" }, "s1");
    const kinds = db.conn
      .all<{ subject: string; kind: string; wake: number }>(
        "SELECT subject, kind, wake FROM messages WHERE subject IN ('dm', 'pool', 'fyi dm')",
      )
      .reduce<Record<string, { kind: string; wake: number }>>((acc, r) => {
        acc[r.subject] = { kind: r.kind, wake: r.wake };
        return acc;
      }, {});
    expect(kinds["dm"]).toEqual({ kind: "notify", wake: 0 });
    expect(kinds["pool"]).toEqual({ kind: "fyi", wake: 0 });
    expect(kinds["fyi dm"]).toEqual({ kind: "fyi", wake: 0 });
  });

  it("an explicit notify on a pool is the deliberate broadcast (it wakes)", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_join", { pool: "team:x" }, "s2");
    await call("mesh_send", { to: "team:x", subject: "alerte", body: "!", kind: "notify" }, "s1");
    const row = db.conn.get<{ kind: string; wake: number }>(
      "SELECT kind, wake FROM messages WHERE subject = 'alerte'",
    );
    expect(row?.kind).toBe("notify");
    expect(row?.wake).toBe(1);
  });
});

describe("P2.6 (refonte): the outbox — the agent sees queued, never unreachable", () => {
  it("a peer send queues instead of erroring on a missing address", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    pairWithToken(db, {
      node_id: "peer-1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    // No address for the peer (mDNS churn, rebooted, whatever): the OLD path
    // errored — the agent burned tokens retrying. The outbox queues.
    const out = await call(
      "mesh_send",
      { peer: "peer-1", to: "bob", subject: "s", body: "b" },
      "s1",
    );
    expect(out).toContain("queued:");
    const row = db.conn.get<{ state: string; payload: string }>(
      "SELECT state, payload FROM outbox",
    )!;
    expect(row.state).toBe("queued");
    expect(JSON.parse(row.payload).to_box).toBe("bob");
    // The effectively-once dedup rides origin_id in the payload.
    expect(JSON.parse(row.payload).origin_id).toBeTruthy();
    db.close();
  });

  it("a federated target queues for the owning peer", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    mergeFederatedRegistry(
      db,
      [
        {
          name: "remote-dev",
          session_id: "ses-remote",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
        },
      ],
      "peer-9",
    );
    const out = await call("mesh_send", { to: "remote-dev", subject: "s", body: "b" }, "s1");
    expect(out).toContain("queued:");
    const row = db.conn.get<{ payload: string }>("SELECT payload FROM outbox")!;
    const payload = JSON.parse(row.payload);
    expect(payload.node_id).toBe("peer-9");
    expect(payload.to_box).toBe("remote-dev");
    db.close();
  });
});

describe("P4 (refonte): the blackboard — status is shared state, not DMs", () => {
  it("mesh_board_set writes without waking; mesh_board_get reads one line per box", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_board_set", { key: "task", value: "build 2025" }, "s1");
    await call("mesh_board_set", { key: "state", value: "working" }, "s1");
    await call("mesh_board_set", { key: "task", value: "DNS record" }, "s2");
    // No wake: the board is not a message (no deliveries, no wakeable rows).
    expect(db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries")?.n).toBe(0);
    const out = String(await call("mesh_board_get", {}, "s1"));
    expect(out).toContain("alice");
    expect(out).toContain("build 2025");
    expect(out).toContain("bob");
    expect(out).toContain("DNS record");
    db.close();
  });

  it("mesh_board_get filters by pool; an invalid key refuses", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    await call("mesh_join", { pool: "team:x" }, "s2");
    await call("mesh_board_set", { key: "task", value: "alice task" }, "s1");
    await call("mesh_board_set", { key: "task", value: "bob task" }, "s2");
    const out = String(await call("mesh_board_get", { pool: "team:x" }, "s1"));
    expect(out).toContain("bob");
    expect(out).not.toContain("alice task");
    const bad = await call("mesh_board_set", { key: "free", value: "x" }, "s1");
    expect(bad).toContain("error: key must be one of");
    db.close();
  });
});

describe("P2 (refonte): the ask/reply tools — the federated ask queues, the cross reply queues back", () => {
  it("mesh_ask to a federated box queues task-ask; mesh_reply on the mirror queues task-reply", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    mergeFederatedRegistry(
      db,
      [
        {
          name: "bob-remote",
          session_id: "ses-b",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
          epoch: 2,
        },
      ],
      "node-b",
    );
    const out = await call("mesh_ask", { to: "bob-remote", body: "quel etat?" }, "s1");
    const parsed = JSON.parse(out) as { task_id: string; queued_for: string };
    expect(parsed.queued_for).toBe("node-b");
    // La row task-ask dans l'outbox.
    const askRow = db.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.type') = 'task-ask'",
    )!;
    expect(JSON.parse(askRow.payload).task.id).toBe(parsed.task_id);

    // NOTE: le miroir + la reply cross vivent sur l'AUTRE node (l'id est le
    // meme par design) — le round-trip complet est couvre par
    // tests/lib.outbox.test.ts (le cross-host describe).
    db.close();
  });

  it("mesh_tasks lists the asked and received tasks; mesh_board get/set round trip", async () => {
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    await call("mesh_register", { name: "bob" }, "s2");
    const out = await call("mesh_ask", { to: "bob", body: "q?" }, "s1");
    const parsed = JSON.parse(out) as { task_id: string };
    const listed = String(await call("mesh_tasks", {}, "s1"));
    expect(listed).toContain(parsed.task_id.slice(0, 8));
    expect(listed).toContain("submitted");
    // mesh_board: le set sans reveil, le get une ligne.
    await call("mesh_board_set", { key: "state", value: "live" }, "s1");
    const board = String(await call("mesh_board_get", {}, "s1"));
    expect(board).toContain("alice");
    expect(board).toContain("state=live");
    db.close();
  });
});

describe("B4 (refonte2): the tools NEVER block on the outbox sweeps", () => {
  it("mesh_send to a BLACK-HOLE peer answers in well under 1s (no sweep await)", {
    timeout: 10_000,
  }, async () => {
    const net = await import("node:net");
    // Le black-hole: accepte la connexion, ne repond JAMAIS — le sendMail
    // tient son timeout (10s): le await sweep du OLD code gelait le tour
    // pendant ce temps. Le NEW: queue + trigger, la reponse immediate.
    const blackHole = net.createServer((socket) => {
      socket.on("data", () => {}); // accepte, ignore
    });
    await new Promise<void>((r) => blackHole.listen(0, "127.0.0.1", r));
    const holePort = (blackHole.address() as { port: number }).port;
    const { db, call } = setup();
    await call("mesh_register", { name: "alice" }, "s1");
    pairWithToken(db, {
      node_id: "dead-peer",
      hostname: "dead",
      fingerprint: "ff",
      token: "tok-dead",
      public_key: "test-pk",
      addresses: [`127.0.0.1:${holePort}`],
    });
    const t0 = Date.now();
    const out = await call("mesh_send", { peer: "dead-peer", subject: "s", body: "b" }, "s1");
    const dt = Date.now() - t0;
    expect(out).toContain("queued:");
    expect(dt).toBeLessThan(1000);
    blackHole.close();
    db.close();
  });
});
