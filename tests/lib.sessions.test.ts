import { describe, expect, it, vi } from "vitest";

import { startSessionLister } from "../src/lib/sessions.js";

function page(ids: string[], cursor?: { next?: string | null }) {
  return {
    data: ids.map((id) => ({ id })),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

describe("session lister", () => {
  it("snapshots the paginated host list and chains cursors", async () => {
    const calls: Array<{ cursor?: string }> = [];
    const list = vi.fn(async (input: { cursor?: string }) => {
      calls.push(input);
      if (input.cursor === undefined) {
        return page(["a"], { next: "cursor-2" });
      }
      return page(["b"]);
    });

    const lister = startSessionLister({ list, intervalMs: 60_000 });
    await vi.waitFor(() => {
      expect(lister.has("a")).toBe(true);
      expect(lister.has("b")).toBe(true);
    });

    // Both pages walked, the cursor chained to the second call.
    expect(list).toHaveBeenCalledTimes(2);
    expect(calls[1]?.cursor).toBe("cursor-2");
    expect(lister.has("unknown")).toBe(false);

    lister.stop();
  });

  it("excludes archived sessions from the live set", async () => {
    const list = vi.fn(async () => ({
      data: [{ id: "live" }, { id: "dead", time: { archived: 123 } }],
    }));
    const lister = startSessionLister({ list, intervalMs: 60_000 });

    await vi.waitFor(() => {
      expect(lister.has("live")).toBe(true);
    });
    expect(lister.has("dead")).toBe(false);

    lister.stop();
  });

  it("serves the cached snapshot between refreshes (interval TTL)", async () => {
    const list = vi.fn(async () => page(["s1"]));
    const lister = startSessionLister({ list, intervalMs: 30 });

    await vi.waitFor(() => {
      expect(list).toHaveBeenCalled();
    });
    const afterFirst = list.mock.calls.length;
    expect(lister.has("s1")).toBe(true);

    // No list call until the next interval fires; the snapshot is cached.
    await vi.waitFor(
      () => {
        expect(list.mock.calls.length).toBeGreaterThan(afterFirst);
      },
      { timeout: 500 },
    );

    lister.stop();
  });

  it("keeps the previous snapshot when a refresh fails", async () => {
    let calls = 0;
    const onError = vi.fn();
    const list = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return page(["s1"]);
      throw new Error("host gone");
    });
    const lister = startSessionLister({ list, intervalMs: 20, onError });

    await vi.waitFor(() => {
      expect(lister.has("s1")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    // Stale liveness is kept: the wake may prompt a dead session and the
    // host refuses it — that beats starving a live one.
    expect(lister.has("s1")).toBe(true);

    lister.stop();
  });

  it("stops refreshing on stop() and tolerates a double stop", async () => {
    const list = vi.fn(async () => page(["s1"]));
    const lister = startSessionLister({ list, intervalMs: 20 });

    await vi.waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });
    lister.stop();
    lister.stop();

    const after = list.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(list.mock.calls.length).toBe(after);
  });
});
