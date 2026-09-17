import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import module_ from "../src/index.js";
import { MeshPlugin } from "../src/plugin.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-smoke-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("smoke: plugin module", () => {
  it("exports a v1 plugin module with id and server", () => {
    expect(module_.id).toBe("@log0u7/opencode-mesh");
    expect(module_.server).toBe(MeshPlugin);
  });

  it("plugin factory resolves hooks without network or side effects", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    expect(Object.keys(hooks).sort()).toEqual(["dispose", "tool"]);
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "mesh_inbox",
      "mesh_lock",
      "mesh_pair",
      "mesh_send",
      "mesh_status",
      "mesh_unlock",
    ]);
    await hooks.dispose?.();
  });
});

function fakeInput() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}
