import { describe, expect, it, vi } from "vitest";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMeshDb } from "../src/lib/db.js";
import { deliverMessage, joinPool, registerMailbox, unreadBoxCount } from "../src/lib/mail.js";
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
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      intervalMs: 50,
      cooldownMs: 20,
    });
    await new Promise((r) => setTimeout(r, 150));
    handle.stop();
    // The exact count is timing-dependent (the interval/cooldown interplay
    // drifts across node versions): the invariant is AT LEAST two prompts,
    // each carrying its own generated id.
    expect(prompt.mock.calls.length).toBeGreaterThanOrEqual(2);
    const ids = prompt.mock.calls.map((c) => (c as unknown[])[2]);
    for (const id of ids) {
      expect(id).toMatch(/^msg_/);
    }
    // Each prompt gets its OWN id: the server reconciles per prompt, and two
    // different prompts are two different messages.
    expect(ids[0]).not.toBe(ids[1]);
  });
  it("expires the fatigue mute — a starved box wakes again", async () => {
    vi.useFakeTimers();
    try {
      const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
      registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
      deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
      const handle = startWakeLoop({
        db,
        prompt,
        sessionKnown,
        // No sessionRunning: the collapse gate disengages — this test isolates
        // the fatigue mute (cooldown 50 < interval 100 → three prompts then
        // the mute).
        intervalMs: 100,
        cooldownMs: 50,
      });
      // Three prompts exhaust the fatigue counter; the box never drains.
      await vi.advanceTimersByTimeAsync(500);
      const muted = prompts.length;
      expect(muted).toBe(3);
      // Ten minutes of silence: without a mute TTL the box never prompts
      // again and its mail starves (the orq/6admin episode).
      await vi.advanceTimersByTimeAsync(600_000);
      handle.stop();
      expect(prompts.length).toBeGreaterThan(muted);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wake collapse gate (at most one prompt in flight per session)", () => {
  it("does not queue a second prompt while the first is in flight", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    const running = false;
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
    // The mail drains (any path: the queue delivered a DIFFERENT turn, a
    // journal read, ...) while the first prompt's own turn never ran. The
    // fatigue and cooldown maps reset on the drain; a fresh mail arrives.
    // Without the collapse gate this fires a second prompt whose inbox is
    // already empty when its turn runs — the phantom class.
    db.conn.run("UPDATE deliveries SET status = 'read' WHERE to_box = 'a'");
    // Two fresh mails: unread must GROW past the stale previous (1) so the
    // fatigue mute cannot explain the silence — only the collapse gate can.
    deliverMessage(db, { from: "n", to_box: "a", subject: "s2", body: "b2", created_at: 2000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s3", body: "b3", created_at: 2001 });
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();
    expect(prompts.length).toBe(first);
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
      deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
      const handle = startWakeLoop({
        db,
        prompt,
        sessionKnown,
        // Never busy: the delivery receipt never shows — the TTL is the only
        // escape (a turn shorter than the poll interval hides its busy event).
        sessionRunning: () => false,
        intervalMs: 100,
        cooldownMs: 50,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(prompts.length).toBe(1);
      // Two fresh mails: ungated, the growth would fire again.
      deliverMessage(db, { from: "n", to_box: "a", subject: "s2", body: "b2", created_at: 2000 });
      deliverMessage(db, { from: "n", to_box: "a", subject: "s3", body: "b3", created_at: 2001 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prompts.length).toBe(1);
      // Past the TTL the gate releases: at most one duplicate flash per TTL.
      await vi.advanceTimersByTimeAsync(70_000);
      handle.stop();
      expect(prompts.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wake loop", () => {
  it("uses the documented defaults", () => {
    expect(DEFAULT_WAKE_INTERVAL_MS).toBe(5000);
    expect(DEFAULT_WAKE_COOLDOWN_MS).toBe(60000);
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
    expect(prompts[0]?.text).toContain('mesh: 1 unread — "s"');

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
  it("stops prompting after MAX_UNDRAINED_PROMPTS cycles without drain", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 0,
      maxUndrainedPrompts: 3,
    });
    await new Promise((r) => setTimeout(r, 120));
    handle.stop();

    // Prompted exactly 3 times, then gave up (count never drained).
    expect(prompts.length).toBe(3);
    db.close();
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
    expect(prompts[0]?.text).toContain('mesh: 1 unread — "r8 go: build is green"');
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
    expect(prompts[0]?.text).toBe('mesh: 2 unread — "status: pool broadcast"');
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
    expect(prompts[0]?.text).toBe('mesh: 1 unread — "status: pool broadcast"');
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

    expect(prompts[0]?.text).toBe('mesh: 2 unread — "status: quota config transmise"');
    db.close();
  });

  it("truncates the subject preview to 60 chars", async () => {
    const { db, prompt, prompts } = setup(["s1"]);
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    const long = "x".repeat(70);
    deliverMessage(db, { from: "n", to_box: "a", subject: long, body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(prompts[0]?.text).toBe(`mesh: 1 unread — "${"x".repeat(59)}…"`);
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
      cooldownMs: 0,
    });
    // The repro: one delivery → the flash shows 1.
    deliverMessage(db, { from: "n", to_box: "a", subject: "virtio", body: "b", created_at: 1000 });
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
    for (let i = 0; i < 3; i += 1) {
      deliverMessage(db, {
        from: "n",
        to_box: "a",
        subject: `m${i}`,
        body: "b",
        created_at: 1000 + i,
      });
    }
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown: () => true,
      intervalMs: 10,
      cooldownMs: 0,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(prompts[0]?.text).toContain("mesh: 3 unread");
    const beforeAck = prompts.length;
    const threes = prompts.filter((p) => p.text.includes("mesh: 3 unread")).length;
    expect(threes).toBeGreaterThanOrEqual(1);
    // The agent acks 2 of the 3 (partial drain) → the next flash quotes the
    // database's 1, never the retained 3.
    db.conn.run(
      "UPDATE deliveries SET status = 'read' WHERE id IN (SELECT id FROM deliveries WHERE to_box = 'a' ORDER BY created_at ASC LIMIT 2)",
    );
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();
    expect(unreadBoxCount(db, "a")).toBe(1);
    expect(prompts.filter((p) => p.text.includes("mesh: 3 unread")).length).toBe(threes);
    const afterAck = prompts.slice(beforeAck);
    expect(afterAck.length).toBeGreaterThanOrEqual(1);
    for (const p of afterAck) {
      expect(p.text).toContain("mesh: 1 unread");
      expect(p.text).not.toContain("mesh: 3 unread");
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
      deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
      const handle = startWakeLoop({
        db,
        prompt,
        sessionKnown,
        sessionRunning: () => false,
        // One minute per tick: the mute cycles (minutes) advance in a few
        // dozen ticks instead of tens of thousands.
        intervalMs: 60_000,
        cooldownMs: 0,
      });
      // The first window: 3 prompts exhaust the fatigue counter (the mute
      // begins, cycle 0).
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
      // NO orq mailbox on this node: the escalation skips.
      deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
      const handle = startWakeLoop({
        db,
        prompt: async () => {},
        sessionKnown: () => true,
        sessionRunning: () => false,
        intervalMs: 60_000,
        cooldownMs: 0,
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
