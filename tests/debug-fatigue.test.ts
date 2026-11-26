import { appendFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openMeshDb } from "../src/lib/db.js";
import { deliverMessage, registerMailbox } from "../src/lib/mail.js";
import { startWakeLoop } from "../src/lib/wake.js";

const log = (s: string) => appendFileSync("/tmp/opencode/dbg.log", s + "\n");

describe("debug", () => {
  it("traces the compact re-claim under fake timers", async () => {
    vi.useFakeTimers();
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "a", session_id: "s1", now: 1000 });
    deliverMessage(db, {
      from: "n",
      to_box: "a",
      subject: "s",
      body: "x".repeat(700),
      created_at: 1000,
    });
    let calls = 0;
    const handle = startWakeLoop({
      db,
      prompt: async () => {
        calls += 1;
      },
      sessionKnown: () => true,
      intervalMs: 100,
      fatigueTtlMs: 50,
    });
    log("date.now at start: " + Date.now());
    await vi.advanceTimersByTimeAsync(100);
    log(
      "t=100 calls=" +
        calls +
        " date=" +
        Date.now() +
        " rows=" +
        JSON.stringify(db.conn.all("SELECT status, flashed_at FROM deliveries")),
    );
    await vi.advanceTimersByTimeAsync(100);
    log(
      "t=200 calls=" +
        calls +
        " date=" +
        Date.now() +
        " rows=" +
        JSON.stringify(db.conn.all("SELECT status, flashed_at FROM deliveries")),
    );
    await vi.advanceTimersByTimeAsync(300);
    log("t=500 calls=" + calls);
    handle.stop();
    vi.useRealTimers();
    expect(true).toBe(true);
  });
});
