import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MeshPlugin } from "../src/plugin.js";
import { openMeshDb } from "../src/lib/db.js";
import { startMeshServer } from "../src/lib/serve.js";

let dir: string;
let dir2: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-port-1-"));
  dir2 = mkdtempSync(join(tmpdir(), "opencode-mesh-port-2-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

function input() {
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

function ctx() {
  return {} as never;
}

describe("port collision", () => {
  it("second plugin instance on a taken port falls back to an ephemeral port", async () => {
    const first = await MeshPlugin(input(), { dataDir: dir, port: 0, advertise: false });
    const firstStatus = JSON.parse(String(await first.tool?.mesh_status?.execute({}, ctx()))) as {
      server: string;
    };
    const takenPort = Number(firstStatus.server.split(":")[1]);

    // Occupy that exact port with an unrelated mesh server.
    const blockerDb = openMeshDb(":memory:");
    const blocker = await startMeshServer({ db: blockerDb, port: takenPort });

    // The real assertion: default-port collision must not throw at init...
    const second = await MeshPlugin(input(), { dataDir: dir2, port: takenPort, advertise: false });
    // ...and the second node serves on a different port.
    const secondStatus = JSON.parse(String(await second.tool?.mesh_status?.execute({}, ctx()))) as {
      server: string;
    };
    const secondPort = Number(secondStatus.server.split(":")[1]);

    expect(secondPort).not.toBe(takenPort);

    blocker.server.close();
    blockerDb.close();
    await first.dispose?.();
    await second.dispose?.();
  });
});
