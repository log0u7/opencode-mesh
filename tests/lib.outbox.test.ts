import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMeshDb } from "../src/lib/db.js";
import { sendMail } from "../src/lib/client.js";
import { loadOrCreateIdentity, pairingProof } from "../src/lib/identity.js";
import { findSendablePeer, resolvePeerTarget } from "../src/lib/peers.js";
import { buildTlsMaterial } from "../src/lib/tls.js";
import { startMeshServer } from "../src/lib/serve.js";
import { pairWithToken } from "../src/lib/peers.js";
import {
  askTask,
  getTask,
  mergeFederatedRegistry,
  registerMailbox,
  replyTask,
} from "../src/lib/mail.js";
import {
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  claimOutboxDue,
  handleTaskAsk,
  markOutboxFailed,
  processOutbox,
  queueOutbox,
  queueTaskAsk,
  queueTaskReply,
  startOutboxSender,
  sweepOutbox,
  type OutboxPayload,
} from "../src/lib/outbox.js";

const payload = (over: Partial<OutboxPayload> = {}): OutboxPayload => ({
  node_id: "peer-1",
  to_box: "remote-box",
  from_box: "me",
  subject: "s",
  body: "b",
  origin_id: "origin-1",
  ...over,
});

describe("the outbox (refonte P2.6): queued, retried, effectively-once", () => {
  it("queueOutbox lands the row and claimOutboxDue claims it once (single-flight)", () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    queueOutbox(db, payload(), now);
    const claimed = claimOutboxDue(db, now + 1000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload.to_box).toBe("remote-box");
    // A second claim in the same window: nothing (the next_at was pushed).
    expect(claimOutboxDue(db, now + 1001)).toHaveLength(0);
    db.close();
  });

  it("processOutbox marks sent on a null error and failed on an error string", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    queueOutbox(db, payload({ origin_id: "o-ok" }), now);
    queueOutbox(db, payload({ origin_id: "o-fail", node_id: "peer-dead" }), now);
    const res = await processOutbox(db, now + 1000, async (p) =>
      p.node_id === "peer-dead" ? "unreachable" : null,
    );
    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    const states = db.conn
      .all<{ origin: string; state: string }>(
        "SELECT json_extract(payload, '$.origin_id') AS origin, state FROM outbox",
      )
      .reduce<Record<string, string>>((acc, r) => {
        acc[r.origin] = r.state;
        return acc;
      }, {});
    expect(states["o-ok"]).toBe("sent");
    expect(states["o-fail"]).toBe("queued"); // retried, not dead yet
    db.close();
  });

  it("the backoff doubles per attempt and caps; past MAX the row dead-letters", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    const row = queueOutbox(db, payload({ origin_id: "o-dead" }), now);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      claimOutboxDue(db, now + i * OUTBOX_BACKOFF_BASE_MS);
      markOutboxFailed(db, row.id, now + i * OUTBOX_BACKOFF_BASE_MS, "down");
    }
    const state = db.conn.get<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM outbox WHERE id = ?",
      [row.id],
    );
    expect(state?.state).toBe("failed");
    expect(state?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    db.close();
  });

  it("the backoff never exceeds the cap", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    const row = queueOutbox(db, payload(), now);
    for (let i = 0; i < 5; i += 1) {
      claimOutboxDue(db, now + i * OUTBOX_BACKOFF_BASE_MS);
      markOutboxFailed(db, row.id, now + i * OUTBOX_BACKOFF_BASE_MS, "down");
    }
    const nextAt = db.conn.get<{ next_at: number; attempts: number }>(
      "SELECT next_at, attempts FROM outbox WHERE id = ?",
      [row.id],
    );
    expect(nextAt?.attempts).toBe(5);
    // The backoff is measured from each ATTEMPT: the last failure was at
    // now + 4*BASE, the next retry at most the 10-min cap later.
    const lastFailureAt = now + 4 * OUTBOX_BACKOFF_BASE_MS;
    expect(nextAt!.next_at - lastFailureAt).toBeLessThanOrEqual(10 * 60 * 1000);
    db.close();
  });
});

describe("P2.5 (refonte): the cross-host tasks — the asker's node is the source of truth", () => {
  it("the round trip: ask crosses, the mirror replies, the reply applies back home", () => {
    // === L'ASKER (le node A): la row originale + l'ask via l'outbox ===
    const a = openMeshDb(":memory:");
    registerMailbox(a, { name: "alice", session_id: "s-a", now: 1000 });
    const fed = mergeFederatedRegistry(
      a,
      [
        {
          name: "bob-remote",
          session_id: "ses-b",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
        },
      ],
      "node-b",
    );
    void fed;
    const task = askTask(a, { from_box: "alice", to_box: "bob-remote", question: "quel etat?" });
    queueTaskAsk(a, task, Date.now());
    // La row originale + la row outbox task-ask.
    expect(getTask(a, task.id)?.state).toBe("submitted");
    const askRow = a.conn.get<{ payload: string; state: string }>(
      "SELECT payload, state FROM outbox WHERE json_extract(payload,'$.type') = 'task-ask'",
    )!;
    expect(askRow.state).toBe("queued");

    // === LE RESPONDANT (le node B): /task-ask cree le MIROIR (le meme id) ===
    const b = openMeshDb(":memory:");
    registerMailbox(b, { name: "bob-remote", session_id: "s-b", now: 1000 });
    const askPayload = JSON.parse(askRow.payload) as Parameters<typeof handleTaskAsk>[1];
    handleTaskAsk(b, { ...askPayload, from_box: "node-a/alice" });
    const mirror = getTask(b, task.id)!;
    expect(mirror.state).toBe("submitted");
    expect(mirror.from_box).toBe("node-a/alice");
    // Le message tache est dans la box du respondant.
    expect(
      b.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'bob-remote'")
        ?.n,
    ).toBe(1);

    // === LE RESPONDANT repond: le miroir passe completed, la reply REPART par l'outbox ===
    const rep = replyTask(b, task.id, "bob-remote", "build vert", "completed");
    expect(rep.ok).toBe(true);
    expect(rep.cross).toBe(true);
    // La couche tools (mesh_reply) queue le cross-reply a la frontiere.
    queueTaskReply(b, task.id, "build vert", "completed", Date.now());
    const replyRow = b.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.type') = 'task-reply'",
    )!;
    const replyPayload = JSON.parse(replyRow.payload);
    expect(replyPayload.node_id).toBe("node-a");
    expect(replyPayload.task.state).toBe("completed");

    // === L'ASKER applique la reply (le /task-reply): la row originale + la notification ===
    const applied = replyTask(
      a,
      task.id,
      task.to_box,
      replyPayload.task.result,
      replyPayload.task.state,
    );
    expect(applied.ok).toBe(true);
    expect(applied.notified).toBe(true);
    expect(getTask(a, task.id)?.state).toBe("completed");
    const got = a.conn.get<{ body: string }>(
      "SELECT m.body FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'alice'",
    )!;
    expect(got.body).toContain("build vert");
    a.close();
    b.close();
  });
});

describe("the outbox sender (refonte P2.6): stream-first + the retries", () => {
  it("startOutboxSender: an open stream gets the push and the row marks sent", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    const pushed: unknown[] = [];
    const hub = {
      isOpen: (id: string) => id === "peer-1",
      push: (id: string, event: unknown) => {
        pushed.push(event);
        return 1;
      },
    };
    const sender = startOutboxSender(db, { node_id: "node-me" } as never, () => {}, 20, hub);
    queueOutbox(db, payload({ origin_id: "o-stream" }), now);
    await new Promise((r) => setTimeout(r, 120));
    sender.stop();
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    const state = db.conn.get<{ state: string }>("SELECT state FROM outbox")!;
    expect(state.state).toBe("sent");
    db.close();
  });

  it("startOutboxSender without a hub: the POST fallback path runs (no row for an unreachable peer)", async () => {
    const db = openMeshDb(":memory:");
    const now = Date.now();
    const sender = startOutboxSender(db, { node_id: "node-me" } as never, () => {}, 20);
    queueOutbox(db, payload({ origin_id: "o-nostream", node_id: "ghost-node" }), now);
    await new Promise((r) => setTimeout(r, 150));
    sender.stop();
    // Unreachable: attempts grew (the backoff), the row stays queued.
    const row = db.conn.get<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM outbox",
    )!;
    expect(row.state).toBe("queued");
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe("P2.5 (refonte): the task-reply cross path — queueTaskReply parses the node", () => {
  it("the asker's remote reference node/box drives the delivery", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "bob-remote", session_id: "s-b", now: 1000 });
    // Le miroir: from_box = le composite node/box (le /task-ask l'ecrit).
    const now = Date.now();
    db.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, group_id, question, result, state, created_at, updated_at, deadline)
       VALUES ('task-x', 'node-a/alice', 'bob-remote', NULL, 'q', NULL, 'submitted', ?, ?, NULL)`,
      [now, now],
    );
    const id = queueTaskReply(db, "task-x", "reponse", "completed", now);
    expect(id).not.toBeNull();
    const row = db.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.type') = 'task-reply'",
    )!;
    const p = JSON.parse(row.payload);
    expect(p.node_id).toBe("node-a");
    expect(p.to_box).toBe("alice");
    expect(p.task.state).toBe("completed");
    db.close();
  });

  it("queueTaskReply on a LOCAL task returns null (the notification is local)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const t = askTask(db, { from_box: "alice", to_box: "bob", question: "q" });
    // replyTask local: la notification part directement — queueTaskReply ne
    // double pas.
    expect(queueTaskReply(db, t.id, "x", "completed", Date.now())).toBeNull();
    db.close();
  });
});

describe("the outbox sender: the REAL wire delivery (the POST path)", () => {
  it("a manual sweep delivers the queued row through a REAL paired TLS server", {
    timeout: 10_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-real-"));
    // A: le recepteur (le serveur TLS + la box alice).
    const dbA = openMeshDb(join(dir, "a.db"));
    registerMailbox(dbA, { name: "alice", session_id: "s-a", now: 1000 });
    const identityA = loadOrCreateIdentity(join(dir, "id-a"));
    const tlsA = buildTlsMaterial(identityA);
    const { server, port } = await startMeshServer({
      db: dbA,
      port: 0,
      tls: true,
      tlsMaterial: tlsA,
      self: { node_id: identityA.node_id, pk: identityA.public_key, hostname: "a" },
    });
    // B: le demandeur — le pairing mutuel (l'auth du wire).
    const dbB = openMeshDb(join(dir, "b.db"));
    const identityB = loadOrCreateIdentity(join(dir, "id-b"));
    pairWithToken(dbB, {
      node_id: identityA.node_id,
      hostname: "a",
      fingerprint: "ff00",
      token: "tok-a",
      public_key: identityA.public_key,
      addresses: [`127.0.0.1:${port}`],
    });
    pairWithToken(dbA, {
      node_id: identityB.node_id,
      hostname: "b",
      fingerprint: "ff00",
      token: "tok-a",
      public_key: identityB.public_key,
    });
    queueOutbox(
      dbB,
      payload({ origin_id: "o-real", node_id: identityA.node_id, to_box: "alice" }),
      Date.now(),
    );
    // UN sweep deterministe (le sender arriere-plan = le meme processOutbox).
    const res = await processOutbox(dbB, Date.now(), async (p) => {
      const target = findSendablePeer(dbB, p.node_id);
      if (!target) return "no paired peer";
      const conn = resolvePeerTarget(dbB, p.node_id);
      if (!conn) return "no known address";
      const sent = await sendMail({
        url: conn.url,
        ...(conn.tls ? { tls: true } : {}),
        ...(conn.pk !== null ? { pk: conn.pk } : {}),
        token: target.token ?? "",
        from: identityB.node_id,
        subject: p.subject,
        body: p.body,
        proof: pairingProof(identityB, target.token ?? ""),
        ...(p.to_box ? { to: p.to_box } : {}),
        ...(p.from_box ? { from_box: p.from_box } : {}),
        origin_id: p.origin_id,
      });
      return sent === "ok" ? null : sent;
    });
    expect(res.sent).toBe(1);
    expect(dbB.conn.get<{ state: string }>("SELECT state FROM outbox")!.state).toBe("sent");
    // Le mail atterrit dans la box alice chez A.
    expect(
      dbA.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'alice'")?.n,
    ).toBe(1);
    server.close();
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the outbox sender: the POST path (no hub)", () => {
  it("the sender delivers via the wire POST when no stream is open", {
    timeout: 10_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-post-"));
    const dbA = openMeshDb(join(dir, "a.db"));
    registerMailbox(dbA, { name: "alice", session_id: "s-a", now: 1000 });
    const identityA = loadOrCreateIdentity(join(dir, "id-a"));
    const tlsA = buildTlsMaterial(identityA);
    const { server, port } = await startMeshServer({
      db: dbA,
      port: 0,
      tls: true,
      tlsMaterial: tlsA,
      self: { node_id: identityA.node_id, pk: identityA.public_key, hostname: "a" },
    });
    const dbB = openMeshDb(join(dir, "b.db"));
    const identityB = loadOrCreateIdentity(join(dir, "id-b"));
    pairWithToken(dbB, {
      node_id: identityA.node_id,
      hostname: "a",
      fingerprint: "ff00",
      token: "tok-a",
      public_key: identityA.public_key,
      addresses: [`127.0.0.1:${port}`],
    });
    pairWithToken(dbA, {
      node_id: identityB.node_id,
      hostname: "b",
      fingerprint: "ff00",
      token: "tok-a",
      public_key: identityB.public_key,
    });
    // PAS de hub: le sender prend le chemin POST (le wire).
    const sender = startOutboxSender(dbB, identityB, () => {}, 20);
    queueOutbox(
      dbB,
      payload({ origin_id: "o-post", node_id: identityA.node_id, to_box: "alice" }),
      Date.now(),
    );
    let landed = false;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const n = dbA.conn.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'alice'",
      )?.n;
      if (n === 1) {
        landed = true;
        break;
      }
    }
    sender.stop();
    server.close();
    expect(landed).toBe(true);
    expect(dbB.conn.get<{ state: string }>("SELECT state FROM outbox")!.state).toBe("sent");
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P2.5 the cross-host round trip VIA THE LAZY SWEEP (the mr-review finding 1)", () => {
  it("the reply crosses back through /task-reply and the asker's task completes", {
    timeout: 15_000,
  }, async () => {
    // === LE NODE A (l'asker): la row originale + l'ask queue ===
    const dirA = mkdtempSync(join(tmpdir(), "task-a-"));
    const dbA = openMeshDb(join(dirA, "mesh.db"));
    registerMailbox(dbA, { name: "alice", session_id: "s-a", now: 1000 });
    const identityA = loadOrCreateIdentity(join(dirA, "id-a"));
    const tlsA = buildTlsMaterial(identityA);
    const { server: serverA, port: portA } = await startMeshServer({
      db: dbA,
      port: 0,
      tls: true,
      tlsMaterial: tlsA,
      self: { node_id: identityA.node_id, pk: identityA.public_key, hostname: "a" },
    });
    // === LE NODE B (le respondant): la box + le pairing mutuel ===
    const dirB = mkdtempSync(join(tmpdir(), "task-b-"));
    const dbB = openMeshDb(join(dirB, "mesh.db"));
    registerMailbox(dbB, { name: "bob", session_id: "s-b", now: 1000 });
    const identityB = loadOrCreateIdentity(join(dirB, "id-b"));
    const tlsB = buildTlsMaterial(identityB);
    const { server: serverB, port: portB } = await startMeshServer({
      db: dbB,
      port: 0,
      tls: true,
      tlsMaterial: tlsB,
      self: { node_id: identityB.node_id, pk: identityB.public_key, hostname: "b" },
    });
    // Les pairings mutuels (les tokens + les pks).
    pairWithToken(dbA, {
      node_id: identityB.node_id,
      hostname: "b",
      fingerprint: "ff00",
      token: "tok-shared",
      public_key: identityB.public_key,
      addresses: [`127.0.0.1:${portB}`],
    });
    pairWithToken(dbB, {
      node_id: identityA.node_id,
      hostname: "a",
      fingerprint: "ff00",
      token: "tok-shared",
      public_key: identityA.public_key,
      addresses: [`127.0.0.1:${portA}`],
    });
    // L'asker: la row task vers la box FEDEREE bob (le nom vue depuis A).
    mergeFederatedRegistry(
      dbA,
      [
        {
          name: "bob",
          session_id: "ses-b",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
          epoch: 2,
        },
      ],
      identityB.node_id,
    );
    const task = askTask(dbA, { from_box: "alice", to_box: "bob", question: "quel etat?" });
    queueTaskAsk(dbA, task, Date.now());

    // === LE NODE B: /task-ask (le handler) cree le miroir ===
    // Le payload: le from_box composite node-a/alice (le serveur l'ecrit).
    handleTaskAsk(dbB, {
      node_id: identityA.node_id,
      to_box: "bob",
      from_box: `${identityA.node_id}/alice`,
      subject: `task ${task.id.slice(0, 8)}`,
      body: "quel etat?",
      origin_id: task.id,
      type: "task-ask",
      task: {
        id: task.id,
        from_box: `${identityA.node_id}/alice`,
        to_box: "bob",
        question: "quel etat?",
        group_id: null,
        deadline: null,
      },
    });
    expect(getTask(dbB, task.id)?.state).toBe("submitted");

    // === LE RESPONDANT repond: le miroir completed + la reply queue par le SWEEP PARESSEUX ===
    const rep = replyTask(dbB, task.id, "bob", "build vert", "completed");
    expect(rep.cross).toBe(true);
    queueTaskReply(dbB, task.id, "build vert", "completed", Date.now());
    // Le sweep PARESSEUX de B: la task-reply part par /task-reply (le routage).
    const identityForSweep = identityB;
    await sweepOutbox(dbB, identityForSweep, () => {});

    // === L'ASKER: la row originale completed + la notification alice ===
    // L'etat FINAL de la tache originale: le poll (le sweep + le POST + la
    // notification peuvent prendre quelques secondes sous la charge).
    let taskState = "";
    for (let i = 0; i < 60; i += 1) {
      taskState = getTask(dbA, task.id)?.state ?? "";
      if (taskState === "completed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(taskState).toBe("completed");
    const got = dbA.conn.get<{ body: string }>(
      "SELECT m.body FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.to_box = 'alice'",
    )!;
    expect(got.body).toContain("build vert");
    serverA.close();
    serverB.close();
    dbA.close();
    dbB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});

describe("P2.5 the cross-host ASK VIA THE REAL WIRE (the mr-review finding: the POST shape)", () => {
  it("the ask rides postTaskWire -> /task-ask -> the mirror carries node/box", {
    timeout: 15_000,
  }, async () => {
    // === LE NODE B (le respondant): le serveur TLS + la box bob ===
    const dirB = mkdtempSync(join(tmpdir(), "ask-b-"));
    const dbB = openMeshDb(join(dirB, "mesh.db"));
    registerMailbox(dbB, { name: "bob", session_id: "s-b", now: 1000 });
    const identityB = loadOrCreateIdentity(join(dirB, "id-b"));
    const tlsB = buildTlsMaterial(identityB);
    const { server: serverB, port: portB } = await startMeshServer({
      db: dbB,
      port: 0,
      tls: true,
      tlsMaterial: tlsB,
      self: { node_id: identityB.node_id, pk: identityB.public_key, hostname: "b" },
    });
    // === LE NODE A (l'asker): la row + le pairing + l'ask queue ===
    const dirA = mkdtempSync(join(tmpdir(), "ask-a-"));
    const dbA = openMeshDb(join(dirA, "mesh.db"));
    registerMailbox(dbA, { name: "alice", session_id: "s-a", now: 1000 });
    const identityA = loadOrCreateIdentity(join(dirA, "id-a"));
    // Les pairings mutuels (le meme token, les pks croises).
    pairWithToken(dbA, {
      node_id: identityB.node_id,
      hostname: "b",
      fingerprint: "ff00",
      token: "tok-shared",
      public_key: identityB.public_key,
      addresses: [`127.0.0.1:${portB}`],
    });
    pairWithToken(dbB, {
      node_id: identityA.node_id,
      hostname: "a",
      fingerprint: "ff00",
      token: "tok-shared",
      public_key: identityA.public_key,
    });
    // La box bob = FEDEREE vue depuis A (l'epoch 2).
    mergeFederatedRegistry(
      dbA,
      [
        {
          name: "bob",
          session_id: "ses-b",
          role: "ops",
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
          epoch: 2,
        },
      ],
      identityB.node_id,
    );
    const task = askTask(dbA, { from_box: "alice", to_box: "bob", question: "quel etat?" });
    queueTaskAsk(dbA, task, Date.now());
    // LE SWEEP: postTaskWire -> POST /task-ask sur B (le vrai wire, le trou
    // du from_box cache etait ici: le test direct handleTaskAsk ne le
    // voyait pas).
    await sweepOutbox(dbA, identityA, () => {});
    // Le miroir chez B: from_box = node-a/alice (le composite COMPLET).
    const mirror = dbB.conn.get<{ state: string; from_box: string }>(
      "SELECT state, from_box FROM tasks WHERE id = ?",
      [task.id],
    )!;
    expect(mirror.state).toBe("submitted");
    expect(mirror.from_box).toBe(`${identityA.node_id}/alice`);
    // Le message tache dans la box bob.
    expect(
      dbB.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'bob'")?.n,
    ).toBe(1);
    serverB.close();
    dbA.close();
    dbB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});

describe("3.2 (refonte): the task-reply routing prefers the EXPLICIT node (the name-collision safe)", () => {
  it("the reply routes to the composite node even when a federated row shares the bare box name", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "bob-remote", session_id: "s-b", now: 1000 });
    // DEUX rows federated pour le meme nom "alice" venu de nodes differents:
    // la collision que le fix doit tuer — la resolution par NOM choisirait
    // un match arbitraire; l'explicite node_id gagne.
    mergeFederatedRegistry(
      db,
      [
        {
          name: "alice",
          session_id: "ses-a",
          role: null,
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 2000,
          epoch: 2,
        },
      ],
      "node-wrong",
    );
    mergeFederatedRegistry(
      db,
      [
        {
          name: "alice",
          session_id: "ses-a2",
          role: null,
          pools: "[]",
          primary_pool: null,
          registered_at: Date.now() - 1000,
          epoch: 3,
        },
      ],
      "node-right",
    );
    // Le miroir: from_box = le composite node-right/alice.
    const now = Date.now();
    db.conn.run(
      `INSERT INTO tasks (id, from_box, to_box, question, state, created_at, updated_at)
       VALUES ('task-c', 'node-right/alice', 'bob-remote', 'q', 'submitted', ?, ?)`,
      [now, now],
    );
    queueTaskReply(db, "task-c", "reponse", "completed", now);
    const row = db.conn.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE json_extract(payload,'$.type') = 'task-reply'",
    )!;
    const p = JSON.parse(row.payload);
    expect(p.node_id).toBe("node-right");
    expect(p.to_box).toBe("alice");
    db.close();
  });
});
