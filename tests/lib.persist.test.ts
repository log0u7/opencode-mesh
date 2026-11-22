import { describe, expect, it, vi } from "vitest";

import { createDurableStore, escapeSegment } from "../src/lib/persist.js";

describe("escapeSegment", () => {
  it("passes plain ids through unchanged", () => {
    expect(escapeSegment("opencode-mesh")).toBe("opencode-mesh");
    expect(escapeSegment("my_plugin.v2")).toBe("my_plugin.v2");
  });

  it("escapes scope and slash of a scoped npm id", () => {
    const escaped = escapeSegment("@log0u7/opencode-mesh");
    expect(escaped).not.toContain("@");
    expect(escaped).not.toContain("/");
    expect(escaped).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("escapes unsafe ids deterministically", () => {
    // Safe ids pass unchanged (existing host-stored data keeps its key);
    // unsafe ids escape every non-safe UTF-16 unit to _XXXX and double '_'
    // inside them, so "a<b" -> "a_003cb" while "a_b" (safe) stays "a_b".
    expect(escapeSegment("a_b")).toBe("a_b");
    expect(escapeSegment("a<b")).toBe("a_003cb");
  });

  it("maps distinct ids to distinct segments", () => {
    const ids = ["@log0u7/opencode-mesh", "@log0u7/opencode-mesh.tui", "opencode-mesh"];
    const segments = ids.map(escapeSegment);
    expect(new Set(segments).size).toBe(ids.length);
  });
});

describe("createDurableStore", () => {
  it("composes a host-safe key: plugin.<escaped id>.<name>", () => {
    const raw = { get: vi.fn(), set: vi.fn() };
    const store = createDurableStore(raw, "@log0u7/opencode-mesh", "mesh-sidebar");
    expect(store.key()).toMatch(/^plugin\.[a-zA-Z0-9._-]+\.mesh-sidebar$/);
    expect(store.key()).not.toContain("@");
    expect(store.key()).not.toContain("/");
  });

  it("round-trips a value and returns null when absent", async () => {
    const backing = new Map<string, unknown>();
    const raw = {
      get: async (key: string) => backing.get(key),
      set: async (key: string, value: unknown) => {
        backing.set(key, value);
      },
    };
    const store = createDurableStore(raw, "@log0u7/opencode-mesh", "mesh-sidebar");

    expect(await store.load<{ collapsed: boolean }>()).toBeNull();
    await store.save({ collapsed: true });
    expect(await store.load<{ collapsed: boolean }>()).toEqual({ collapsed: true });
  });

  it("survives a throwing host storage", async () => {
    const raw = {
      get: async () => {
        throw new Error("segment rejected");
      },
      set: async () => {
        throw new Error("segment rejected");
      },
    };
    const store = createDurableStore(raw, "@log0u7/opencode-mesh", "mesh-sidebar");
    await expect(store.load()).resolves.toBeNull();
    await expect(store.save({ collapsed: true })).rejects.toThrow("segment rejected");
  });
});
