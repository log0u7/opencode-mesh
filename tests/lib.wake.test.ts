import { describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { deliverMessage, registerMailbox } from "../src/lib/mail.js";
import {
  startWakeLoop,
  DEFAULT_WAKE_INTERVAL_MS,
  DEFAULT_WAKE_COOLDOWN_MS,
} from "../src/lib/wake.js";

function setup() {
  const db = openMeshDb(":memory:");
  registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
  const prompts: string[] = [];
  const prompt = vi.fn(async (text: string) => {
    prompts.push(text);
  });
  return { db, prompt, prompts };
}

describe("wake loop", () => {
  it("uses the documented defaults", () => {
    expect(DEFAULT_WAKE_INTERVAL_MS).toBe(5000);
    expect(DEFAULT_WAKE_COOLDOWN_MS).toBe(60000);
  });

  it("is inert with intervalMs <= 0", async () => {
    const { db, prompt } = setup();
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({ db, sessionID: "s1", prompt, intervalMs: 0 });
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();
    expect(prompt).not.toHaveBeenCalled();
    db.close();
  });

  it("prompts once when unread mail arrives", async () => {
    const { db, prompt, prompts } = setup();
    const handle = startWakeLoop({
      db,
      sessionID: "s1",
      prompt,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('mailbox "a"');
    expect(prompts[0]).toContain("1 unread");
    db.close();
  });

  it("does not spam while unread count is unchanged (cooldown)", async () => {
    const { db, prompt } = setup();
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    const handle = startWakeLoop({
      db,
      sessionID: "s1",
      prompt,
      intervalMs: 10,
      cooldownMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(prompt).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("prompts again when new mail arrives during the cooldown", async () => {
    const { db, prompt } = setup();
    const handle = startWakeLoop({
      db,
      sessionID: "s1",
      prompt,
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

  it("stays silent for a session without a registered mailbox", async () => {
    const { db, prompt } = setup();
    const handle = startWakeLoop({
      db,
      sessionID: "nobody",
      prompt,
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
    const { db } = setup();
    let calls = 0;
    const handle = startWakeLoop({
      db,
      sessionID: "s1",
      prompt: async () => {
        calls += 1;
        throw new Error("host refused");
      },
      intervalMs: 10,
      cooldownMs: 0,
    });
    deliverMessage(db, { from: "n", to_box: "a", subject: "s", body: "b", created_at: 1000 });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(calls).toBeGreaterThanOrEqual(2);
    db.close();
  });
});
