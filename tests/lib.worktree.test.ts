import { describe, expect, it, vi } from "vitest";

import {
  createWorkerWorktree,
  isSourceDirectoryError,
  removeWorkerWorktree,
  extractClientFetch,
  v2WorktreeDomainClient,
  type WorktreeClient,
} from "../src/lib/worktree.js";
import { defaultWorktreeFactory } from "../src/plugin.js";

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

    expect(client.worktree.create).toHaveBeenCalledWith(
      { worktreeCreateInput: { name: "task" } },
      expect.objectContaining({ signal: expect.anything() }),
    );
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

    expect(client.worktree.create).toHaveBeenCalledWith(
      { worktreeCreateInput: {} },
      expect.objectContaining({ signal: expect.anything() }),
    );
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

    expect(client.worktree.remove).toHaveBeenCalledWith(
      { worktreeRemoveInput: { directory: "/data/worktree/p1/task" } },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result).toBe(true);
  });

  it("throws a readable error on API error payloads", async () => {
    const client = fakeClient({ data: true }, { error: { data: { message: "worktree busy" } } });

    await expect(removeWorkerWorktree(client, { directory: "/x" })).rejects.toThrow(
      "worktree busy",
    );
  });
});

describe("response validation", () => {
  it("throws when the create response carries no data", async () => {
    const client = fakeClient({});

    await expect(createWorkerWorktree(client, {})).rejects.toThrow("empty response");
  });

  it("throws when the create response has no directory", async () => {
    const client = fakeClient({ data: { name: "task" } });

    await expect(createWorkerWorktree(client, {})).rejects.toThrow("no directory");
  });

  it("throws when the remove response is not a boolean", async () => {
    const client = fakeClient({ data: { ok: true } });

    await expect(removeWorkerWorktree(client, { directory: "/x" })).rejects.toThrow(
      "not a boolean",
    );
  });
});

describe("v2 worktree domain adapter", () => {
  it("calls the flat, project-scoped domain and re-wraps the result", async () => {
    const domain = {
      create: vi.fn(async () => ({ directory: "/wt/task" })),
      remove: vi.fn(async () => {}),
    };
    const client = v2WorktreeDomainClient(domain, "proj-1");

    const info = await createWorkerWorktree(client, { name: "task" });
    expect(domain.create).toHaveBeenCalledWith({ projectID: "proj-1", name: "task" });
    expect(info).toEqual({ directory: "/wt/task" });

    const removed = await removeWorkerWorktree(client, { directory: "/wt/task" });
    expect(domain.remove).toHaveBeenCalledWith({
      projectID: "proj-1",
      directory: "/wt/task",
      force: true,
    });
    expect(removed).toBe(true);
  });

  it("omits the name when the server should generate one", async () => {
    const domain = {
      create: vi.fn(async () => ({ directory: "/wt/random" })),
      remove: vi.fn(async () => {}),
    };
    const client = v2WorktreeDomainClient(domain, "proj-1");

    await createWorkerWorktree(client, {});

    expect(domain.create).toHaveBeenCalledWith({ projectID: "proj-1" });
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

// The 0.24.7 live bug: a headless host (`opencode serve`) never runs worktree
// discovery, its worktree table holds no row for the project's source, and
// create dies with the bare tagged error Worktree.SourceDirectoryNotFoundError
// (empty message). createWorkerWorktree now refreshes once and retries, then
// ships an explicit failure when the source is still missing.
describe("source directory discovery (0.24.7)", () => {
  // The Effect tagged-error shape: _tag set, message EMPTY.
  function taggedSourceError(): Error {
    const error = new Error("");
    (error as unknown as { _tag: string })._tag = "Worktree.SourceDirectoryNotFoundError";
    error.name = "Worktree.SourceDirectoryNotFoundError";
    return error;
  }

  it("runs one discovery refresh and retries when create dies with the tagged source error", async () => {
    let discovered = false;
    const domain = {
      create: vi.fn(async () => {
        if (!discovered) throw taggedSourceError();
        return { directory: "/wt/task" };
      }),
      remove: vi.fn(async () => {}),
      refresh: vi.fn(async () => {
        discovered = true;
        return undefined;
      }),
    };
    const client = v2WorktreeDomainClient(domain, "proj-1");

    const info = await createWorkerWorktree(client, { name: "task" });

    expect(domain.refresh).toHaveBeenCalledWith({ projectID: "proj-1" });
    expect(domain.create).toHaveBeenCalledTimes(2);
    expect(info.directory).toBe("/wt/task");
  });

  it("keeps a clean failure path on a client without any refresh (1.x REST shape)", async () => {
    const client = {
      worktree: {
        create: vi.fn(async () => {
          throw taggedSourceError();
        }),
        remove: vi.fn(async () => ({ data: true })),
      },
    } as unknown as WorktreeClient;

    await expect(createWorkerWorktree(client, {})).rejects.toThrow(
      "no source directory registered on this host",
    );
    // No discovery endpoint on this generation: the retry ran, then the
    // explicit failure replaced the bare tagged error.
    expect(client.worktree.create).toHaveBeenCalledTimes(2);
  });

  it("keeps the explicit failure name for downstream refusal mapping", async () => {
    const client = {
      worktree: {
        create: vi.fn(async () => {
          throw taggedSourceError();
        }),
        remove: vi.fn(async () => ({ data: true })),
      },
    } as unknown as WorktreeClient;

    await expect(createWorkerWorktree(client, {})).rejects.toMatchObject({
      name: "Worktree.SourceDirectoryNotFoundError",
    });
  });

  it("does not refresh or retry for unrelated errors", async () => {
    const domain = {
      create: vi.fn(async () => {
        throw new Error("git exploded");
      }),
      remove: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    };
    const client = v2WorktreeDomainClient(domain, "proj-1");

    await expect(createWorkerWorktree(client, {})).rejects.toThrow("git exploded");
    expect(domain.refresh).not.toHaveBeenCalled();
    expect(domain.create).toHaveBeenCalledTimes(1);
  });

  it("passes a destination directory override through the v2 adapter", async () => {
    const domain = {
      create: vi.fn(async () => ({ directory: "/srv/spawns/task" })),
      remove: vi.fn(async () => {}),
    };
    const client = v2WorktreeDomainClient(domain, "proj-1");

    await createWorkerWorktree(client, { name: "task", directory: "/srv/spawns" });

    expect(domain.create).toHaveBeenCalledWith({
      projectID: "proj-1",
      name: "task",
      directory: "/srv/spawns",
    });
  });

  it("detects the source error on all three surfaces (tag, name, message)", async () => {
    const tagged = taggedSourceError();
    expect(isSourceDirectoryError(tagged)).toBe(true);

    const byName = new Error("");
    byName.name = "Worktree.SourceDirectoryNotFoundError";
    expect(isSourceDirectoryError(byName)).toBe(true);

    // The 1.x REST path serializes the tag into the message.
    const byMessage = new Error("worktree API error: Worktree.SourceDirectoryNotFoundError");
    expect(isSourceDirectoryError(byMessage)).toBe(true);

    // The human-readable server message carries no tag: not detected, no retry.
    const humanMessage = new Error(
      "worktree API error: Cannot create a worktree from /x: it is not a checkout of this project",
    );
    expect(isSourceDirectoryError(humanMessage)).toBe(false);

    expect(isSourceDirectoryError(new Error("git exploded"))).toBe(false);
    expect(isSourceDirectoryError("not an error")).toBe(false);
    expect(isSourceDirectoryError(undefined)).toBe(false);
  });
});
