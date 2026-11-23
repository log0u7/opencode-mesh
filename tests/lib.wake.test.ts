import { describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { deliverMessage, registerMailbox } from "../src/lib/mail.js";
import {
  startWakeLoop,
  DEFAULT_WAKE_INTERVAL_MS,
  DEFAULT_WAKE_COOLDOWN_MS,
} from "../src/lib/wake.js";

function setup(hostSessions: string[]) {
  const db = openMeshDb(":memory:");
  const live = new Set(hostSessions);
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const prompt = vi.fn(async (sessionID: string, text: string) => {
    prompts.push({ sessionID, text });
  });
  const sessionKnown = vi.fn((sessionID: string) => live.has(sessionID));
  return { db, prompt, prompts, sessionKnown };
}

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

describe("wake tick failures", () => {
  it("logs each failed tick and stops the loop after MAX_TICK_FAILURES", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = openMeshDb(":memory:");
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
      expect(warn.mock.calls.some((c) => String(c[0]).includes("wake loop stopped"))).toBe(true);
    });
    handle.stop();

    const stopMessages = warn.mock.calls.filter((c) =>
      String(c[0]).includes("wake loop stopped after 5 consecutive tick failures"),
    );
    expect(stopMessages).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("wake tick failed (1/5)"))).toBe(true);
    warn.mockRestore();
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
