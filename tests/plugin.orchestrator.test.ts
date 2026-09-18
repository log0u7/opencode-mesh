import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MeshPlugin } from "../src/plugin.js";
import { liveWorkerIds } from "../src/lib/spawn.js";
import type { ToolContext } from "@opencode-ai/plugin";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-orchestrator-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent: "build",
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function fakeInput() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: "/work/project",
    worktree: "/work/project",
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

function fakeWorktreeClient() {
  return {
    worktree: {
      create: vi.fn(async () => ({
        data: { name: "task-1", branch: "opencode/task-1", directory: "/data/worktree/p1/task-1" },
      })),
      remove: vi.fn(async () => ({ data: true })),
    },
  };
}

// A worker script that reports a session and finishes successfully.
function okSpawn(lines: Array<Record<string, unknown>> = []) {
  return (argv: string[]) => {
    const listeners: Array<(code: number | null) => void> = [];
    const stdoutListeners: Array<(chunk: string) => void> = [];
    const proc = {
      pid: 4242,
      stdout: { on: (_: string, cb: (chunk: string) => void) => stdoutListeners.push(cb) },
      on: (_: string, cb: (code: number | null) => void) => listeners.push(cb),
      kill: () => {},
    };
    queueMicrotask(() => {
      for (const line of lines) {
        for (const cb of stdoutListeners) cb(`${JSON.stringify(line)}\n`);
      }
      for (const cb of listeners) cb(0);
    });
    void argv;
    return proc as never;
  };
}

async function loadTools(options: Record<string, unknown>) {
  const hooks = await MeshPlugin(fakeInput(), {
    dataDir: dir,
    port: 0,
    advertise: false,
    ...options,
  });
  return { hooks, tools: hooks.tool ?? {} };
}

describe("orchestrator tools", () => {
  it("mesh_spawn creates a worktree, tracks the worker, and reports ids", async () => {
    const wt = fakeWorktreeClient();
    const { tools } = await loadTools({
      worktreeClient: wt,
      spawnFn: okSpawn([{ type: "step_start", sessionID: "ses-9" }]),
    });

    const result = JSON.parse(
      String(await tools.mesh_spawn?.execute({ task: "summarize the README" }, ctx("s1"))),
    ) as { worker_id: string; worktree: string; branch: string; pid: number };

    expect(result.worktree).toBe("/data/worktree/p1/task-1");
    expect(result.branch).toBe("opencode/task-1");
    expect(result.pid).toBe(4242);
    expect(wt.worktree.create).toHaveBeenCalled();
  });

  it("mesh_workers lists workers with lifecycle states", async () => {
    const { tools } = await loadTools({
      worktreeClient: fakeWorktreeClient(),
      spawnFn: okSpawn([{ type: "step_start", sessionID: "ses-9" }]),
    });

    await tools.mesh_spawn?.execute({ task: "one" }, ctx("s1"));
    const list = JSON.parse(String(await tools.mesh_workers?.execute({}, ctx("s1")))) as Array<{
      status: string;
      session_id: string | null;
    }>;

    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("completed");
    expect(list[0]?.session_id).toBe("ses-9");
  });

  it("mesh_worker_logs returns the tail of the captured output", async () => {
    const { tools } = await loadTools({
      worktreeClient: fakeWorktreeClient(),
      spawnFn: okSpawn([
        { type: "step_start", sessionID: "ses-1" },
        { type: "text", text: "worker output line" },
      ]),
    });

    const spawned = JSON.parse(
      String(await tools.mesh_spawn?.execute({ task: "t" }, ctx("s1"))),
    ) as { worker_id: string };

    const logs = String(
      await tools.mesh_worker_logs?.execute({ worker_id: spawned.worker_id }, ctx("s1")),
    );
    expect(logs).toContain("worker output line");
  });

  it("mesh_worker_remove refuses running workers without force, cleans up with force", async () => {
    const wt = fakeWorktreeClient();
    // Long-running fake: the worker stays running until killed.
    const hangingSpawn = (_argv: string[]) => {
      const proc = {
        pid: 4242,
        stdout: { on: () => {} },
        on: () => {},
        kill: () => {},
      };
      return proc as never;
    };
    const { tools } = await loadTools({ worktreeClient: wt, spawnFn: hangingSpawn });

    const spawned = JSON.parse(
      String(await tools.mesh_spawn?.execute({ task: "t" }, ctx("s1"))),
    ) as { worker_id: string };

    const refused = String(
      await tools.mesh_worker_remove?.execute({ worker_id: spawned.worker_id }, ctx("s1")),
    );
    expect(refused).toContain("running");

    const removed = String(
      await tools.mesh_worker_remove?.execute(
        { worker_id: spawned.worker_id, force: true },
        ctx("s1"),
      ),
    );
    expect(removed).toContain("removed");
    expect(wt.worktree.remove).toHaveBeenCalledWith({
      worktreeRemoveInput: { directory: "/data/worktree/p1/task-1" },
    });

    const after = String(await tools.mesh_workers?.execute({}, ctx("s1")));
    expect(after).toBe("[]");
  });

  it("dispose stops live workers so nothing outlives the plugin", async () => {
    const hangingSpawn = (_argv: string[]) => {
      const proc = {
        pid: 4242,
        stdout: { on: () => {} },
        on: () => {},
        kill: () => {},
      };
      return proc as never;
    };
    const { hooks, tools } = await loadTools({
      worktreeClient: fakeWorktreeClient(),
      spawnFn: hangingSpawn,
    });

    await tools.mesh_spawn?.execute({ task: "long task" }, ctx("s1"));
    expect(liveWorkerIds()).toHaveLength(1);

    await hooks.dispose?.();
    expect(liveWorkerIds()).toEqual([]);
  });
});
