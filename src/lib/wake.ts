import type { MeshDb } from "./db.js";
import { mailboxBySession, unreadBoxCount } from "./mail.js";

// Wake loop: polls this session's mailbox in the shared local database and,
// when unread mail appears, injects a prompt into THIS session via the host's
// session.prompt API (OpenCode 2.x: ctx.session.prompt, delivery "queue").
// This is what makes an idle agent react to incoming mail without a human
// relaying the message. Polling a local SQLite read every few seconds is
// negligible; it replaces the need for a push channel between the mesh server
// process and each plugin process.

export type WakeOptions = {
  db: MeshDb;
  /** The host session this plugin instance belongs to. A provider is allowed:
   * the v2 adapter only learns its sessionID at the first tool call. */
  sessionID: string | (() => string | null);
  /** Inject a prompt into the session (ctx.session.prompt). */
  prompt: (text: string) => Promise<unknown>;
  /** Poll interval in ms. 0 disables the loop. Default 5000. */
  intervalMs?: number;
  /** Minimum delay between two consecutive wake prompts. Default 60000. */
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
  let lastPromptAt = 0;
  let lastUnread = 0;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const sessionID =
        typeof options.sessionID === "function" ? options.sessionID() : options.sessionID;
      if (!sessionID) return;
      const box = mailboxBySession(options.db, sessionID);
      if (!box) return;
      const unread = unreadBoxCount(options.db, box.name);
      if (unread === 0) {
        lastUnread = 0;
        return;
      }
      // Prompt only on new mail (count grew) and outside the cooldown, so an
      // agent that stays idle in front of unread mail is reminded, not spammed.
      const now = Date.now();
      const isNew = unread > lastUnread;
      lastUnread = unread;
      if (!isNew && now - lastPromptAt < (options.cooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS)) {
        return;
      }
      lastPromptAt = now;
      await options.prompt(
        `mesh: ${unread} unread message(s) for mailbox "${box.name}". Run mesh_inbox to read them.`,
      );
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
