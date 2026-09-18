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

export type WorktreeFactory = (baseUrl: string, directory: string) => WorktreeClient;

export const defaultWorktreeFactory: WorktreeFactory = (baseUrl, directory) =>
  createOpencodeClient({
    baseUrl,
    directory,
  }) as unknown as WorktreeClient;

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
