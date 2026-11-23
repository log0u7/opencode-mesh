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
    expect(prompts[0]?.text).toContain('mailbox "a"');

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
    expect(prompts[1]?.text).toContain('mailbox "b"');
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
