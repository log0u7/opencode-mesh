import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateIdentity } from "../src/lib/identity.js";
import { openMeshDb } from "../src/lib/db.js";
import { claimOutboxDue, deliverOutboxRow, queueTaskAsk } from "../src/lib/outbox.js";
import { askTask, registerMailbox, unreadBoxCount, unreadMessages } from "../src/lib/mail.js";
import { pairWithToken } from "../src/lib/peers.js";
import { postTaskWire, sendMail } from "../src/lib/client.js";
import { startMeshServer } from "../src/lib/serve.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-bounce-"));
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

/** The pair: the SAME token on both rows, the addresses both ways, tls off. */
function pair(
  a: { db: ReturnType<typeof openMeshDb>; identity: { node_id: string }; url: string },
  b: { db: ReturnType<typeof openMeshDb>; identity: { node_id: string }; url: string },
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

async function drain(
  node: Parameters<typeof deliverOutboxRow>[0] extends never
    ? never
    : {
        db: ReturnType<typeof openMeshDb>;
        identity: ReturnType<typeof loadOrCreateIdentity>;
      },
) {
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
    if (err === null) node.db.conn.run("UPDATE outbox SET state='sent' WHERE id=?", [row.id]);
    else console.log("DBG drain err:", err);
  }
  return rows.length;
}

describe("the undeliverable-box bounce (the wrong-peer silent loss)", () => {
  it("a mail to a box the node does not own: the bounce crosses back to the sender's box", async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    const token = pair(a, b);
    registerMailbox(a.db, { name: "alice", session_id: "sa", now: Date.now() });
    // b owns NO 'ghost' box — the wrong-peer case (orq -> blogger via ricinus).

    const sent = await sendMail({
      url: b.url,
      token,
      from: a.identity.node_id,
      from_box: "alice",
      subject: "pour blogger",
      body: "salut",
      to: "ghost",
    });
    expect(sent).toBe("ok"); // the wire accepted; the BOUNCE is the receipt

    // The bounce is queued on b, addressed back to the sender's node+box.
    const bounceRow = b.db.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.subject') LIKE 'bounce:%'",
    )!;
    expect(bounceRow).toBeDefined();
    const p = JSON.parse(bounceRow.payload);
    expect(p.to_box).toBe("alice");
    expect(p.node_id).toBe(a.identity.node_id);
    expect(p.body).toContain("ghost");
    expect(p.body).toContain("n'existe pas");

    // The bounce crosses back: alice sees it, the truth is on the wire.
    expect(await drain(b)).toBe(1);
    // The bounce landed in alice's box: the DELIVERY is unread (the box
    // view), the agent sees it at the next drain.
    expect(unreadBoxCount(a.db, "alice")).toBe(1);
    const avis = a.db.conn.get<{ subject: string; body: string }>(
      "SELECT m.subject, m.body FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_box = 'alice'",
    )!;
    expect(avis.subject).toContain("bounce:");
    expect(avis.body).toContain("n'existe pas");
    a.server.close();
    b.server.close();
  });

  it("a task-ask to an unknown box: NO mirror, the bounce warns the asker", async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    const token = pair(a, b);
    registerMailbox(a.db, { name: "alice", session_id: "sa", now: Date.now() });

    // The asker queues the ask locally (the mesh_ask path) then the wire
    // carries it to the WRONG node (b does not own 'ghost').
    const task = askTask(a.db, { from_box: "alice", to_box: "ghost", question: "etat?" });
    queueTaskAsk(
      a.db,
      {
        id: task.id,
        from_box: "alice",
        to_box: "ghost",
        question: "etat?",
        group_id: null,
        deadline: null,
      },
      Date.now(),
    );
    await drain(a);
    const ok = await postTaskWire({
      url: b.url,
      token,
      from: a.identity.node_id,
      proof: "",
      payload: {
        node_id: b.identity.node_id,
        to_box: "ghost",
        from_box: "alice",
        subject: `task ${task.id.slice(0, 8)}`,
        body: "etat?",
        origin_id: task.id,
        type: "task-ask",
        task: {
          id: task.id,
          from_box: "alice",
          to_box: "ghost",
          question: "etat?",
          group_id: null,
          deadline: null,
        },
      } as never,
    });
    expect(ok).toBe("ok");

    // NO mirror on b (the task would never be seen there) + the bounce.
    expect(b.db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks")?.n).toBe(0);
    const bounceRow = b.db.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.subject') LIKE 'bounce:%'",
    )!;
    expect(bounceRow).toBeDefined();
    expect(JSON.parse(bounceRow.payload).body).toContain(task.id.slice(0, 8));

    // The bounce crosses back: alice sees the warning.
    expect(await drain(b)).toBe(1);
    expect(unreadBoxCount(a.db, "alice")).toBe(1);
    a.server.close();
    b.server.close();
  });

  it("a KNOWN box: no bounce, the normal flow unchanged", async () => {
    const a = await startNode("a");
    const b = await startNode("b");
    const token = pair(a, b);
    registerMailbox(a.db, { name: "alice", session_id: "sa", now: Date.now() });
    registerMailbox(b.db, { name: "bob", session_id: "sb", now: Date.now() });

    const sent = await sendMail({
      url: b.url,
      token,
      from: a.identity.node_id,
      from_box: "alice",
      subject: "pour bob",
      body: "salut",
      to: "bob",
    });
    expect(sent).toBe("ok");
    expect(
      b.db.conn.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload,'$.subject') LIKE 'bounce:%'",
      )?.n,
    ).toBe(0);
    expect(unreadBoxCount(b.db, "bob")).toBe(1);
    a.server.close();
    b.server.close();
  });
});
