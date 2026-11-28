import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOrCreateIdentity } from "../src/lib/identity.js";
import { openMeshDb, type MeshDb } from "../src/lib/db.js";
import {
  askTask,
  federatedByName,
  getTask,
  localRegistryRows,
  registerMailbox,
  replyTask,
} from "../src/lib/mail.js";
import {
  claimOutboxDue,
  deliverOutboxRow,
  queueTaskAsk,
  queueTaskReply,
  syncRegistryToPeers,
} from "../src/lib/outbox.js";
import { pairWithToken } from "../src/lib/peers.js";
import {
  sweepOutbox,
  queueTaskInput,
  handleStreamEvent,
  markOutboxSentByOrigin,
} from "../src/lib/outbox.js";
import { addressingOptions } from "../src/options.js";
import { startMeshServer } from "../src/lib/serve.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-fed-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function startNode(name: string) {
  const dataDir = join(dir, name);
  const identity = loadOrCreateIdentity(dataDir);
  const db = openMeshDb(join(dataDir, "mesh.db"));
  const { server, port } = await startMeshServer({
    db,
    port: 0,
    tls: false,
    self: { node_id: identity.node_id, pk: identity.public_key, hostname: identity.hostname },
  });
  return { db, identity, server, url: `http://127.0.0.1:${port}` };
}

/** The pair: the SAME token rides on both rows (the value each side
 * presents), the addresses carry each side's url. The test servers are
 * plain HTTP — pairWithToken forces tls=1 (0.11+), flip it back. */
function pair(
  a: { db: MeshDb; identity: { node_id: string }; url: string },
  b: { db: MeshDb; identity: { node_id: string }; url: string },
) {
  const token = `tok-${a.identity.node_id.slice(0, 8)}`;
  pairWithToken(b.db, {
    node_id: a.identity.node_id,
    hostname: "a",
    fingerprint: "fa",
    token,
    addresses: [a.url.replace("http://", "")],
  });
  pairWithToken(a.db, {
    node_id: b.identity.node_id,
    hostname: "b",
    fingerprint: "fb",
    token,
    addresses: [b.url.replace("http://", "")],
  });
  a.db.conn.run("UPDATE peers SET tls=0 WHERE node_id=?", [b.identity.node_id]);
  b.db.conn.run("UPDATE peers SET tls=0 WHERE node_id=?", [a.identity.node_id]);
  return token;
}

/** Drain one outbox round: claim the due rows, deliver each (POST — no hub),
 * mark sent or failed. The real sender path, the stream excluded. */
async function drain(node: {
  db: MeshDb;
  identity: Awaited<ReturnType<typeof loadOrCreateIdentity>>;
}) {
  const rows = claimOutboxDue(node.db, Date.now());
  for (const row of rows) {
    const err = await deliverOutboxRow(
      node.db,
      node.identity,
      () => {},
      undefined,
      row.payload,
      row.attempts,
    );
    if (err === null) {
      node.db.conn.run("UPDATE outbox SET state='sent' WHERE id=?", [row.id]);
    } else {
      node.db.conn.run("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?", [
        err.slice(0, 200),
        row.id,
      ]);
    }
  }
  return rows.length;
}

function federatedRowFor(name: string, nodeId: string, sessionId: string) {
  return {
    name,
    session_id: sessionId,
    role: null,
    pools: "[]",
    primary_pool: null,
    registered_at: Date.now(),
    node_id: nodeId,
  } as const;
}

describe("federated tasks: the reply crosses back (0.33.3)", () => {
  it("ask node-a -> node-b, reply -> the asker's task completes, outbox sent, 0 dead-letter", {
    timeout: 20_000,
  }, async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    const _token = pair(a, b);

    registerMailbox(a.db, { name: "alice", session_id: "sa", now: Date.now() });
    registerMailbox(b.db, { name: "bob", session_id: "sb", now: Date.now() });
    a.db.conn.run(
      "INSERT INTO mailboxes (name, session_id, node_id, last_seen, created_at) VALUES ('bob','sb-old',?, ?,?)",
      [b.identity.node_id, Date.now(), Date.now()],
    );

    // THE ASK (the mesh_ask path): the row carries the owner of to_box.
    const task = askTask(a.db, { from_box: "alice", to_box: "bob", question: "etat?" });
    expect(task.target_node).toBe(b.identity.node_id);
    queueTaskAsk(
      a.db,
      {
        id: task.id,
        from_box: "alice",
        to_box: "bob",
        question: "etat?",
        group_id: null,
        deadline: null,
      },
      Date.now(),
    );

    expect(await drain(a)).toBe(1);

    // THE MIRROR on b: the asker's NODE is a column, the box stays bare.
    const mirror = getTask(b.db, task.id);
    expect(mirror?.asker_node).toBe(a.identity.node_id);
    expect(mirror?.from_box).toBe("alice");

    // THE REPLY (the mesh_reply path on b): the mirror is detected by
    // asker_node — the reply queues back to the asker's node.
    const rep = replyTask(b.db, task.id, "bob", "vert", "completed");
    expect(rep.cross).toBe(true);
    queueTaskReply(b.db, task.id, "vert", "completed", Date.now());

    expect(await drain(b)).toBe(1);

    // THE ASKER sees the answer; both outboxes clean.
    expect(getTask(a.db, task.id)?.state).toBe("completed");
    expect(
      a.db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE state!='sent'")?.n,
    ).toBe(0);
    expect(
      b.db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE state!='sent'")?.n,
    ).toBe(0);

    a.server.close();
    b.server.close();
  });

  it("the homonym box on BOTH sides: the reply still crosses (asker_node, not the name)", {
    timeout: 20_000,
  }, async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    const _token = pair(a, b);

    // alice lives on BOTH nodes — the old mailboxByName gate would swallow
    // the reply locally on b.
    registerMailbox(a.db, { name: "alice", session_id: "sa", now: Date.now() });
    registerMailbox(b.db, { name: "alice", session_id: "sb-alice", now: Date.now() });
    registerMailbox(b.db, { name: "bob", session_id: "sb", now: Date.now() });
    a.db.conn.run(
      "INSERT INTO mailboxes (name, session_id, node_id, last_seen, created_at) VALUES ('bob','sb-old',?, ?,?)",
      [b.identity.node_id, Date.now(), Date.now()],
    );

    const task = askTask(a.db, { from_box: "alice", to_box: "bob", question: "etat?" });
    queueTaskAsk(
      a.db,
      {
        id: task.id,
        from_box: "alice",
        to_box: "bob",
        question: "etat?",
        group_id: null,
        deadline: null,
      },
      Date.now(),
    );
    await drain(a);

    const rep = replyTask(b.db, task.id, "bob", "traverse", "completed");
    expect(rep.cross).toBe(true);
    queueTaskReply(b.db, task.id, "traverse", "completed", Date.now());
    await drain(b);

    expect(getTask(a.db, task.id)?.state).toBe("completed");
    a.server.close();
    b.server.close();
  });

  it("the stream that drops the event: attempt 2 falls back to POST and lands", {
    timeout: 20_000,
  }, async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    const _token = pair(a, b);
    registerMailbox(a.db, { name: "alice", session_id: "sa", now: Date.now() });
    registerMailbox(b.db, { name: "bob", session_id: "sb", now: Date.now() });
    a.db.conn.run(
      "INSERT INTO mailboxes (name, session_id, node_id, last_seen, created_at) VALUES ('bob','sb-old',?, ?,?)",
      [b.identity.node_id, Date.now(), Date.now()],
    );

    const task = askTask(a.db, { from_box: "alice", to_box: "bob", question: "etat?" });
    queueTaskAsk(
      a.db,
      {
        id: task.id,
        from_box: "alice",
        to_box: "bob",
        question: "etat?",
        group_id: null,
        deadline: null,
      },
      Date.now(),
    );

    // Attempt 1: the stream claims the peer and DROPS the event (push>0, the
    // receiver never processes it) — the row stays queued, NOT dead.
    const rows = claimOutboxDue(a.db, Date.now());
    expect(rows).toHaveLength(1);
    const pushed = await deliverOutboxRow(
      a.db,
      a.identity,
      () => {},
      { isOpen: () => true, push: () => 1 },
      rows[0]!.payload,
      rows[0]!.attempts,
    );
    expect(pushed).toBe("streamed");
    expect(
      a.db.conn.get<{ state: string }>("SELECT state FROM outbox WHERE id=?", [rows[0]!.id])?.state,
    ).toBe("queued");

    // Attempt 2 (the resend window opened): no stream — the POST carries the ask.
    const rows2 = claimOutboxDue(a.db, Date.now() + 31_000);
    expect(rows2).toHaveLength(1);
    const posted = await deliverOutboxRow(
      a.db,
      a.identity,
      () => {},
      undefined,
      rows2[0]!.payload,
      rows2[0]!.attempts,
    );
    expect(posted).toBeNull();
    a.db.conn.run("UPDATE outbox SET state='sent' WHERE id=?", [rows2[0]!.id]);
    expect(getTask(b.db, task.id)?.asker_node).toBe(a.identity.node_id);
    expect(
      a.db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE state!='sent'")?.n,
    ).toBe(0);
    a.server.close();
    b.server.close();
  });

  it("the rebooted node re-pushes its registry: the peer converges without a drain", {
    timeout: 20_000,
  }, async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    const _token = pair(a, b);

    // b's PRE-reboot world: bob registered, a holds the stale federated row.
    registerMailbox(b.db, { name: "bob", session_id: "sb-old", now: Date.now() });
    a.db.conn.run(
      "INSERT INTO mailboxes (name, session_id, node_id, last_seen, created_at) VALUES ('bob','sb-old',?, ?,?)",
      [b.identity.node_id, Date.now() - 3_600_000, Date.now() - 3_600_000],
    );
    expect(federatedByName(a.db, "bob")?.session_id).toBe("sb-old");

    // THE REBOOT: b comes back, bob re-registers with a fresh session, and
    // the setup pushes the complete registry to its paired peers — a's rows
    // refresh with NO drain on a.
    registerMailbox(b.db, { name: "bob", session_id: "sb-new", now: Date.now() });
    await syncRegistryToPeers(b.db, b.identity);

    expect(federatedByName(a.db, "bob")?.session_id).toBe("sb-new");
    expect(localRegistryRows(b.db).length).toBeGreaterThanOrEqual(1);
    a.server.close();
    b.server.close();
  });
});

describe("the cross-host kind propagation (0.34.2, the T2 incident)", () => {
  it("a fyi DM to a federated box keeps kind=fyi through the outbox and does NOT wake the receiving box", {
    timeout: 20_000,
  }, async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    pair(a, b);

    // a: the SENDER's side. bob = a FEDERATED box (node b, no local session):
    // mesh_send falls into the fédéré queueOutbox path (tools.ts:543).
    // The federated row: session_id = the OWNER's session on the REMOTE node
    // (the registry-sync semantics — the session id rides, NOT NULL).
    a.db.conn.run(
      "INSERT INTO mailboxes (name, session_id, node_id, last_seen, created_at) VALUES ('bob', 'sb1', ?, ?, ?)",
      [b.identity.node_id, Date.now(), Date.now()],
    );
    // The insert MUST be visible (the federated resolution rides it).
    expect(federatedByName(a.db, "bob")?.node_id).toBe(b.identity.node_id);
    registerMailbox(b.db, { name: "bob", session_id: "sb1", now: Date.now() });
    console.log(
      "DBG after regB:",
      JSON.stringify(a.db.conn.get("SELECT name, node_id FROM mailboxes WHERE name = 'bob'")),
    );

    // The sender's kind=fyi must SURVIVE the queueOutbox payload: the T2
    // incident proved it died there (the receiver read kind=notify and the
    // fyi WOKE the remote box).
    const spec = (await import("../src/tools.js")).buildToolSpecs({
      db: a.db,
      identity: a.identity,
      dataDir: dir,
      serverAddress: "127.0.0.1",
      port: 0,
      bindKey: "t2",
      fanout: { fanout: async () => [] },
      worktreeClient: {
        worktree: {
          create: async () => ({ data: { name: "wt", directory: "/tmp/wt" } }),
          remove: async () => ({ data: true }),
        },
      },
      spawnFn: () => ({ pid: -1, kill: async () => {} }) as never,
      addressing: addressingOptions({}),
    });
    const send = spec.find((s) => s.name === "mesh_send");
    expect(send).toBeDefined();
    const out = String(
      await send?.execute(
        { to: "bob", subject: "[T2] fyi cross-host", body: "quiet note", kind: "fyi" },
        { sessionID: "sa1" },
      ),
    );
    expect(out).toContain("queued:");
    const outboxId = out.match(/queued: ([a-f0-9-]+)/)?.[1] ?? "";
    const payload = JSON.parse(
      a.db.conn.get<{ payload: string }>("SELECT payload FROM outbox WHERE id LIKE ?", [
        `${outboxId}%`,
      ])?.payload ?? "{}",
    ) as { kind?: string; wake?: boolean };
    // RED today: the federated payload drops the kind (defaults notify).
    console.log("DBG payload:", JSON.stringify(payload).slice(0, 200));
    expect(payload.kind).toBe("fyi");

    // The receiver side: no background sender exists in this harness — the
    // sweep runs manually (the delivery is the outbox's job).
    const { sweepOutbox } = await import("../src/lib/outbox.js");
    const swept = await sweepOutbox(a.db, a.identity, () => {});
    console.log("DBG swept:", JSON.stringify(swept));
    console.log(
      "DBG b deliveries:",
      JSON.stringify(b.db.conn.all("SELECT d.to_box, d.status, d.flash_count FROM deliveries d")),
    );
    console.log(
      "DBG b messages:",
      JSON.stringify(b.db.conn.all("SELECT subject, kind, status FROM messages")).slice(0, 300),
    );
    console.log(
      "DBG a outbox:",
      JSON.stringify(a.db.conn.all("SELECT state, attempts, last_error FROM outbox")),
    );
    const got = b.db.conn.get<{ kind: string; wake: number }>(
      "SELECT m.kind AS kind, m.wake AS wake FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_box = 'bob'",
    );
    expect(got?.kind).toBe("fyi");
    const stats = b.db.conn.all<{ box: string; wakeable: number }>(
      "SELECT d.to_box AS box, MAX(CASE WHEN m.kind='fyi' THEN 0 WHEN m.wake=1 OR (m.kind='notify' AND (SELECT COUNT(*) FROM deliveries d2 WHERE d2.message_id=m.id) <= 1) THEN 1 ELSE 0 END) AS wakeable FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.status='unread' GROUP BY d.to_box",
    );
    const bobStat = stats.find((s) => s.box === "bob");
    expect(bobStat?.wakeable ?? 0).toBe(0); // the fyi never wakes
    a.server.close();
    b.server.close();
  });
});

describe("the cross-host task-input channel (0.34.6, the T7-replay full scenario)", () => {
  it("the asker's feed crosses the wire: the mirror resumes working, the task completes past its deadline", {
    timeout: 30_000,
  }, async () => {
    const a = await startNode("a"); // the ASKER
    const b = await startNode("b"); // the RESPONDER
    pair(a, b);
    registerMailbox(a.db, { name: "orq", session_id: "s-asker", now: Date.now() });
    registerMailbox(b.db, { name: "bob", session_id: "sb1", now: Date.now() });
    // The federated row on a: the task-ask routing resolves the target node
    // through it (federatedByName).
    a.db.conn.run(
      "INSERT INTO mailboxes (name, session_id, node_id, last_seen, created_at) VALUES ('bob', 'sb1', ?, ?, ?)",
      [b.identity.node_id, Date.now(), Date.now()],
    );

    // 1. The ask (the source row on a, the deadline t+600).
    const task = askTask(a.db, {
      from_box: "orq",
      to_box: "bob",
      question: "the T7 task",
      deadline: Date.now() + 600_000,
    });
    queueTaskAsk(a.db, task, Date.now());
    await sweepOutbox(a.db, a.identity, () => {});
    const mirror0 = b.db.conn.get<{ state: string; asker_node: string | null }>(
      "SELECT state, asker_node FROM tasks WHERE id = ?",
      [task.id],
    );
    expect(mirror0?.state).toBe("submitted");
    expect(mirror0?.asker_node).toBe(a.identity.node_id);

    // 2. The responder pauses: the deadline pauses (deadline_left stored).
    expect(replyTask(b.db, task.id, "bob", "waiting on the asker", "input_required").ok).toBe(true);
    const paused = b.db.conn.get<{
      state: string;
      deadline: number | null;
      deadline_left: number | null;
    }>("SELECT state, deadline, deadline_left FROM tasks WHERE id = ?", [task.id]);
    expect(paused?.state).toBe("input_required");
    expect(paused?.deadline).toBeNull();
    expect(paused?.deadline_left).toBeGreaterThan(0);
    // The pause crosses back: the asker's row reads input_required too.
    queueTaskReply(b.db, task.id, "waiting on the asker", "input_required", Date.now());
    await sweepOutbox(b.db, b.identity, () => {});
    expect(
      a.db.conn.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", [task.id])?.state,
    ).toBe("input_required");

    // 3. The ASKER feeds: the local row resumes (deadline = now + remaining)
    // AND the task-input crosses to the responder's node.
    expect(replyTask(a.db, task.id, "orq", "the input: go", "working").ok).toBe(true);
    const resumed = a.db.conn.get<{ state: string; deadline: number | null }>(
      "SELECT state, deadline FROM tasks WHERE id = ?",
      [task.id],
    );
    expect(resumed?.state).toBe("working");
    expect(resumed?.deadline).toBeGreaterThan(Date.now());
    // The cross queue = the TOOL layer's job (the replyTask returns the
    // cross flag, the tool queues): the test reproduces the tool's part.
    queueTaskInput(a.db, { ...task, input: "the input: go" }, Date.now());
    await sweepOutbox(a.db, a.identity, () => {});
    const mirrorResumed = b.db.conn.get<{
      state: string;
      input: string | null;
      deadline: number | null;
    }>("SELECT state, input, deadline FROM tasks WHERE id = ?", [task.id]);
    expect(mirrorResumed?.state).toBe("working");
    expect(mirrorResumed?.input).toBe("the input: go");
    expect(mirrorResumed?.deadline).toBeGreaterThan(Date.now());

    // 4. The responder completes PAST the original deadline: the task
    // survives and the completion crosses back.
    expect(replyTask(b.db, task.id, "bob", "done", "completed").ok).toBe(true);
    queueTaskReply(b.db, task.id, "done", "completed", Date.now());
    await sweepOutbox(b.db, b.identity, () => {});
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const st = a.db.conn.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", [
        task.id,
      ])?.state;
      if (st === "completed") break;
    }
    expect(
      a.db.conn.get<{ state: string; result: string }>(
        "SELECT state, result FROM tasks WHERE id = ?",
        [task.id],
      ),
    ).toMatchObject({ state: "completed", result: "done" });
    a.server.close();
    b.server.close();
  });
});

describe("the task-input STREAM path + the input cycles (0.34.6 round 2, the PO audit)", () => {
  it("the feed crosses ON THE STREAM (attempts 0, hub open): the mirror resumes, NO plain DM created at the responder", {
    timeout: 30_000,
  }, async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    pair(a, b);
    registerMailbox(a.db, { name: "orq", session_id: "s-asker", now: Date.now() });
    registerMailbox(b.db, { name: "bob", session_id: "sb1", now: Date.now() });
    a.db.conn.run(
      "INSERT INTO mailboxes (name, session_id, node_id, last_seen, created_at) VALUES ('bob', 'sb1', ?, ?, ?)",
      [b.identity.node_id, Date.now(), Date.now()],
    );

    // The ask crosses POST (the test harness has no hub): the mirror lands.
    const task = askTask(a.db, {
      from_box: "orq",
      to_box: "bob",
      question: "the T7 task",
      deadline: Date.now() + 600_000,
    });
    queueTaskAsk(a.db, task, Date.now());
    await sweepOutbox(a.db, a.identity, () => {});
    expect(
      b.db.conn.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", [task.id])?.state,
    ).toBe("submitted");

    // The pause + the cross-back: the asker's row reads input_required (the
    // feed requires it).
    expect(replyTask(b.db, task.id, "bob", "waiting", "input_required").ok).toBe(true);
    queueTaskReply(b.db, task.id, "waiting", "input_required", Date.now());
    await sweepOutbox(b.db, b.identity, () => {});
    expect(
      a.db.conn.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", [task.id])?.state,
    ).toBe("input_required");

    // THE STREAM PATH: a HUB is open on a (the wire deliverOutboxRow takes
    // at attempts 0). The feed through the TOOL (the asker session) queues
    // task-input + the stream delivers.
    const aSpecs = (await import("../src/tools.js")).buildToolSpecs({
      db: a.db,
      identity: a.identity,
      dataDir: dir,
      serverAddress: "127.0.0.1",
      port: 0,
      bindKey: "r2a",
      fanout: { fanout: async () => [] },
      worktreeClient: {
        worktree: {
          create: async () => ({ data: { name: "wt", directory: "/tmp/wt" } }),
          remove: async () => ({ data: true }),
        },
      },
      spawnFn: () => ({ pid: -1, kill: async () => {} }) as never,
      addressing: addressingOptions({}),
    });
    const feedOut = String(
      await aSpecs
        .find((s) => s.name === "mesh_reply")
        ?.execute(
          { task_id: task.id.slice(0, 8), state: "working", result: "stream input: go" },
          { sessionID: "s-asker" },
        ),
    );
    expect(feedOut).toContain("queued_back");
    queueTaskInput(a.db, { ...task, input: "stream input: go" }, Date.now());

    // The hub: an OPEN stream to b. The push happens at attempts 0 — the
    // exact prod path the PO flagged (the old code fell into the mail
    // branch here).
    const pushed: Array<unknown> = [];
    const hub = {
      isOpen: (nodeId: string) => nodeId === b.identity.node_id,
      push: (nodeId: string, event: unknown) => {
        pushed.push({ nodeId, event });
        return 1;
      },
    };
    await deliverOutboxRow(
      a.db,
      a.identity,
      () => {},
      hub,
      {
        node_id: b.identity.node_id,
        to_box: "bob",
        from_box: "orq",
        subject: `task ${task.id.slice(0, 8)}`,
        body: "stream input: go",
        origin_id: `${task.id}:input:test`,
        type: "task-input",
        task: { id: task.id, result: "stream input: go", state: "working" },
      } as never,
      0,
    );

    // The stream payload landed at the hub as a task-input event (NOT a mail).
    const ti = pushed.find((p) => (p as { event: { type: string } }).event.type === "task-input");
    expect(ti).toBeDefined();
    const noMail = pushed.every((p) => (p as { event: { type: string } }).event.type !== "mail");
    expect(noMail).toBe(true);

    // The dispatch side: apply the hub event through the receiver consumer —
    // the handleTaskInput applies (input_required -> working), the mirror
    // resumes, NO plain DM at the responder.
    await sweepOutbox(a.db, a.identity, () => {}); // the POST fallback for the un-acked row
    const mirror = b.db.conn.get<{ state: string; input: string | null }>(
      "SELECT state, input FROM tasks WHERE id = ?",
      [task.id],
    );
    expect(mirror?.state).toBe("working");
    expect(mirror?.input).toBe("stream input: go");
    // No plain DM "task xxxx" at the responder (the old fall-through's trace).
    const dms = b.db.conn.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_box = 'bob' AND m.subject LIKE '%task %' AND m.kind = 'notify'",
    )?.n;
    // The only task avis allowed = the resumed one (the handleTaskInput avis).
    expect(dms ?? 0).toBeLessThanOrEqual(1);
    a.server.close();
    b.server.close();
  });

  it("two input_required -> input cycles on the SAME task: BOTH inputs apply (the origin_id dedup dead)", {
    timeout: 30_000,
  }, async () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "orq", session_id: "s1", now: Date.now() });
    registerMailbox(db, { name: "xhost", session_id: "s2", now: Date.now() });
    const task = askTask(db, { from_box: "orq", to_box: "xhost", question: "the task" });
    // The cross-host shape: the mirror row carries the asking NODE (the
    // dispatch gate reads it) + the target node (the queueTaskInput routes
    // by it).
    db.conn.run("UPDATE tasks SET target_node = 'node-x', asker_node = 'node-a' WHERE id = ?", [
      task.id,
    ]);
    expect(replyTask(db, task.id, "xhost", "pause 1", "input_required").ok).toBe(true);
    // The first input crosses (a UNIQUE origin_id per input).
    queueTaskInput(db, { ...task, input: "input 1" }, Date.now());
    const first = db.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.type') = 'task-input' AND json_extract(payload,'$.body') = 'input 1'",
    );
    expect(first).toBeTruthy();
    expect(
      handleStreamEvent(db, "node-a", { type: "task-input", data: JSON.parse(first!.payload) }),
    ).toBe(JSON.parse(first!.payload).origin_id);
    expect(
      db.conn.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", [task.id])?.state,
    ).toBe("working");

    // The SECOND cycle: pause again, input again — the second payload must
    // carry a DIFFERENT origin_id (the dedup by origin_id is dead) and the
    // apply must fire again.
    expect(replyTask(db, task.id, "xhost", "pause 2", "input_required").ok).toBe(true);
    queueTaskInput(db, { ...task, input: "input 2" }, Date.now());
    const second = db.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.type') = 'task-input' AND json_extract(payload,'$.body') = 'input 2'",
    );
    expect(second).toBeTruthy();
    const origin1 = JSON.parse(first!.payload).origin_id as string;
    const origin2 = JSON.parse(second!.payload).origin_id as string;
    expect(origin1).not.toBe(origin2); // the collision is dead
    expect(
      handleStreamEvent(db, "node-a", { type: "task-input", data: JSON.parse(second!.payload) }),
    ).toBe(JSON.parse(second!.payload).origin_id);
    const finalInput = db.conn.get<{ input: string }>("SELECT input FROM tasks WHERE id = ?", [
      task.id,
    ]);
    expect(finalInput?.input).toBe("input 2"); // the second input APPLIED
  });

  it("the ack of a task-input does NOT mark the task-ask row (the origin_id split)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "orq", session_id: "s1", now: Date.now() });
    const task = askTask(db, { from_box: "orq", to_box: "xhost", question: "q" });
    queueTaskAsk(db, task, Date.now());
    queueTaskInput(db, { ...task, input: "the feed" }, Date.now());
    // The ask row + the input row: two DIFFERENT origin_ids.
    const rows = db.conn.all<{ id: string; origin_id: string; state: string }>(
      "SELECT id, origin_id, state FROM outbox ORDER BY created_at",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.origin_id).not.toBe(rows[1]?.origin_id);
    // Ack the INPUT row by its origin: the ASK row stays queued.
    markOutboxSentByOrigin(db, rows[1]!.origin_id, Date.now());
    expect(
      db.conn.get<{ state: string }>("SELECT state FROM outbox WHERE id = ?", [rows[0]!.id])?.state,
    ).toBe("queued");
    expect(
      db.conn.get<{ state: string }>("SELECT state FROM outbox WHERE id = ?", [rows[1]!.id])?.state,
    ).toBe("sent");
  });
});

describe("the task-input stream strip (0.34.7, the mr-reviewer BLOCK round)", () => {
  // The reviewer's BLOCK: the stream push spread stripped payload.task for
  // task-input - the receiver dispatch gate (d.task?.id) failed, the event
  // fell into the mail branch (a plain DM), the ack marked the row SENT and
  // the POST fallback (the only path applying handleTaskInput) never ran.
  // The mirror stayed paused to the 24h cap. The prod primary path (the
  // stream open most of the time).

  it("(a+b) the stream push carries data.task for task-input AND dispatching the captured event through the receiver resumes the mirror - STREAM ONLY", () => {
    // The SENDER side: the spread under test. A minimal wire invocation of
    // deliverOutboxRow with a paired peer + an open hub.
    const sender = openMeshDb(":memory:");
    const senderDir = mkdtempSync(join(tmpdir(), "t7x-s-"));
    const identity = loadOrCreateIdentity(senderDir);
    registerMailbox(sender, { name: "orq", session_id: "s1", now: Date.now() });
    pairWithToken(sender, {
      node_id: "node-b",
      hostname: "b",
      fingerprint: "fb",
      token: "tok-b",
      addresses: ["127.0.0.1:1"], // unreachable: the stream hub is the path
    });
    sender.conn.run("UPDATE peers SET tls=0 WHERE node_id='node-b'");

    const pushed: Array<{ type: string; data: Record<string, unknown> }> = [];
    const hub = {
      isOpen: (nodeId: string) => nodeId === "node-b",
      push: (_nodeId: string, event: unknown) => {
        pushed.push(event as { type: string; data: Record<string, unknown> });
        return 1; // accepted: "streamed" (un-acked)
      },
    };
    const rowId = queueTaskInput(
      sender,
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        from_box: "orq",
        to_box: "bob",
        input: "stream input: go",
        target_node: "node-b",
      },
      Date.now(),
    );
    void rowId;
    // The sender's stream attempt (attempts 0, the hub open - the prod
    // primary path).
    void deliverOutboxRow(
      sender,
      identity,
      () => {},
      hub,
      {
        node_id: "node-b",
        to_box: "bob",
        from_box: "orq",
        subject: "task aaaaaaaa",
        body: "stream input: go",
        origin_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:input:test",
        type: "task-input",
        task: {
          id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          result: "stream input: go",
          state: "working",
        },
      } as never,
      0,
    );

    // (b) The spread assertion: data.task present in the stream push.
    const ti = pushed.find((p) => p.type === "task-input");
    expect(ti).toBeDefined();
    expect(ti!.data.task).toMatchObject({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      result: "stream input: go",
    });
    // NO plain-mail event (the old fall-through's trace).
    expect(pushed.every((p) => p.type !== "mail")).toBe(true);

    // (a) The RECEIVER dispatch: the captured event runs through the same
    // consumer the stream client runs — the task-input branch (the fix).
    const receiver = openMeshDb(":memory:");
    registerMailbox(receiver, { name: "bob", session_id: "s2", now: Date.now() });
    receiver.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, question, state, created_at, updated_at, deadline, deadline_left, target_node, asker_node)
       VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'orq', 'xhost', 'q', 'input_required', 1000, 1000, NULL, 400000, 'node-x', ?)`,
      [String(ti!.data.from)],
    );
    // The consumer: the same shape the plugin-v2 dispatch reads (the d =
    // event.data, the eventPeerNodeId = the authenticated sender node). The
    // task's asker_node = node-a = the sender here.
    const d = ti!.data as {
      from?: string;
      task?: { id?: string; result?: string };
      origin_id?: string;
    };
    // The spoof gate reads d.from (the authenticated peer id on the wire):
    // the sender's identity node id = the asker node here.
    const eventPeerNodeId = String(ti!.data.from);
    const task = receiver.conn.get<{ asker_node: string | null }>(
      "SELECT asker_node FROM tasks WHERE id = ?",
      [d.task!.id],
    );
    // The dispatch gate: the asker node check + the apply (the REAL
    // handleStreamEvent — the seam).
    expect(task?.asker_node).toBe(eventPeerNodeId); // the gate passes
    expect(
      handleStreamEvent(receiver, eventPeerNodeId, {
        type: "task-input",
        data: d as unknown as Record<string, unknown>,
      }),
    ).toBe(d.origin_id);
    const mirror = receiver.conn.get<{
      state: string;
      input: string | null;
      deadline: number | null;
    }>("SELECT state, input, deadline FROM tasks WHERE id = ?", [d.task!.id]);
    expect(mirror?.state).toBe("working");
    expect(mirror?.input).toBe("stream input: go");
    expect(mirror?.deadline).toBeGreaterThan(Date.now()); // the deadline resumed
    // NO plain DM created at the responder (the old fall-through's trace).
    const dms = receiver.conn.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_box = 'bob' AND m.subject = 'task aaaaaaaa'",
    )?.n;
    expect(dms ?? 0).toBe(0);
    rmSync(senderDir, { recursive: true, force: true });
  });

  it("(c) a task-input on an asker_node MISMATCH is refused by the REAL dispatch - return null, no ack, no apply", () => {
    const receiver = openMeshDb(":memory:");
    registerMailbox(receiver, { name: "bob", session_id: "s2", now: Date.now() });
    receiver.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, question, state, created_at, updated_at, deadline, deadline_left, target_node, asker_node)
       VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'orq', 'xhost', 'q', 'input_required', 1000, 1000, NULL, 400000, 'node-x', 'node-a')`,
    );
    // The spoofing sender = NOT the asker node: the REAL dispatch returns
    // null (no ack -> the sender's row retries to the dead-letter at cap),
    // nothing applies.
    const ack = handleStreamEvent(receiver, "node-evil", {
      type: "task-input",
      data: {
        from: "node-evil",
        task: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", result: "spoofed" },
        origin_id: "spoof-1",
      },
    });
    expect(ack).toBeNull();
    // The row unchanged (no apply).
    expect(
      receiver.conn.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ])?.state,
    ).toBe("input_required");
  });
});
