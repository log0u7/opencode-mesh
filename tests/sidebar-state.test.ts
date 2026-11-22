import { describe, expect, it, vi } from "vitest";

import type { Plugin } from "@opencode/plugin/tui";

import { createSidebarState } from "../src/sidebar-state.js";

type Storage = Plugin.Context["storage"];

describe("createSidebarState", () => {
  it("uses durable storage when the host accepts scoped plugin keys", async () => {
    const target = { collapsed: false };
    const store = vi.fn(
      () =>
        [
          target,
          vi.fn(async (mutation: (draft: { collapsed: boolean }) => void) => {
            mutation(target);
          }),
        ] as never,
    );
    const storage = { store, memory: vi.fn() } as unknown as Storage;

    const [state, mutate] = createSidebarState(storage);
    expect(store).toHaveBeenCalledWith("mesh-sidebar", { initial: { collapsed: false } });
    await mutate((draft) => {
      draft.collapsed = true;
    });
    expect(state.collapsed).toBe(true);
  });

  it("falls back to in-memory state when the host rejects scoped plugin keys", async () => {
    const storage = {
      store: vi.fn(() => {
        throw new TypeError(
          "Invalid storage segment: plugin.@log0u7/opencode-mesh.tui.mesh-sidebar",
        );
      }),
      memory: vi.fn(),
    } as unknown as Storage;

    const [state, mutate] = createSidebarState(storage);
    expect(state.collapsed).toBe(false);
    await expect(
      mutate((draft) => {
        draft.collapsed = true;
      }),
    ).resolves.toBeUndefined();
    expect(state.collapsed).toBe(true);
  });

  it("keeps fallback state reactive across repeated toggles", async () => {
    const storage = {
      store: vi.fn(() => {
        throw new TypeError(
          "Invalid storage segment: plugin.@log0u7/opencode-mesh.tui.mesh-sidebar",
        );
      }),
      memory: vi.fn(),
    } as unknown as Storage;

    const [state, mutate] = createSidebarState(storage);
    await mutate((draft) => {
      draft.collapsed = !draft.collapsed;
    });
    expect(state.collapsed).toBe(true);
    await mutate((draft) => {
      draft.collapsed = !draft.collapsed;
    });
    expect(state.collapsed).toBe(false);
  });

  it("persists toggles over RPC when the host rejects scoped plugin keys", async () => {
    const storage = {
      store: vi.fn(() => {
        throw new TypeError(
          "Invalid storage segment: plugin.@log0u7/opencode-mesh.tui.mesh-sidebar",
        );
      }),
      memory: vi.fn(),
    } as unknown as Storage;
    const set_sidebar = vi.fn(async (input: { collapsed: boolean }) => input);
    const mesh = { sidebar: async () => ({ collapsed: true }), set_sidebar };

    const [state, mutate] = createSidebarState(storage, mesh);
    // The persisted state (collapsed: true) is adopted once it arrives.
    await Promise.resolve();
    await Promise.resolve();
    expect(state.collapsed).toBe(true);

    await mutate((draft) => {
      draft.collapsed = false;
    });
    expect(state.collapsed).toBe(false);
    expect(set_sidebar).toHaveBeenCalledWith({ collapsed: false });
  });

  it("degrades to in-memory when the RPC fallback also fails", async () => {
    const storage = {
      store: vi.fn(() => {
        throw new TypeError("Invalid storage segment");
      }),
      memory: vi.fn(),
    } as unknown as Storage;
    const mesh = {
      sidebar: async () => {
        throw new Error("rpc unreachable");
      },
      set_sidebar: async () => {
        throw new Error("rpc unreachable");
      },
    };

    const [state, mutate] = createSidebarState(storage, mesh);
    await Promise.resolve();
    await Promise.resolve();
    await mutate((draft) => {
      draft.collapsed = true;
    });
    expect(state.collapsed).toBe(true);
  });
});
