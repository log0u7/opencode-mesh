import { createOpencodeClient } from "@opencode-ai/sdk/v2";

type WorktreeInfo = {
  name: string;
  branch?: string;
  directory: string;
};

// Minimal structural type over the generated v2 client: keeps tests mockable
// without dragging the full HeyApi surface into the type system.
export type WorktreeClient = {
  worktree: {
    create(parameters: { worktreeCreateInput?: { name?: string } }): Promise<unknown>;
    remove(parameters: { worktreeRemoveInput: { directory: string } }): Promise<unknown>;
  };
};

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
  return parsed.data as T;
}

export async function createWorkerWorktree(
  client: WorktreeClient,
  input: { name?: string },
): Promise<WorktreeInfo> {
  const envelope = await client.worktree.create({
    worktreeCreateInput: input.name !== undefined ? { name: input.name } : {},
  });
  return unwrap<WorktreeInfo>(envelope, "worktree create failed");
}

export async function removeWorkerWorktree(
  client: WorktreeClient,
  input: { directory: string },
): Promise<boolean> {
  const envelope = await client.worktree.remove({
    worktreeRemoveInput: { directory: input.directory },
  });
  return unwrap<boolean>(envelope, "worktree remove failed");
}
