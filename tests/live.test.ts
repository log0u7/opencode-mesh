import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { getWorker } from "../src/lib/workers.js";
import { nodeSpawn, runWorker, stopWorker } from "../src/lib/spawn.js";

let dir: string;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-live-"));
  dataDir = mkdtempSync(join(tmpdir(), "opencode-mesh-live-data-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// Real-process integration: exercises the nodeSpawn adapter, actual stdout
// streaming, and exit handling end to end (no opencode binary needed).
describe("runWorker with a real child process", () => {
  it("runs a node one-liner, captures stdout, and completes", async () => {
    const db = openMeshDb(":memory:");

    const worker = await runWorker(db, dataDir, {
      task: "emit one json line",
      worktree_path: dir,
      branch: "b",
      spawnFn: (_argv) =>
        nodeSpawn([
          process.execPath,
          "-e",
          `console.log(JSON.stringify(${JSON.stringify({ type: "text", sessionID: "ses-real", text: "real process output" })}))`,
        ]),
    });

    // Wait for the child to finish (poll the registry; child exits fast).
    for (let i = 0; i < 100; i++) {
      const status = getWorker(db, worker.id)?.status;
      if (status !== "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const row = getWorker(db, worker.id);
    expect(row?.status).toBe("completed");
    expect(row?.session_id).toBe("ses-real");

    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(dataDir, "workers", `${worker.id}.log`), "utf8");
    expect(log).toContain("real process output");
    db.close();
  });

  it("does not block when the child writes a lot to stderr", async () => {
    const db = openMeshDb(":memory:");

    // >64 KB on stderr: with an undrained pipe the child would block forever.
    const worker = await runWorker(db, dataDir, {
      task: "flood stderr",
      worktree_path: dir,
      branch: "b",
      spawnFn: (_argv) =>
        nodeSpawn([
          process.execPath,
          "-e",
          [
            "process.stderr.write('e'.repeat(200000));",
            "console.log(JSON.stringify({type:'text',sessionID:'ses-err',text:'done'}));",
          ].join(" "),
        ]),
    });

    for (let i = 0; i < 100; i++) {
      if (getWorker(db, worker.id)?.status !== "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const row = getWorker(db, worker.id);
    expect(row?.status).toBe("completed");

    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(dataDir, "workers", `${worker.id}.log`), "utf8");
    expect(log).toContain("e".repeat(1000));
    db.close();
  });

  it("kills the whole worker process group on stop", async () => {
    const db = openMeshDb(":memory:");

    // The worker spawns its own grandchild and traps nothing: without a group
    // kill, the grandchild would be orphaned and keep running.
    const worker = runWorker(db, dataDir, {
      task: "spawn a grandchild",
      worktree_path: dir,
      branch: "b",
      spawnFn: (_argv) =>
        nodeSpawn([
          process.execPath,
          "-e",
          [
            "const { spawn } = require('child_process');",
            "const child = spawn(process.execPath, ['-e', 'console.log(\\'gc:\\' + process.pid); setInterval(()=>{},1000)'], { stdio: 'inherit' });",
            "setInterval(()=>{},1000);",
          ].join(" "),
        ]),
    });

    // Wait until the grandchild printed its pid into the worker log.
    let grandchildPid = 0;
    for (let i = 0; i < 40 && grandchildPid === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const { readFileSync } = await import("node:fs");
        const log = readFileSync(join(dataDir, "workers", `${worker.id}.log`), "utf8");
        grandchildPid = Number(/gc:(\d+)/.exec(log)?.[1] ?? 0);
      } catch {
        // Log not written yet.
      }
    }
    expect(grandchildPid).toBeGreaterThan(0);

    stopWorker(db, worker.id);
    // Give the OS a moment to reap both processes.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(pidAlive(worker.pid ?? 0)).toBe(false);
    expect(pidAlive(grandchildPid)).toBe(false);
    db.close();
  });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
