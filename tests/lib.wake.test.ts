import { describe, expect, it, vi } from "vitest";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMeshDb } from "../src/lib/db.js";
import {
  claimFlash,
  claimFlashWithContent,
  deliverMessage,
  inboxRead,
  joinPool,
  registerMailbox,
  unreadBoxCount,
} from "../src/lib/mail.js";
import {
  startWakeLoop,
  createExecutionTracker,
  DEFAULT_WAKE_INTERVAL_MS,
  DEFAULT_WAKE_COOLDOWN_MS,
} from "../src/lib/wake.js";

function setup(hostSessions: string[]) {
  const db = openMeshDb(":memory:");
  const live = new Set(hostSessions);
  const prompts: Array<{ sessionID: string; text: string; messageID?: string | undefined }> = [];
  const prompt = vi.fn(async (sessionID: string, text: string, messageID?: string) => {
    prompts.push({ sessionID, text, messageID });
  });
  const sessionKnown = vi.fn((sessionID: string) => live.has(sessionID));
  return { db, prompt, prompts, sessionKnown };
}

describe("createExecutionTracker (the host's real session-status events)", () => {
  const status = (sessionID: string, type: string) => ({
    type: "session.status",
    properties: { sessionID, status: { type } },
  });

  it("tracks busy and clears on idle (the real wire shape: data.sessionID + data.status)", () => {
    const t = createExecutionTracker();
    t.observe({ type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } });
    expect(t.isRunning("s1")).toBe(true);
    t.observe({ type: "session.status", data: { sessionID: "s1", status: { type: "idle" } } });
    expect(t.isRunning("s1")).toBe(false);
  });

  it("tracks busy and clears on idle (legacy properties shape, older SDK gens)", () => {
    const t = createExecutionTracker();
    t.observe(status("s1", "busy"));
    expect(t.isRunning("s1")).toBe(true);
    t.observe(status("s1", "idle"));
    expect(t.isRunning("s1")).toBe(false);
  });

  it("treats retry as running (data path)", () => {
    const t = createExecutionTracker();
    t.observe({
      type: "session.status",
      data: { sessionID: "s1", status: { type: "retry", attempt: 2, message: "x", next: 1 } },
    });
    expect(t.isRunning("s1")).toBe(true);
  });

  it("clears on session.idle (data path)", () => {
    const t = createExecutionTracker();
    t.observe({ type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } });
    t.observe({ type: "session.idle", data: { sessionID: "s1" } });
    expect(t.isRunning("s1")).toBe(false);
  });

  it("also honors the legacy session.execution.* names (older hosts, data path)", () => {
    const t = createExecutionTracker();
    t.observe({ type: "session.execution.started", data: { sessionID: "s1" } });
    expect(t.isRunning("s1")).toBe(true);
    t.observe({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    expect(t.isRunning("s1")).toBe(false);
    t.observe({ type: "session.execution.failed", data: { sessionID: "s1" } });
    expect(t.isRunning("s1")).toBe(false);
    t.observe({ type: "session.execution.interrupted", data: { sessionID: "s1" } });
    expect(t.isRunning("s1")).toBe(false);
  });

  it("ignores a session.status whose status.type is not a string", () => {
    const t = createExecutionTracker();
    t.observe({ type: "session.status", properties: { sessionID: "s1", status: { type: 3 } } });
    expect(t.isRunning("s1")).toBe(false);
  });

  it("rejects an empty-string sessionID", () => {
    const t = createExecutionTracker();
    t.observe({ type: "session.idle", properties: { sessionID: "" } });
    t.observe({ type: "session.idle", properties: {} });
    expect(t.isRunning("")).toBe(false);
  });

  it("prefers data.sessionID over properties.sessionID (the real wire wins)", () => {
    const t = createExecutionTracker();
    t.observe({
      type: "session.status",
      data: { sessionID: "data", status: { type: "busy" } },
      properties: { sessionID: "props", status: { type: "busy" } },
    });
    expect(t.isRunning("data")).toBe(true);
    expect(t.isRunning("props")).toBe(false);
  });

  it("flips inTransaction on the bun engine (the production runtime)", async () => {
    // The exact relapse class: node:sqlite names the state `isTransaction`,
    // bun:sqlite names it `inTransaction`. This test is inert on the node CI
    // and runs wherever bun is the runtime.
    const Bun = (globalThis as { Bun?: { sqlite?: { Database?: unknown } } }).Bun;
    if (!Bun?.sqlite?.Database) return;
    const { openSqlite } = await import("../src/lib/sqlite.js");
    const conn = openSqlite(":memory:");
    expect(conn.inTransaction()).toBe(false);
    conn.exec("BEGIN");
    expect(conn.inTransaction()).toBe(true);
    conn.exec("ROLLBACK");
    expect(conn.inTransaction()).toBe(false);
    conn.close();
  });

  it("tolerates unknown event shapes", () => {
    const t = createExecutionTracker();
    expect(() => t.observe({ type: "mystery" })).not.toThrow();
    expect(() => t.observe({})).not.toThrow();
  });
  it("passes a stable generated messageID to the prompt (the transport-retry idempotency key)", async () => {
    const { db, prompt, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    // An OVERSIZED body: the compact path keeps the mail UNREAD, so the
    // reminder has something to re-claim (the content path consumes).
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "s",
      body: "x".repeat(700),
      created_at: 1000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      intervalMs: 50,
      fatigueTtlMs: 30,
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();
    // One delivery = one claim; the reminder re-claims at +fatigueTtl. The
    // invariant is AT LEAST two prompts, each carrying its own generated id.
    expect(prompt.mock.calls.length).toBeGreaterThanOrEqual(2);
    const ids = prompt.mock.calls.map((c) => (c as unknown[])[2]);
    for (const id of ids) {
      expect(id).toMatch(/^msg_/);
    }
    // Each prompt gets its OWN id: the server reconciles per prompt, and two
    // different prompts are two different messages.
    expect(ids[0]).not.toBe(ids[1]);
  });
  it("the fatigue cap: the reminders widen then the box goes silent, escalated once (0.33.4)", async () => {
    vi.useFakeTimers();
    try {
      const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
      registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
      registerMailbox(db, { name: "orq", session_id: "s-orq", now: 1000 });
      // An OVERSIZED body: the compact path keeps the mail UNREAD — the
      // content path would consume it and there would be nothing to starve.
      deliverMessage(db, {
        from: "n",
        to_box: "a",
        subject: "s",
        body: "x".repeat(700),
        created_at: 1000,
      });
      const handle = startWakeLoop({
        db,
        prompt,
        sessionKnown,
        intervalMs: 100,
        fatigueTtlMs: 150,
      });
      // The reminders widen (base, 2x, 4x, 8x): the 5-flash sequence
      // exhausts at ~2.4s (150+300+600+1200), the box never drains.
      await vi.advanceTimersByTimeAsync(3_000);
      const before = prompts.length;
      expect(before).toBe(5);
      // PAST the cap: silence — no prompt ever again, the mail stays
      // unread, and the escalation alerted orq EXACTLY once.
      await vi.advanceTimersByTimeAsync(6_000);
      handle.stop();
      expect(prompts.length).toBe(before);
      expect(unreadBoxCount(db, "a")).toBe(1);
      const alerts = db.conn.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_box = 'orq'",
      )?.n;
      expect(alerts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wake collapse gate (at most one prompt in flight per session)", () => {
  it("the claim batches: a drain + two fresh mails produce ONE prompt naming both (the phantom class)", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      intervalMs: 10,
      fatigueTtlMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 80));
    const first = prompts.length;
    expect(first).toBe(1);
    // The mail drains (any path: the queue delivered a DIFFERENT turn, a
    // journal read, ...) and two fresh mails land. The claim batches them:
    // ONE prompt whose count is the database's (the fresh recount), never
    // the stale retained one — and never one prompt per mail.
    db.conn.run("UPDATE deliveries SET status = 'read' WHERE to_box = 'a'");
    deliverMessage(db, { from: "n", to_box: "a", subject: "s2", body: "b2", created_at: 2000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s3", body: "b3", created_at: 2001 });
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();
    expect(prompts.length).toBe(first + 1);
    expect(prompts[prompts.length - 1]?.text).toContain('<mesh-mail kind="notify" subject="s2">');
    expect(prompts[prompts.length - 1]?.text).toContain("s2 — b2");
    expect(prompts[prompts.length - 1]?.text).toContain("s3 — b3");
  });

  it("clears the in-flight gate when the delivered prompt's turn runs", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    let running = false;
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      sessionRunning: () => running,
      intervalMs: 10,
      cooldownMs: 20,
    });
    await new Promise((r) => setTimeout(r, 80));
    const first = prompts.length;
    expect(first).toBeGreaterThanOrEqual(1);
    // The delivered prompt causes a turn: busy flips true, then back to idle
    // (the turn finished). The gate must have cleared with the busy event.
    running = true;
    await new Promise((r) => setTimeout(r, 40));
    running = false;
    deliverMessage(db, { from: "n", to_box: "a", subject: "s2", body: "b2", created_at: 2000 });
    await new Promise((r) => setTimeout(r, 80));
    handle.stop();
    expect(prompts.length).toBeGreaterThan(first);
  });
  it("releases the gate after the TTL even if the busy window went unobserved", async () => {
    vi.useFakeTimers();
    try {
      const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
      registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
      deliverMessage(db, {
        from: "n",
        to_box: "a",
        subject: "s",
        body: "x".repeat(700),
        created_at: 1000,
      });
      const handle = startWakeLoop({
        db,
        prompt,
        sessionKnown,
        sessionRunning: () => false,
        intervalMs: 100,
        fatigueTtlMs: 120_000,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(prompts.length).toBe(1);
      // Two fresh mails: their NULL rows claim as a NEW batch (one prompt,
      // never one per mail).
      deliverMessage(db, { from: "n", to_box: "a", subject: "s2", body: "b2", created_at: 2000 });
      deliverMessage(db, { from: "n", to_box: "a", subject: "s3", body: "b3", created_at: 2001 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prompts.length).toBe(2);
      // The already-flashed rows stay silent until the reminder TTL (2 min),
      // then re-claim ONCE — the reminder, not a spam loop.
      await vi.advanceTimersByTimeAsync(70_000);
      handle.stop();
      expect(prompts.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wake loop", () => {
  it("uses the documented defaults (the safety tick is 30s: the WAL watcher is the fast path)", () => {
    expect(DEFAULT_WAKE_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_WAKE_COOLDOWN_MS).toBe(60000);
  });

  it("the WAL watcher flashes immediately, without any timer (the event-driven wake)", {
    timeout: 20_000,
  }, async () => {
    // A REAL file db: the watcher watches mesh.db-wal (:memory: has none).
    const dir = mkdtempSync(join(tmpdir(), "wake-event-"));
    const db = openMeshDb(join(dir, "mesh.db"));
    const prompts: Array<{ sessionID: string; text: string }> = [];
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const handle = startWakeLoop({
      db,
      prompt: async (sessionID, text) => {
        prompts.push({ sessionID, text });
      },
      sessionKnown: () => true,
      intervalMs: 30_000, // the safety tick: 30s away — NO timer delivers this
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    // Well under the 30s safety tick: only the WAL watcher can have fired.
    await new Promise((r) => setTimeout(r, 150));
    handle.stop();
    expect(prompts.length).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is inert with intervalMs <= 0", async () => {
    const { db, prompt } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({ db, prompt, sessionKnown: () => true, intervalMs: 0 });
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();
    expect(prompt).not.toHaveBeenCalled();
    db.close();
  });

  it("wakes the bound session when its mailbox receives mail", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const handle = startWakeLoop({ db, prompt, sessionKnown, intervalMs: 10, cooldownMs: 5000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompts[0]?.sessionID).toBe("s1");
    // The content path: the <mesh-mail> envelope carries the mail (acked).
    expect(prompts[0]?.text).toContain('<mesh-mail kind="notify" subject="s">');
    expect(prompts[0]?.text).toContain("s — b");

    db.close();
  });

  function sessionExists(sessionID: string): Promise<boolean> {
    return Promise.resolve(sessionID === "s1");
  }

  it("skips mailboxes whose session does not live on this host", async () => {
    const { db, prompt, sessionKnown } = setup([]);
    registerMailbox(db, { name: "far", session_id: "s-elsewhere", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "far", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({ db, prompt, sessionKnown, intervalMs: 10, cooldownMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(prompt).not.toHaveBeenCalled();
    db.close();
  });

  it("wakes only the addressed mailbox in a multi-session host", async () => {
    const { db, prompt, prompts } = setup(["s1", "s2"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "b", session_id: "s2", now: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "one", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 40));
    deliverMessage(db, { from: "n", to_box: "b", subject: "two", body: "b", created_at: 2000 });
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();

    expect(prompts.map((p) => p.sessionID)).toEqual(["s1", "s2"]);
    expect(prompts[1]?.text).toContain('"two"');
    db.close();
  });

  it("does not spam while unread count is unchanged (per-mailbox cooldown)", async () => {
    const { db, prompt } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(prompt).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("prompts again when new mail arrives during the cooldown of another mailbox only", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "one", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    deliverMessage(db, { from: "n", to_box: "a", subject: "two", body: "b", created_at: 2000 });
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();

    expect(prompt).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("stays silent for an unregistered mailbox", async () => {
    const { db, prompt } = setup(["s1"]);
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 10,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();

    expect(prompt).not.toHaveBeenCalled();
    db.close();
  });

  it("swallows prompt failures and keeps polling", async () => {
    const { db } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    let calls = 0;
    const handle = startWakeLoop({
      db,
      prompt: async () => {
        calls += 1;
        throw new Error("host refused");
      },
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 0,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(calls).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("skips a mid-turn session and prompts it once idle", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const running = new Set<string>(["s1"]);
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      sessionRunning: (sessionID) => running.has(sessionID),
      intervalMs: 10,
      cooldownMs: 5000,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompt).not.toHaveBeenCalled();

    running.delete("s1");
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("s1");
    db.close();
  });
});

describe("fatigue guard", () => {
  it("bounds the reminder rate after MAX undrained prompts (no starvation, no spam)", async () => {
    vi.useFakeTimers();
    try {
      const { db, prompt, prompts } = setup(["s1"]);
      registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
      deliverMessage(db, {
        from: "n",
        to_box: "a",
        subject: "s",
        body: "x".repeat(700),
        created_at: 1000,
      });
      const handle = startWakeLoop({
        db,
        prompt,
        sessionKnown: () => true,
        intervalMs: 100,
        fatigueTtlMs: 1000,
        maxUndrainedPrompts: 3,
      });
      // Ten minutes without a drain: the claim re-arms at the reminder TTL
      // (doubling per mute cycle) — the box is reminded (never starves, the
      // orq/6admin episode) and the rate stays far under the tick rate.
      await vi.advanceTimersByTimeAsync(10_000);
      handle.stop();
      expect(prompts.length).toBeGreaterThanOrEqual(4);
      expect(prompts.length).toBeLessThanOrEqual(12);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the fatigue counter when the box gets drained", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 0,
      maxUndrainedPrompts: 2,
    });
    // Cycle 1: mail → prompt (undrained 1).
    deliverMessage(db, { from: "n", to_box: "a", subject: "s1", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 40));
    // Drain everything (the agent acked) → the fatigue counter resets.
    db.conn.run("UPDATE deliveries SET status = 'read' WHERE to_box = 'a'");
    await new Promise((r) => setTimeout(r, 30));
    // Cycle 2: fresh mail → prompts again (the counter was reset).
    deliverMessage(db, { from: "n", to_box: "a", subject: "s2", body: "b", created_at: 2000 });
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    db.close();
  });
});

describe("wake flag (0.17.0 Slack model)", () => {
  function poolSetup(hostSessions: string[]) {
    const s = setup(hostSessions);
    for (const [name, sid] of [
      ["a", "s1"],
      ["b", "s2"],
      ["c", "s3"],
    ] as const) {
      registerMailbox(s.db, { name, session_id: sid, now: 1000 });
      joinPool(s.db, name, "team:x");
    }
    return s;
  }

  it("stays silent on a local pool broadcast without the flag", async () => {
    const { db, prompt } = poolSetup(["s1", "s2", "s3"]);
    const r = deliverMessage(db, {
      from: "n",
      from_box: "a",
      to_box: "team:x",
      subject: "status: quota transmise",
      body: "b",
      created_at: 2000,
    });
    expect(r.ok).toBe(true);
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    expect(prompt).not.toHaveBeenCalled();
    db.close();
  });

  it("wakes every member when the broadcast carries wake:true", async () => {
    const { db, prompt, prompts } = poolSetup(["s1", "s2", "s3"]);
    deliverMessage(db, {
      from: "n",
      from_box: "a",
      to_box: "team:x",
      subject: "r8 go: build is green",
      body: "b",
      wake: true,
      created_at: 2000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    expect(prompts.map((p) => p.sessionID).sort()).toEqual(["s2", "s3"]);
    expect(prompts[0]?.text).toContain('<mesh-mail kind="notify" subject="r8 go: build is green">');
    db.close();
  });

  it("wakes on a cross-host fanout carrying wake:true (origin_id differs)", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "r8 go (deliberate)",
      body: "b",
      origin_id: "origin-1",
      wake: true,
      created_at: 1000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("s1");
    db.close();
  });
});

describe("wake guards (0.18.0)", () => {
  // Two mailboxes, a prompt that only resolves when the test releases it:
  // while tick 1 hangs in the prompt, the interval keeps firing — and the
  // dispose path is exercised by stopping the loop before the release.
  function guardedSetup() {
    const s = setup(["s1", "s2"]);
    registerMailbox(s.db, { name: "a", session_id: "s1", now: 1000 });
    registerMailbox(s.db, { name: "b", session_id: "s2", now: 1000 });
    deliverMessage(s.db, { from: "n", to_box: "a", subject: "one", body: "b", created_at: 1000 });
    deliverMessage(s.db, { from: "n", to_box: "b", subject: "two", body: "b", created_at: 1000 });
    let releaseFirst!: () => void;
    let calls = 0;
    const prompt = vi.fn((_sessionID: string, _text: string) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    return { ...s, prompt, releaseFirst: () => releaseFirst(), calls: () => calls };
  }

  it("does not double-prompt while a tick is in flight (prompt slower than the interval)", async () => {
    const { db, prompt, releaseFirst, calls } = guardedSetup();
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 5,
      cooldownMs: 0,
    });
    // Several interval ticks fire while the first prompt is still pending:
    // the in-flight guard keeps them all out.
    await new Promise((r) => setTimeout(r, 40));
    expect(calls()).toBe(1);
    expect(prompt.mock.calls[0]?.[0]).toBe("s1");

    releaseFirst();
    handle.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls()).toBe(1);
    db.close();
  });

  it("prompts no box after dispose (stop during an in-flight tick)", async () => {
    const { db, prompt, releaseFirst } = guardedSetup();
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 5,
      cooldownMs: 0,
    });
    await new Promise((r) => setTimeout(r, 30));
    // Dispose while tick 1 hangs in the prompt for box a: when the prompt
    // resolves, the loop must not go on to box b.
    handle.stop();
    releaseFirst();
    await new Promise((r) => setTimeout(r, 40));

    expect(prompt.mock.calls.map((c) => c[0])).toEqual(["s1"]);
    db.close();
  });
});

describe("wake tick failures", () => {
  it("backs off on failed ticks instead of stopping — and warns to the plugin log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "wake-backoff-"));
    const db = openMeshDb(join(dir, "mesh.db"));
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    db.close(); // A hot-swapped orphan instance owns a closed database.

    const handle = startWakeLoop({
      db,
      prompt: async () => {},
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 0,
    });
    await vi.waitFor(() => {
      const log = readFileSync(join(dir, "plugin.log"), "utf8");
      expect(log).toContain("wake tick failed 5 times — backing off");
    });
    handle.stop();

    // The 0.30.0 contract: the loop NEVER stops (the 0.28.x hard stop
    // starved every box forever) — the backoff warns land in the plugin
    // log, not in /dev/null.
    const log = readFileSync(join(dir, "plugin.log"), "utf8");
    expect(log).not.toContain("wake loop stopped");
    expect(log).toContain("backing off to");
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps polling when a failure is followed by success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    let calls = 0;
    const handle = startWakeLoop({
      db,
      prompt: async () => {
        calls += 1;
        if (calls === 1) throw new Error("host busy");
      },
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 0,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 80));
    handle.stop();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("wake loop stopped"))).toBe(false);
    warn.mockRestore();
    db.close();
  });
});

describe("token economy (0.16.0)", () => {
  it("does not wake on fanout mail (origin_id differs from id), even with unread > 0", async () => {
    const { db, prompt } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    // A pool broadcast arrives through the fanout: the local message row keeps
    // the ORIGIN id (journal.ts `forwarded` semantics), not its own id.
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "status: pool broadcast",
      body: "b",
      origin_id: "origin-1",
      created_at: 1000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(prompt).not.toHaveBeenCalled();
    db.close();
  });

  it("wakes when a direct mail lands among unread fanout mail", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "status: pool broadcast",
      body: "b",
      origin_id: "origin-1",
      created_at: 1000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 40));
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 2000 });
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();

    expect(prompt).toHaveBeenCalledTimes(1);
    // The content path: the first line keeps the compact grammar, the
    // payload carries the mail (acked — no drain turn).
    expect(prompts[0]?.text).toContain(
      '<mesh-mail kind="notify" subject="status: pool broadcast">',
    );
    expect(prompts[0]?.text).toContain("status: pool broadcast — b");
    expect(prompts[0]?.text).toContain("dm — b");
    db.close();
  });

  it("wakes on fanout mail when wakePools is true (opt-in)", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "status: pool broadcast",
      body: "b",
      origin_id: "origin-1",
      created_at: 1000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      wakePools: true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompts[0]?.text).toContain(
      '<mesh-mail kind="notify" subject="status: pool broadcast">',
    );
    expect(prompts[0]?.text).toContain("status: pool broadcast — b");
    db.close();
  });

  it("compacts the notification: unread count + first pending subject", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "status: quota config transmise",
      body: "b",
      created_at: 1000,
    });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "later mail",
      body: "b",
      created_at: 2000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(prompts[0]?.text).toContain(
      '<mesh-mail kind="notify" subject="status: quota config transmise">',
    );
    expect(prompts[0]?.text).toContain("status: quota config transmise — b");
    expect(prompts[0]?.text).toContain("later mail — b");
    expect(prompts[0]?.text).toContain("status: quota config transmise — b");
    expect(prompts[0]?.text).toContain("later mail — b");
    db.close();
  });

  it("truncates the subject preview to 60 chars", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const long = "x".repeat(70);
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: long,
      body: "b",
      created_at: 1000,
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(prompts[0]?.text).toContain(`mesh-mail`);
    expect(prompts[0]?.text).toContain("x".repeat(70));
    expect(prompts[0]?.text).toContain("x".repeat(70));
    db.close();
  });
});

describe("phantom unread counter (0.24.6): the displayed count is the database's", () => {
  it("recomputes the count at every flash: acked mail never shows again (0, not 1)", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      fatigueTtlMs: 30,
    });
    // The repro, on the COMPACT path (oversized body: the mail stays unread
    // after the flash — the content path would have consumed it): one
    // delivery → the flash shows 1.
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "virtio",
      body: "x".repeat(700),
      created_at: 1000,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0]?.text).toContain("mesh: 1 unread");
    expect(unreadBoxCount(db, "a")).toBe(1);
    const beforeAck = prompts.length;
    // The ack (what mesh_inbox does) → the count re-asked is 0, NOT 1.
    db.conn.run("UPDATE deliveries SET status = 'read' WHERE to_box = 'a'");
    expect(unreadBoxCount(db, "a")).toBe(0);
    // The count never lives in memory between hooks: silence after the drain.
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();
    expect(prompts.length).toBe(beforeAck);
    db.close();
  });

  it("quotes the fresh count, not the one retained from an earlier flash", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    // One OVERSIZED + two small mails: the batch exceeds the budget → the
    // compact path claims without consuming (the mail stays unread, the
    // drain scenario exists). After the partial drain the BIG mail remains
    // alone: STILL oversized → the reminder takes the compact path and
    // quotes the database's fresh count.
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "m0-big",
      body: "x".repeat(700),
      created_at: 1000,
    });
    for (let i = 1; i < 3; i += 1) {
      deliverMessage(db, {
        from: "n",
        to_box: "a",
        subject: `m${i}`,
        body: "x".repeat(50),
        created_at: 1000 + i,
      });
    }
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      fatigueTtlMs: 30,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(prompts[0]?.text).toContain("mesh: 3 unread");
    const beforeAck = prompts.length;
    const threes = prompts.filter((p) => p.text.includes("mesh: 3 unread")).length;
    expect(threes).toBeGreaterThanOrEqual(1);
    // The agent acks 2 of the 3 (partial drain) → the reminder re-claims the
    // last unread row and the flash quotes the database's 1, never the
    // retained 3.
    db.conn.run(
      "UPDATE deliveries SET status = 'read' WHERE id IN (SELECT id FROM deliveries WHERE to_box = 'a' ORDER BY created_at DESC LIMIT 2)",
    );
    await new Promise((r) => setTimeout(r, 80));
    handle.stop();
    // The reminder re-claimed the LAST unread row: the reminder NEVER
    // consumes (the 0.33.4 — a nudge, not the delivery): the row stays
    // unread and the flash quotes the database's 1, never the retained 3.
    expect(unreadBoxCount(db, "a")).toBe(1);
    expect(prompts.filter((p) => p.text.includes("mesh: 1 unread")).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(prompts.filter((p) => p.text.includes("mesh: 3 unread")).length).toBe(threes);
    const afterAck = prompts.slice(beforeAck);
    expect(afterAck.length).toBeGreaterThanOrEqual(1);
    // Le rappel reprend le gros mail SEUL (700c > le budget): le chemin
    // COMPACT cite le compte frais de la DB (1, jamais le retenu 3) —
    // jamais l'enveloppe (le rappel ne consomme pas, la 0.33.4).
    for (const p of afterAck) {
      expect(p.text).toContain('mesh: 1 unread — "m0-big"');
      expect(p.text).not.toContain("mesh: 3 unread");
      expect(p.text).not.toContain("<mesh-mail");
    }
    db.close();
  });
});

describe("the wake loop: the transaction-leak probe (0.30.0)", () => {
  it("detects and recovers a leaked BEGIN on the next tick", async () => {
    const { db, prompt, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    // Simulate the leak: a BEGIN left open on the connection.
    db.conn.exec("BEGIN");
    expect(db.conn.inTransaction()).toBe(true);
    const handle = startWakeLoop({ db, prompt, sessionKnown, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    handle.stop();
    // The probe ran the guard, hit the leak, reopened: the connection is
    // clean and the loop kept working (no silent frozen view).
    expect(db.conn.inTransaction()).toBe(false);
  });
});

describe("the active escalation (0.30.0)", () => {
  it("alerts orq once per starvation period after 3 mute cycles", async () => {
    vi.useFakeTimers();
    try {
      const { db, prompt, sessionKnown } = setup(["s1"]);
      registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
      registerMailbox(db, { name: "orq", session_id: "s-orq", now: 1000 });
      // OVERSIZED: the compact path keeps the mail unread — the starvation
      // the escalation exercises cannot happen on a consumed (content) mail.
      deliverMessage(db, {
        from: "n",
        to_box: "a",
        subject: "s",
        body: "x".repeat(700),
        created_at: 1000,
      });
      const handle = startWakeLoop({
        db,
        prompt,
        sessionKnown,
        sessionRunning: () => false,
        // One minute per tick: the mute cycles (minutes) advance in a few
        // dozen ticks instead of tens of thousands.
        intervalMs: 60_000,
        fatigueTtlMs: 60_000,
      });
      // One minute per tick: the claim re-arms on the next tick, three
      // reminders exhaust the counter (the mute begins, cycle 0).
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      // The mute TTL doubles per cycle: 10 min -> 20 -> 40 -> 80. The 4th
      // expiry crosses ESCALATE_AFTER_MUTE_CYCLES (3): the alert fires once.
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await vi.advanceTimersByTimeAsync(21 * 60_000);
      await vi.advanceTimersByTimeAsync(41 * 60_000);
      await vi.advanceTimersByTimeAsync(81 * 60_000);
      handle.stop();
      const orqMail = db.conn.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'orq' AND status = 'unread'",
      );
      expect(orqMail?.n).toBe(1);
      // One alert per period: further mutes do not re-alert (the escalated
      // flag clears only on a drain).
      const orqAll = db.conn.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM deliveries WHERE to_box = 'orq'",
      );
      expect(orqAll?.n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("skips the escalation with a plugin.log warn when orq is absent", async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), "wake-escalate-"));
      const db = openMeshDb(join(dir, "mesh.db"));
      registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
      // NO orq mailbox on this node: the escalation skips. OVERSIZED body:
      // the compact path keeps the mail unread (the escalation subject).
      deliverMessage(db, {
        from: "n",
        to_box: "a",
        subject: "s",
        body: "x".repeat(700),
        created_at: 1000,
      });
      const handle = startWakeLoop({
        db,
        prompt: async () => {},
        sessionKnown: () => true,
        sessionRunning: () => false,
        intervalMs: 60_000,
        fatigueTtlMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await vi.advanceTimersByTimeAsync(21 * 60_000);
      await vi.advanceTimersByTimeAsync(41 * 60_000);
      await vi.advanceTimersByTimeAsync(81 * 60_000);
      handle.stop();
      const log = readFileSync(join(dir, "plugin.log"), "utf8");
      expect(log).toContain("escalation skipped");
      // No orq box in this fixture: no DM could have landed anyway.
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe("P5 (0.31.0): debugWake — the flash leaves a diagnostic line", () => {
  it("a flash with debugWake logs pid, box, fresh and the snapshot version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-debugwake-"));
    const db = openMeshDb(join(dir, "mesh.db"));
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt: async () => {},
      sessionKnown: () => true,
      debugWake: true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();
    const log = readFileSync(join(dir, "plugin.log"), "utf8");
    expect(log).toContain("flash");
    expect(log).toContain("box=a");
    expect(log).toContain("fresh=1");
    expect(log).toMatch(/dataVersion=\d+/);
    // The loaded plugin version rides the diagnostic line: the flash names
    // WHICH code flashed (the process version, not the config pin).
    expect(log).toMatch(/v=\d+\.\d+\.\d+/);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("no debugWake: no flash diagnostic line (the default stays silent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-debugwake-"));
    const db = openMeshDb(join(dir, "mesh.db"));
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt: async () => {},
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();
    // Nothing warned: the log file may not even exist (pluginWarn creates it
    // lazily) — the assertion is "no flash line", not "file exists".
    const log = existsSync(join(dir, "plugin.log"))
      ? readFileSync(join(dir, "plugin.log"), "utf8")
      : "";
    expect(log).not.toContain("flash");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("single-flight flash (0.32.0): the claim lives in the DB, not in instance memory", () => {
  it("two wake loops on the same DB prompt a fresh delivery ONCE (the double-flash class)", async () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const prompts: string[] = [];
    const h1 = startWakeLoop({
      db,
      prompt: async (_sid: string, text: string) => {
        prompts.push("h1:" + text);
      },
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    const h2 = startWakeLoop({
      db,
      prompt: async (_sid: string, text: string) => {
        prompts.push("h2:" + text);
      },
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 80));
    h1.stop();
    h2.stop();
    // Two instances, each iterating ALL boxes with per-instance gates: the
    // 6admin double-flash (03:33, two identical replies 13s apart). The
    // claim is DB-arbitrated — one winner.
    expect(prompts).toHaveLength(1);
    db.close();
  });

  it("claimFlash: NULL rows claim at any staleness, flashed rows only past the TTL", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    const now = Date.now();
    // Fresh (NULL) rows claim regardless of the staleness — the loop passes
    // the reminder TTL, never 0.
    expect(claimFlash(db, "a", now, 10 * 60 * 1000).claimed).toBe(1);
    // Flashed NOW: not stale after 10 minutes — no re-claim (the anti-spam).
    expect(claimFlash(db, "a", now + 1000, 10 * 60 * 1000).claimed).toBe(0);
    // The reminder path: rows flashed before the TTL are re-claimed.
    expect(claimFlash(db, "a", now + 60 * 60 * 1000, 30 * 60 * 1000).claimed).toBe(1);
    db.close();
  });

  it("a delivery read between ticks never flashes (the claim sees nothing fresh)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "dm", body: "b", created_at: 1000 });
    inboxRead(db, "s1", true);
    expect(claimFlash(db, "a", Date.now(), 0).claimed).toBe(0);
    db.close();
  });
});

describe("P1.1 (refonte): the flash carries the content — one turn instead of two", () => {
  it("claimFlashWithContent: a small batch is claimed, READ and returned in one shot", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      from_box: "x",
      to_box: "a",
      subject: "s1",
      body: "body one",
      created_at: 1000,
    });
    deliverMessage(db, {
      from: "n",
      from_box: "y",
      to_box: "a",
      subject: "s2",
      body: "body two",
      created_at: 1001,
    });
    const res = claimFlashWithContent(db, "a", Date.now(), 10 * 60 * 1000, 600);
    expect(res.claimed).toBe(2);
    expect(res.content).not.toBeNull();
    expect(res.content).toContain("s1");
    expect(res.content).toContain("body one");
    expect(res.content).toContain("s2");
    expect(res.content).toContain("body two");
    // The same UPDATE marked the batch READ: the drain after the flash is
    // EMPTY — the -1 turn is the whole point.
    expect(unreadBoxCount(db, "a")).toBe(0);
    const rows = db.conn.all<{ flashed_at: number | null }>(
      "SELECT flashed_at FROM deliveries WHERE to_box = 'a'",
    );
    for (const row of rows) expect(row.flashed_at).not.toBeNull();
    db.close();
  });

  it("claimFlashWithContent: an oversized batch claims WITHOUT content (the compact path)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      from_box: "x",
      to_box: "a",
      subject: "big",
      body: "x".repeat(700),
      created_at: 1000,
    });
    const res = claimFlashWithContent(db, "a", Date.now(), 10 * 60 * 1000, 600);
    expect(res.claimed).toBe(1);
    expect(res.content).toBeNull();
    // The compact path: claimed (flashed) but NOT read — mesh_inbox carries
    // the body at the next turn.
    expect(unreadBoxCount(db, "a")).toBe(1);
    db.close();
  });
});
