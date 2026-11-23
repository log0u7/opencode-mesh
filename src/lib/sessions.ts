// Live session discovery for the wake loop. Since opencode 2.4.0 the TUI
// plugin slot can fail to load (its @opentui peer range), which stopped the
// tab-render bind and left the old sessionsSeen set empty: idle sessions were
// never woken. The setup context exposes the host's paginated session list
// (ctx.session.list, GET /session — @opencode/plugin >= 2.3), so liveness no
// longer depends on the TUI: one snapshot every interval, chained cursors,
// archived sessions excluded. sessionsSeen (tool calls + TUI bind) stays as a
// complement, never the sole source.

export type SessionListPage = {
  data: Array<{ id: string; time?: { archived?: number } }>;
  cursor?: { next?: string | null };
};

export type SessionListerOptions = {
  /** The host's paginated session list (ctx.session.list). Absent on hosts
   * that predate it: the lister then knows nothing and wake liveness falls
   * back to sessionsSeen alone. */
  list?: (input: { cursor?: string }) => Promise<SessionListPage>;
  /** Milliseconds between snapshots. Default 10000. */
  intervalMs?: number;
  /** A failed snapshot keeps the previous one (stale liveness is harmless:
   * the wake then prompts a dead session and the host refuses it). */
  onError?: (error: unknown) => void;
};

export type SessionLister = {
  /** Was this session live on this host at the last successful snapshot? */
  has(sessionID: string): boolean;
  stop(): void;
};

export const DEFAULT_SESSION_LIST_INTERVAL_MS = 10_000;
/** Hard cap on cursor chain walks: a buggy host cursor must not spin forever. */
const MAX_PAGES = 100;

export function startSessionLister(options: SessionListerOptions): SessionLister {
  const interval = options.intervalMs ?? DEFAULT_SESSION_LIST_INTERVAL_MS;
  const live = new Set<string>();
  let stopped = false;

  const refresh = async (): Promise<void> => {
    if (!options.list) return;
    const snapshot = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await options.list(cursor === undefined ? {} : { cursor });
      for (const session of res.data) {
        if (session.time?.archived === undefined) snapshot.add(session.id);
      }
      const next = res.cursor?.next;
      if (typeof next !== "string" || next.length === 0) break;
      cursor = next;
    }
    live.clear();
    for (const id of snapshot) live.add(id);
  };

  const tick = (): void => {
    if (stopped) return;
    void refresh().catch((error) => options.onError?.(error));
  };

  tick();
  const timer = setInterval(tick, interval);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    has: (sessionID) => live.has(sessionID),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
