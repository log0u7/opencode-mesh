import { createOpencodeClient } from "@opencode-ai/sdk/v2";

type WorktreeInfo = {
  name?: string;
  branch?: string;
  directory: string;
};

export type { WorktreeInfo };

type WorktreeCallOptions = { signal?: AbortSignal };

// Minimal structural type over the generated v2 client: keeps tests mockable
// without dragging the full HeyApi surface into the type system.
export type WorktreeClient = {
  worktree: {
    create(
      parameters: { worktreeCreateInput?: { name?: string } },
      options?: WorktreeCallOptions,
    ): Promise<unknown>;
    remove(
      parameters: { worktreeRemoveInput: { directory: string } },
      options?: WorktreeCallOptions,
    ): Promise<unknown>;
  };
};

// Structural mirror of the OpenCode 2.x in-process worktree domain
// (@opencode/client WorktreeApi): flat, project-scoped inputs and a
// directory-only result, unlike the 1.x REST envelope.
export type WorktreeDomain = {
  create(input: { projectID: string; name?: string }): Promise<{ directory: string }>;
  remove(input: { projectID: string; directory: string; force: boolean }): Promise<void>;
};

// Worktree setup/teardown shells out to git; a hung git process must not pin a
// tool call forever. The timeout only reaches the 1.x REST client, which
// forwards the signal to fetch; the 2.x in-process domain ignores it.
export const WORKTREE_TIMEOUT_MS = 15_000;

function callOptions(): WorktreeCallOptions {
  return { signal: AbortSignal.timeout(WORKTREE_TIMEOUT_MS) };
}

type ApiEnvelope = {
  data?: unknown;
  error?: { data?: { message?: string }; message?: string };
};

export type WorktreeFactory = (
  baseUrl: string,
  directory: string,
  fetchOverride?: typeof fetch,
) => WorktreeClient;

export const defaultWorktreeFactory: WorktreeFactory = (baseUrl, directory, fetchOverride) =>
  createOpencodeClient({
    baseUrl,
    directory,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  }) as unknown as WorktreeClient;

// In `opencode run` (in-process server) the plugin's own v1 client carries the
// custom fetch that routes to the embedded server; reuse it so our v2 client
// reaches /experimental/worktree without a real TCP listener. The v1 client
// stores the HeyApi core client as `_client` (TS-protected, reachable at runtime).
export function extractClientFetch(pluginClient: unknown): typeof fetch | undefined {
  try {
    const inner = (pluginClient as { _client?: { getConfig?: () => { fetch?: typeof fetch } } })
      ._client;
    const config = inner?.getConfig?.();
    const fetchFn = config?.fetch;
    return typeof fetchFn === "function" ? fetchFn : undefined;
  } catch {
    return undefined;
  }
}

function unwrap<T>(envelope: unknown, fallback: string): T {
  const parsed = (envelope ?? {}) as ApiEnvelope;
  if (parsed.error) {
    const detail = parsed.error.data?.message ?? parsed.error.message ?? fallback;
    throw new Error(`worktree API error: ${detail}`);
  }
  if (parsed.data === undefined) {
    throw new Error(`worktree API error: ${fallback} (empty response)`);
  }
  return parsed.data as T;
}

export async function createWorkerWorktree(
  client: WorktreeClient,
  input: { name?: string },
): Promise<WorktreeInfo> {
  const envelope = await client.worktree.create(
    {
      worktreeCreateInput: input.name !== undefined ? { name: input.name } : {},
    },
    callOptions(),
  );
  const info = unwrap<WorktreeInfo>(envelope, "worktree create failed");
  if (
    typeof info !== "object" ||
    info === null ||
    typeof info.directory !== "string" ||
    info.directory === ""
  ) {
    throw new Error("worktree API error: worktree create failed (response had no directory)");
  }
  return info;
}

export async function removeWorkerWorktree(
  client: WorktreeClient,
  input: { directory: string },
): Promise<boolean> {
  const envelope = await client.worktree.remove(
    { worktreeRemoveInput: { directory: input.directory } },
    callOptions(),
  );
  const removed = unwrap<boolean>(envelope, "worktree remove failed");
  if (typeof removed !== "boolean") {
    throw new Error("worktree API error: worktree remove failed (response was not a boolean)");
  }
  return removed;
}

// OpenCode 2.x hands the plugin an in-process worktree domain whose methods
// take FLAT, project-scoped inputs and resolve the payload directly instead of
// the `{ worktreeCreateInput }` / `{ data, error }` REST envelope the tools are
// written against (see issue #29). Wrap it back into the same WorktreeClient
// shape so both host generations share one code path.
export function v2WorktreeDomainClient(domain: WorktreeDomain, projectID: string): WorktreeClient {
  return {
    worktree: {
      create: async (parameters) => {
        const name = parameters.worktreeCreateInput?.name;
        const info = await domain.create({
          projectID,
          ...(name !== undefined ? { name } : {}),
        });
        return { data: info };
      },
      // The domain resolves void on success (it throws otherwise); surface that
      // as the v1 boolean so removeWorkerWorktree sees a successful removal.
      remove: async (parameters) => {
        await domain.remove({
          projectID,
          directory: parameters.worktreeRemoveInput.directory,
          force: true,
        });
        return { data: true };
      },
    },
  };
}
