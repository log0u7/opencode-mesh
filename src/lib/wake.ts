import type { MeshDb } from "./db.js";
import { listMailboxes, unreadBoxCount } from "./mail.js";

// Wake loop: polls every registered mailbox in the shared local database and,
// when unread mail appears in a box whose session lives on THIS host, injects
// a prompt into that session via the host's session.prompt API (OpenCode 2.x:
// ctx.session.prompt). One opencode process (notably `opencode serve`) hosts
// MANY sessions: the loop is host-wide, per-mailbox cooldown — not tied to a
// single "current" session. This is what makes idle agents react to incoming
// mail without a human relaying the message. Polling a local SQLite read every
// few seconds is negligible; it replaces the need for a push channel between
// the mesh server process and each plugin process.

export type WakeOptions = {
  db: MeshDb;
  /** Does this host process own the session? (ctx.session.get: defined = the
   * session lives here; mailboxes bound to foreign/dead sessions are skipped —
   * their own host wakes them.) */
  sessionExists: (sessionID: string) => Promise<boolean>;
  /** Inject a prompt into a session (ctx.session.prompt). */
  prompt: (sessionID: string, text: string) => Promise<unknown>;
  /** Poll interval in ms. 0 disables the loop. Default 5000. */
  intervalMs?: number;
  /** Minimum delay between two consecutive wake prompts per mailbox. Default 60000. */
  cooldownMs?: number;
};

export type WakeHandle = {
  stop(): void;
};

export const DEFAULT_WAKE_INTERVAL_MS = 5000;
export const DEFAULT_WAKE_COOLDOWN_MS = 60000;

export function startWakeLoop(options: WakeOptions): WakeHandle {
  const interval = options.intervalMs ?? DEFAULT_WAKE_INTERVAL_MS;
  if (interval <= 0) {
    return { stop: () => {} };
  }
  const lastPromptAt = new Map<string, number>();
  const lastUnread = new Map<string, number>();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const now = Date.now();
      for (const box of listMailboxes(options.db)) {
        const unread = unreadBoxCount(options.db, box.name);
        const previous = lastUnread.get(box.name) ?? 0;
        if (unread === 0) {
          lastUnread.delete(box.name);
          continue;
        }
        lastUnread.set(box.name, unread);
        // Prompt only on new mail (count grew) and outside the per-mailbox
        // cooldown, so an agent idle in front of unread mail is reminded,
        // not spammed.
        if (
          unread <= previous &&
          now - (lastPromptAt.get(box.name) ?? 0) < (options.cooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS)
        ) {
          continue;
        }
        const bound =
          typeof box.session_id === "string" && box.session_id.length > 0
            ? await options.sessionExists(box.session_id)
            : false;
        if (!bound) {
          // Not this host's session (foreign host, dead session): its own
          // host wakes it, or a future bind/registration re-binds it here.
          continue;
        }
        lastPromptAt.set(box.name, now);
        await options.prompt(
          box.session_id,
          `mesh: ${unread} unread message(s) for mailbox "${box.name}". Run mesh_inbox to read them.`,
        );
      }
    } catch {
      // A failed tick (db busy, host rejecting a prompt) is retried next tick.
    }
  };

  const timer = setInterval(() => void tick(), interval);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
