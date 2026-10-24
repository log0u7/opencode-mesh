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
  it("exports a v1 plugin module with id and a lazy server entry", async () => {
    expect(module_.id).toBe("@log0u7/opencode-mesh");
    // server() lazily loads the v1 implementation so the v1-only import graph
    // stays out of the static graph (v2 hosts reject it at load time). The
    // contract is therefore not identity with MeshPlugin but equivalent hooks.
    expect(typeof module_.server).toBe("function");
    const hooks = await module_.server(fakeInput(), {
      dataDir: dir,
      port: 0,
      advertise: false,
    });
    expect(Object.keys(hooks).sort()).toEqual(["dispose", "tool"]);
    await hooks.dispose?.();
  });

  it("resolves server() with no options through the child-process short-circuit", async () => {
    const previous = process.env.OPENCODE_MESH_CHILD;
    process.env.OPENCODE_MESH_CHILD = "1";
    try {
      // No options at all: the v1 factory short-circuits as a mesh child, so
      // the wrapper must still resolve, with no port, db or mDNS work.
      const hooks = await module_.server(fakeInput());
      expect(Object.keys(hooks).sort()).toEqual(["dispose"]);
      await hooks.dispose?.();
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_MESH_CHILD;
      } else {
        process.env.OPENCODE_MESH_CHILD = previous;
      }
    }
  });

  it("plugin factory resolves hooks without network or side effects", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    expect(Object.keys(hooks).sort()).toEqual(["dispose", "tool"]);
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "mesh_inbox",
      "mesh_lock",
      "mesh_pair",
      "mesh_send",
      "mesh_spawn",
      "mesh_status",
      "mesh_unlock",
      "mesh_worker_logs",
      "mesh_worker_remove",
      "mesh_worker_stop",
      "mesh_workers",
    ]);
    await hooks.dispose?.();
  });

  it("child processes register no tools and open no server", async () => {
    const previous = process.env.OPENCODE_MESH_CHILD;
    process.env.OPENCODE_MESH_CHILD = "1";
    try {
      const hooks = await MeshPlugin(fakeInput(), {
        dataDir: dir,
        port: 0,
        advertise: false,
      });
      // No mesh node: a spawned worker must not cost a server, mDNS or tools.
      expect(Object.keys(hooks).sort()).toEqual(["dispose"]);
      expect(hooks.tool).toBeUndefined();
      await hooks.dispose?.();
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_MESH_CHILD;
      } else {
        process.env.OPENCODE_MESH_CHILD = previous;
      }
    }
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
