import { describe, expect, it, vi } from "vitest";

import {
  createWorkerWorktree,
  removeWorkerWorktree,
  extractClientFetch,
  defaultWorktreeFactory,
  type WorktreeClient,
} from "../src/lib/worktree.js";

function fakeClient(createResult: unknown, removeResult: unknown = createResult) {
  return {
    worktree: {
      create: vi.fn(async () => createResult),
      remove: vi.fn(async () => removeResult),
      list: vi.fn(async () => ({ data: [] })),
      reset: vi.fn(async () => ({ data: true })),
    },
  } as unknown as WorktreeClient;
}

describe("createWorkerWorktree", () => {
  it("calls the v2 client with the worktree input and unwraps data", async () => {
    const client = fakeClient({
      data: { name: "task", branch: "opencode/task", directory: "/data/worktree/p1/task" },
    });

    const info = await createWorkerWorktree(client, { name: "task" });

    expect(client.worktree.create).toHaveBeenCalledWith({ worktreeCreateInput: { name: "task" } });
    expect(info).toEqual({
      name: "task",
      branch: "opencode/task",
      directory: "/data/worktree/p1/task",
    });
  });

  it("lets the server generate a random name when none is given", async () => {
    const client = fakeClient({
      data: { name: "random", directory: "/data/worktree/p1/random" },
    });

    await createWorkerWorktree(client, {});

    expect(client.worktree.create).toHaveBeenCalledWith({ worktreeCreateInput: {} });
  });

  it("throws a readable error on API error payloads", async () => {
    const client = fakeClient({
      error: { name: "WorktreeCreateFailedError", data: { message: "git failed" } },
    });

    await expect(createWorkerWorktree(client, {})).rejects.toThrow("git failed");
  });
});

describe("removeWorkerWorktree", () => {
  it("calls remove with the directory and unwraps data", async () => {
    const client = fakeClient({ data: true }, { data: true });

    const result = await removeWorkerWorktree(client, { directory: "/data/worktree/p1/task" });

    expect(client.worktree.remove).toHaveBeenCalledWith({
      worktreeRemoveInput: { directory: "/data/worktree/p1/task" },
    });
    expect(result).toBe(true);
  });

  it("throws a readable error on API error payloads", async () => {
    const client = fakeClient({ data: true }, { error: { data: { message: "worktree busy" } } });

    await expect(removeWorkerWorktree(client, { directory: "/x" })).rejects.toThrow(
      "worktree busy",
    );
  });
});

describe("in-process fetch extraction", () => {
  it("extracts the custom fetch from the plugin v1 client (_client)", () => {
    const customFetch = async () => new Response("{}");
    const pluginClient = { _client: { getConfig: () => ({ fetch: customFetch }) } };

    expect(extractClientFetch(pluginClient)).toBe(customFetch);
  });

  it("returns undefined when the client exposes no config fetch", () => {
    expect(extractClientFetch({})).toBeUndefined();
    expect(extractClientFetch({ _client: { getConfig: () => ({}) } })).toBeUndefined();
  });
});

describe("defaultWorktreeFactory fetch pass-through", () => {
  it("passes the fetch override to the v2 client when provided", () => {
    const customFetch: typeof globalThis.fetch = async () => new Response("{}");
    const factory = defaultWorktreeFactory as unknown as (
      baseUrl: string,
      directory: string,
      fetchOverride?: typeof globalThis.fetch,
    ) => unknown;
    // The real factory builds a HeyApi client; we only assert it constructs
    // without throwing and that the fetch override is accepted (no network).
    const client = factory("http://127.0.0.1:1", "/tmp", customFetch) as WorktreeClient;
    expect(typeof client.worktree.create).toBe("function");
  });
});
