import { describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMeshDb } from "../src/lib/db.js";
import {
  askTask,
  claimFlashWithContent,
  deliverMessage,
  getTask,
  registerMailbox,
  replyTask,
  unreadBoxCount,
} from "../src/lib/mail.js";
import { escalateBox, startWakeLoop } from "../src/lib/wake.js";
import { MeshPlugin } from "../src/plugin.js";

const setup = (hostSessions: string[]) => {
  const db = openMeshDb(":memory:");
  const live = new Set(hostSessions);
  const prompts: Array<{ sessionID: string; text: string; id?: string | undefined }> = [];
  const prompt = vi.fn(async (sessionID: string, text: string, id?: string) => {
    prompts.push({ sessionID, text, id });
  });
  return { db, prompt, prompts, sessionKnown: vi.fn((s: string) => live.has(s)) };
};

describe("the task avis link (0.33.4-1): the flash consumes, the reminder dies", () => {
  it("ask -> long reply -> 1 flash consumed (0 unread), 0 reminder, content truncated with the full pointer", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    registerMailbox(db, { name: "bob", session_id: "s2", now: 1000 });
    const task = askTask(db, { from_box: "alice", to_box: "bob", question: "q" });
    const rep = replyTask(db, task.id, "bob", "x".repeat(2000), "completed");
    expect(rep.notified).toBe(true);

    // The delivery carries the task id: the link task -> avis.
    const d = db.conn.get<{ task_id: string; status: string; flash_count: number }>(
      "SELECT task_id, status, flash_count FROM deliveries WHERE to_box='alice'",
    )!;
    expect(d.task_id).toBe(task.id);
    expect(d.status).toBe("unread");
    expect(d.flash_count).toBe(0);

    // ONE flash: the task avis is ALWAYS consumed (inlined truncated).
    const now = Date.now();
    const dbg = db.conn.all(
      "SELECT d.id, d.to_box, d.status, d.task_id, d.flash_count, d.flashed_at, m.subject FROM deliveries d JOIN messages m ON m.id=d.message_id",
    );
    console.log("DBG deliveries:", JSON.stringify(dbg));
    const claim = claimFlashWithContent(db, "alice", now, 600_000, 600);
    expect(claim.claimed).toBe(1);
    expect(claim.content).not.toBeNull();
    expect(claim.content).toContain("completed");
    expect(claim.content).toContain("full: mesh_tasks");
    // The state and the first 400 chars of the result ride.
    expect(claim.content!.length).toBeLessThan(600);

    // 0 unread after; a later re-claim (the reminder window) claims NOTHING.
    expect(unreadBoxCount(db, "alice")).toBe(0);
    const later = claimFlashWithContent(db, "alice", now + 600_000, 600_000, 600);
    expect(later.claimed).toBe(0);
    db.close();
  });

  it("mesh_tasks marks the task avis read (the asker never sees a reminder)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-tasks-"));
    const hooks = await MeshPlugin(
      {
        client: {} as never,
        project: { id: "p1" } as never,
        directory: "/w",
        worktree: "/w",
        experimental_workspace: {} as never,
        serverUrl: new URL("http://localhost:4096"),
        $: (() => Promise.resolve()) as never,
      },
      { dataDir: dir, port: 0, advertise: false },
    );
    const tools = hooks.tool ?? {};
    const ctx = { sessionID: "s1" } as never;
    await tools.mesh_register?.execute({ name: "alice" }, ctx);
    await tools.mesh_register?.execute({ name: "bob" }, ctx);
    const askRes = await tools.mesh_ask?.execute({ to: "bob", body: "etat?" }, ctx);
    // The tool execute returns the content STRING directly (not {content}).
    const taskId = JSON.parse(String(askRes ?? "")).task_id as string;
    // The responder answers (locally: the asker is alice on this node).
    const { openMeshDb: odb } = await import("../src/lib/db.js");
    const db = odb(`${dir}/mesh.db`);
    const full = db.conn.get<{ id: string }>("SELECT id FROM tasks")!.id;
    const rep = replyTask(db, full, "bob", "finito", "completed");
    expect(rep.notified).toBe(true);

    // mesh_tasks: the COMPACT lines (one per task, not indented JSON) AND
    // the avis marked read.
    const tasksOut = String((await tools.mesh_tasks?.execute({}, ctx)) ?? "");
    expect(tasksOut).toContain(`${taskId.slice(0, 8)} completed alice->bob`);
    expect(tasksOut).not.toContain('  "id"');
    expect(unreadBoxCount(db, "alice")).toBe(0);
    db.close();
    await hooks.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the persisted fatigue (0.33.4-2): 10, 20, 40, 80 then silence, state in DB", () => {
  it("a never-drained delivery: the reminders widen then stop; a fresh loop (restart) stays silent", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "bob", session_id: "s1", now: Date.now() });
    // An OVERSIZED mail (the ghost class: the batch never fits the budget,
    // the flash takes the compact path, the row stays unread — the agent
    // must drain to ack, the reminders nudge until the flash cap).
    deliverMessage(db, {
      from: "x",
      to_box: "bob",
      subject: "ping",
      body: "y".repeat(700),
      kind: "notify",
    });

    // base = 40ms: the intervals 40, 80, 160, 320ms (the 10/20/40/80 shape
    // scaled), then silence. The real timings, no fake timers.
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      intervalMs: 5,
      fatigueTtlMs: 40,
    });
    await new Promise((r) => setTimeout(r, 900));
    handle.stop();
    // 1 initial + 4 reminders (the windows base, 2b, 4b, 8b) = 5 prompts.
    expect(prompts.length).toBe(5);

    // A fresh loop (the restart, a second instance): the state is in the
    // DB — flash_count at the cap, NO new prompt ever.
    const handle2 = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      intervalMs: 5,
      fatigueTtlMs: 40,
    });
    await new Promise((r) => setTimeout(r, 200));
    handle2.stop();
    expect(prompts.length).toBe(5);
    db.close();
  });
});

describe("the compact-path prompt id (0.33.6): deterministic, the host dedups", () => {
  it("the reminders of the SAME unread rows reconcile to ONE synthetic id; a new mail gets a NEW id", async () => {
    const { db, prompt, prompts, sessionKnown } = setup(["s1"]);
    registerMailbox(db, { name: "bob", session_id: "s1", now: Date.now() });
    // An OVERSIZED mail: the compact path (the phantom class — the random
    // id made every reminder a NEW panel entry, the orq 10-turn episode).
    deliverMessage(db, {
      from: "x",
      to_box: "bob",
      subject: "ping",
      body: "y".repeat(700),
      kind: "notify",
    });
    const handle = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      intervalMs: 5,
      fatigueTtlMs: 40,
    });
    await new Promise((r) => setTimeout(r, 700));
    handle.stop();
    // 1 initial + reminders: the SAME delivery id hashes to the SAME
    // synthetic id — the host reconciles instead of stacking entries.
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    const ids = prompts.map((p) => p.id);
    expect(new Set(ids).size).toBe(1);
    // A FRESH mail lands: a different claimed set -> a different id.
    deliverMessage(db, {
      from: "x",
      to_box: "bob",
      subject: "ping2",
      body: "z".repeat(700),
      kind: "notify",
    });
    const handle2 = startWakeLoop({
      db,
      prompt,
      sessionKnown,
      intervalMs: 5,
      fatigueTtlMs: 40,
    });
    await new Promise((r) => setTimeout(r, 150));
    handle2.stop();
    expect(prompts.at(-1)?.id).not.toBe(ids[0]);
    db.close();
  });
});

describe("escalateBox (0.33.4-3)", () => {
  it("does nothing when the box IS the escalation target (no self-loop)", () => {
    const db = openMeshDb(":memory:");
    registerMailbox(db, { name: "orq", session_id: "s1", now: 1000 });
    escalateBox(db, "orq", "orq", 4, "subject", new Map());
    expect(db.conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages")?.n).toBe(0);
    db.close();
  });
});
