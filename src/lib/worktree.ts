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
      parameters: { worktreeCreateInput?: { name?: string; directory?: string } },
      options?: WorktreeCallOptions,
    ): Promise<unknown>;
    remove(
      parameters: { worktreeRemoveInput: { directory: string } },
      options?: WorktreeCallOptions,
    ): Promise<unknown>;
    /** Optional discovery refresh (v2 in-process domain only: the 1.x REST
     * client has no such endpoint). */
    refresh?(
      input: { worktreeRefreshInput?: { projectID?: string } },
      options?: WorktreeCallOptions,
    ): Promise<unknown>;
  };
};

// Structural mirror of the OpenCode 2.x in-process worktree domain
// (@opencode/client WorktreeApi): flat, project-scoped inputs and a
// directory-only result, unlike the 1.x REST envelope.
export type WorktreeDomain = {
  create(input: {
    projectID: string;
    name?: string;
    /** Destination base for the worktree (spawnWorktreeBase). */
    directory?: string;
  }): Promise<{ directory: string }>;
  remove(input: { projectID: string; directory: string; force: boolean }): Promise<void>;
  /** Discovery refresh: registers the project's source directory in the
   * host's worktree table. Optional: tests and exotic hosts may omit it. */
  refresh?(input: { projectID: string }): Promise<unknown>;
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
    // An empty message string is no message: fall through to the next source,
    // then the fallback, or the cause ships empty (the 0.24.5 lesson).
    const detail =
      [parsed.error.data?.message, parsed.error.message].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      ) ?? fallback;
    throw new Error(`worktree API error: ${detail}`);
  }
  if (parsed.data === undefined) {
    throw new Error(`worktree API error: ${fallback} (empty response)`);
  }
  return parsed.data as T;
}

export async function createWorkerWorktree(
  client: WorktreeClient,
  input: { name?: string; directory?: string },
): Promise<WorktreeInfo> {
  const createInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.directory !== undefined ? { directory: input.directory } : {}),
  };
  const attempt = (): Promise<unknown> =>
    client.worktree.create({ worktreeCreateInput: createInput }, callOptions());
  let envelope: unknown;
  try {
    envelope = await attempt();
  } catch (error) {
    if (!isSourceDirectoryError(error)) {
      throw error;
    }
    // First sighting (the 0.24.7 live bug): a headless host (`opencode
    // serve`) never browses worktrees, so its worktree table holds no row for
    // the project's source directory and the tagged error
    // Worktree.SourceDirectoryNotFoundError ships with no message. One
    // discovery refresh registers the source (row.worktree + existing
    // checkouts); the same create then succeeds. Best effort: a failing
    // refresh keeps the original failure path.
    await client.worktree.refresh
      ?.call(client.worktree, { worktreeRefreshInput: {} }, callOptions())
      .catch(() => undefined);
    try {
      envelope = await attempt();
    } catch (retryError) {
      throw isSourceDirectoryError(retryError) ? sourceDirectoryFailure() : retryError;
    }
  }
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

// The host's project source is missing or unregistered even after discovery:
// an explicit, greppable message instead of the bare tagged error (whose
// empty message reached the parent as "…NotFoundError (no message)").
function sourceDirectoryFailure(): Error {
  const error = new Error(
    "worktree create failed: no source directory registered on this host — open the project once so worktree discovery registers it",
  );
  error.name = "Worktree.SourceDirectoryNotFoundError";
  return error;
}

// OpenCode 2.x throws this as an Effect tagged error: `_tag` set, message
// EMPTY (the 0.24.7 live sighting). The 1.x REST path serializes the cause
// into the message instead. All three surfaces are checked so the detection
// survives both host generations and the translated error above.
export function isSourceDirectoryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const tag = (error as { _tag?: string })._tag ?? "";
  return (
    tag.includes("SourceDirectoryNotFound") ||
    error.name.includes("SourceDirectoryNotFound") ||
    error.message.includes("SourceDirectoryNotFound")
  );
}

// Same Effect tagged-error shape: the retargeted project has no row on this
// host (the peer's opencode never resolved it, 0.24.8). The v2 domain rejects
// with the raw tagged error; a REST surface serializes it as
// "ProjectNotFoundError" / "Project not found: …" — all three are covered.
export function isProjectNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const hay = `${(error as { _tag?: string })._tag ?? ""} ${error.name} ${error.message}`;
  return (
    hay.includes("Project.NotFound") ||
    hay.includes("ProjectNotFoundError") ||
    hay.includes("Project not found")
  );
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
  // Fake host contexts in tests may omit the worktree domain entirely; the
  // refresh capability is probed lazily so constructing the client stays safe.
  const discovery = domain?.refresh;
  return {
    worktree: {
      create: async (parameters) => {
        const name = parameters.worktreeCreateInput?.name;
        const directory = parameters.worktreeCreateInput?.directory;
        const info = await domain.create({
          projectID,
          ...(name !== undefined ? { name } : {}),
          ...(directory !== undefined ? { directory } : {}),
        });
        return { data: info };
      },
      // Discovery refresh (0.24.7): the domain is project-scoped, so the
      // wrapper injects its own projectID whatever the caller passes.
      ...(discovery !== undefined
        ? {
            refresh: async () => {
              await discovery({ projectID });
              return { data: true };
            },
          }
        : {}),
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
