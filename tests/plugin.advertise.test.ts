import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MeshPlugin } from "../src/plugin.js";
import type { ToolContext } from "@opencode-ai/plugin";

// Stub the mDNS library: the plugin's advertise path must be exercised without
// real multicast traffic.
type DiscoveryService = {
  txt?: Record<string, string>;
  host?: string;
  name: string;
  addresses?: string[];
};

const bonjourStubs = vi.hoisted(() => {
  const stops: Array<{ stop: () => void }> = [];
  let onUp: ((service: DiscoveryService) => void) | null = null;
  class FakeBonjour {
    publish(_record: unknown) {
      const handle = { stop: () => {} };
      stops.push(handle);
      return handle;
    }
    find(_types: unknown, callback: (service: DiscoveryService) => void) {
      onUp = callback;
      const handle = { stop: () => {} };
      stops.push(handle);
      return handle;
    }
    emit(service: DiscoveryService) {
      onUp?.(service);
    }
  }
  return { FakeBonjour, stops, emit: (service: DiscoveryService) => onUp?.(service) };
});

vi.mock("bonjour-service", () => ({
  Bonjour: bonjourStubs.FakeBonjour,
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-plugin-adv-"));
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

describe("mesh plugin with advertise enabled", () => {
  it("starts mDNS, reports peers in mesh_status, and stops everything on dispose", async () => {
    process.env.XDG_DATA_HOME = dir;
    try {
      const hooks = await MeshPlugin(fakeInput(), { port: 0 });
      const tools = hooks.tool ?? {};

      const offer = String(await tools.mesh_pair?.execute({}, ctx("s1")));
      const token = /token="([^"]+)"/.exec(offer)?.[1];
      const nodeId = /node_id="([^"]+)"/.exec(offer)?.[1];

      // Complete our own pairing so mesh_status has a paired peer to map.
      await tools.mesh_pair?.execute(
        { node_id: nodeId, token, address: "127.0.0.1:4399" },
        ctx("s1"),
      );

      const status = JSON.parse(String(await tools.mesh_status?.execute({}, ctx("s1")))) as {
        server: string;
        tailnet_addresses: string[];
        peers: Array<{ node_id: string; paired: boolean }>;
      };
      expect(status.server).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(status.tailnet_addresses).toEqual([]);
      expect(status.peers[0]?.paired).toBe(true);

      // Advertised + browsing: two stop handles total.
      expect(bonjourStubs.stops).toHaveLength(2);

      await hooks.dispose?.();
      expect(bonjourStubs.stops).toHaveLength(2);
    } finally {
      delete process.env.XDG_DATA_HOME;
    }
  });

  it("advertises static config addresses through mesh_status", async () => {
    process.env.XDG_DATA_HOME = dir;
    try {
      const hooks = await MeshPlugin(fakeInput(), { port: 0, addresses: ["10.8.0.2"] });
      const tools = hooks.tool ?? {};
      const status = JSON.parse(String(await tools.mesh_status?.execute({}, ctx("s1")))) as {
        tailnet_addresses: string[];
      };
      // Provider CLIs are absent here: only the static tunnel address survives.
      expect(status.tailnet_addresses).toEqual(["10.8.0.2"]);
      await hooks.dispose?.();
    } finally {
      delete process.env.XDG_DATA_HOME;
    }
  });

  it("onDiscovery stores foreign peers and ignores our own announcements", async () => {
    process.env.XDG_DATA_HOME = dir;
    try {
      const hooks = await MeshPlugin(fakeInput(), { port: 0, advertise: true });
      const tools = hooks.tool ?? {};
      const status = JSON.parse(String(await tools.mesh_status?.execute({}, ctx("s1")))) as {
        node_id: string;
      };

      bonjourStubs.emit({
        txt: { id: "foreign", fp: "ff" },
        host: "peer.local",
        name: "foreign",
        addresses: ["10.0.0.3"],
      });
      bonjourStubs.emit({ txt: { id: status.node_id, fp: "self" }, name: "self" });

      const after = JSON.parse(String(await tools.mesh_status?.execute({}, ctx("s1")))) as {
        peers: Array<{ node_id: string }>;
      };
      expect(after.peers.some((p) => p.node_id === "foreign")).toBe(true);
      expect(after.peers.some((p) => p.node_id === status.node_id)).toBe(false);

      await hooks.dispose?.();
    } finally {
      delete process.env.XDG_DATA_HOME;
    }
  });

  it("mesh_send matches peers by hostname too", async () => {
    const hooks = await MeshPlugin(fakeInput(), { dataDir: dir, port: 0, advertise: false });
    const tools = hooks.tool ?? {};

    // A keyless manual pairing is TLS-by-default with NO pinned key: sending
    // there would be silent TOFU on a token-authenticated channel — refused.
    await tools.mesh_pair?.execute(
      { node_id: "peer-by-host", token: "tok", address: "127.0.0.1:4399" },
      ctx("s1"),
    );
    // Hostname "manual" is stored for token pairings without a discovery source.
    const refused = await tools.mesh_send?.execute(
      { peer: "manual", subject: "s", body: "b" },
      ctx("s1"),
    );
    expect(refused).toContain("is TLS but has no pinned key");

    // Re-pairing the same node with its pinned key unblocks the send (the
    // hostname match still resolves it; unreachable: nothing listens there,
    // but the auth model let it on the wire).
    await tools.mesh_pair?.execute(
      { node_id: "peer-by-host", token: "tok2", address: "127.0.0.1:4399", pk: "dGVzdC1rZXk" },
      ctx("s1"),
    );
    const result = await tools.mesh_send?.execute(
      { peer: "manual", subject: "s", body: "b" },
      ctx("s1"),
    );
    expect(result).toContain("sent to peer-by-host");

    await hooks.dispose?.();
  });
});
