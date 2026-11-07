import { describe, expect, it, vi } from "vitest";

import { Plugin } from "@opencode/plugin/tui";

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
});
