import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { getWorker } from "../src/lib/workers.js";
import { nodeSpawn, runWorker } from "../src/lib/spawn.js";

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
      spawnFn: (argv) =>
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
});
