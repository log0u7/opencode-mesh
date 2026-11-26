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
  it("ask node-a -> node-b, reply -> the asker's task completes, outbox sent, 0 dead-letter", async () => {
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

  it("the homonym box on BOTH sides: the reply still crosses (asker_node, not the name)", async () => {
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

  it("the stream that drops the event: attempt 2 falls back to POST and lands", async () => {
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

  it("the rebooted node re-pushes its registry: the peer converges without a drain", async () => {
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
