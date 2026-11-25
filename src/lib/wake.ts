import { randomUUID } from "node:crypto";

import type { MeshDb } from "./db.js";
import {
  deliverMessage,
  listMailboxes,
  mailboxByName,
  unreadBoxCount,
  wakeBoxStats,
  withTransaction,
} from "./mail.js";
import { pluginWarn, storeLogDir } from "./plugin-log.js";

// The host's mid-turn signal. The live wire (opencode v2, generated client
// types) carries BOTH families under `data`: session.execution.* (durable
// event-store events) with data.sessionID, and session.status with
// data.sessionID + data.status.type busy/retry/idle. 0.27.1 trusted a stale
// SDK generation that showed `properties` instead of `data` for
// session.status — the tracker keyed on a path the bus never sends, so the
// guard stayed off and the phantom-unread class relapsed. 0.27.3 reads data
// first (the real wire), properties second (older SDK gens).
export type HostEvent = {
  type?: unknown;
  data?: { sessionID?: unknown; status?: { type?: unknown; [key: string]: unknown } };
  properties?: { sessionID?: unknown; status?: { type?: unknown; [key: string]: unknown } };
};

const RUNNING_START = new Set([
  "session.status:busy",
  "session.status:retry",
  "session.execution.started",
]);
const RUNNING_END = new Set([
  "session.status:idle",
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

export function createExecutionTracker(backing = new Set<string>()) {
  return {
    /** Feed every host event; unknown shapes are ignored. */
    observe(event: HostEvent): void {
      const type = typeof event?.type === "string" ? event.type : "";
      const sessionID = event.data?.sessionID ?? event.properties?.sessionID;
      if (typeof sessionID !== "string" || sessionID.length === 0) return;
      const statusType = event.data?.status?.type ?? event.properties?.status?.type;
      const signal =
        type === "session.status" && typeof statusType === "string"
          ? `session.status:${statusType}`
          : type;
      if (RUNNING_START.has(signal)) backing.add(sessionID);
      else if (RUNNING_END.has(signal)) backing.delete(sessionID);
    },
    isRunning(sessionID: string): boolean {
      return backing.has(sessionID);
    },
  };
}

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
  /** Does the session live here? True when the host's session list contains
   * it (lib/sessions.ts) OR this instance saw it since boot (a mesh tool call
   * or a TUI bind). Session records outlive their process: a durable record
   * is not a live session. Mailboxes bound to unknown sessions are skipped —
   * the agent's first turn re-registers (AGENTS.md) and re-binds the box, and
   * only then the wake loop takes it over. */
  sessionKnown: (sessionID: string) => boolean;
  /** Is the session mid-turn? Queued prompts would fire with a stale unread
   * count after the turn acked the mail (false positives). Optional: when
   * absent, every existing session is treated as idle. */
  sessionRunning?: (sessionID: string) => boolean;
  /** Inject a prompt into a session (ctx.session.prompt). The third argument
   * is a generated messageID: the host server honors an explicit id
   * (input.id ?? create) and the transport can retry the call — with a
   * stable id every retry reconciles to the same message ('existing') and no
   * ghost turn re-fires (the 4s-spaced phantom deliveries, root-caused
   * 2026-11-25). */
  prompt: (sessionID: string, text: string, messageID: string) => Promise<unknown>;
  /** Poll interval in ms. 0 disables the loop. Default 5000. */
  intervalMs?: number;
  /** Minimum delay between two consecutive wake prompts per mailbox. Default 60000. */
  cooldownMs?: number;
  /** Consecutive undrained prompts before giving up on a box. Default 3. */
  maxUndrainedPrompts?: number;
  /** Wake on pool broadcasts too (default false, token economy 0.16.0):
   * only DIRECT mail wakes the session; fanouted pool mail (origin_id differs
   * from the local id) is read on natural turns or via mesh_journal. Since
   * 0.17.0 a sender can also flag a single broadcast wake:true (per-message
   * Slack-style mention); this option wakes EVERY broadcast. */
  wakePools?: boolean;
};

export type WakeHandle = {
  stop(): void;
};

export const DEFAULT_WAKE_INTERVAL_MS = 5000;
export const DEFAULT_WAKE_COOLDOWN_MS = 60000;
/** Consecutive prompts without the box being drained before the wake gives
 * up on it: the binding is wrong (the bound session never reads this box) —
 * re-register in the owning session's tab. */
export const MAX_UNDRAINED_PROMPTS = 3;
/** How long a wake prompt may stay "in flight" before the collapse gate
 * releases on its own: a turn shorter than the poll interval can deliver the
 * prompt between two ticks (the busy event goes unobserved) — without the
 * TTL the gate would mute the session forever. Worst case after expiry: one
 * duplicate flash per TTL, still bounded by the fatigue guard. */
export const PROMPT_GATE_TTL_MS = 120_000;
/** Consecutive failed ticks before the loop backs off: a busy database (the
 * busy_timeout is 5s with several processes on mesh.db) or a prompt-refusing
 * host used to STOP the loop forever (the boxes starved silently — the warns
 * went to /dev/null). The loop now backs off exponentially (capped) and
 * recovers on the first successful tick. */
export const MAX_TICK_FAILURES = 5;
/** The backoff ceiling: the tick interval never exceeds this between
 * attempts, however many failures stack up. */
export const TICK_BACKOFF_CAP_MS = 300_000;
/** How long a fatigued box stays muted before the loop reminds it again: the
 * mute would otherwise starve the box forever (the purge requires a drain,
 * the drain requires a prompt — a session that never reads never unmutes).
 * One reminder per TTL worst case. */
export const FATIGUE_MUTE_TTL_MS = 600_000;
/** The mute TTL doubles per consecutive mute cycle (10 -> 20 -> 40 -> 80 min
 * cap): a blocked or distracted agent that never drains must not cost a full
 * turn every 10 minutes forever (6 turns/hour under the flat TTL). */
export const FATIGUE_MUTE_MAX_MS = 4_800_000;
/** After this many consecutive mute cycles without a drain, the wake alerts
 * the orchestrator mailbox (when it exists on this node) instead of letting
 * the box starve silently. One alert per starvation period (cleared on the
 * first drain). */
export const ESCALATE_AFTER_MUTE_CYCLES = 3;
/** The escalation target: the lead's mailbox, resolved in the local registry. */
export const ESCALATE_TO = "orq";

/** The active escalation (0.30.0): a box muted through ESCALATE_AFTER_MUTE_CYCLES
 * consecutive cycles without a drain alerts the orchestrator mailbox (when it
 * exists on this node) — the human-chaired loop then decides. ONE alert per
 * starvation period (the flag clears on the first drain); the wake itself
 * never re-prompts the starved box faster than its backoff. */
function escalateBox(
  db: MeshDb,
  box: string,
  cycles: number,
  subject: string | null,
  escalated: Map<string, number>,
): void {
  if (escalated.has(box)) return;
  escalated.set(box, cycles);
  if (!mailboxByName(db, ESCALATE_TO)) return;
  deliverMessage(db, {
    from: "mesh-wake",
    to_box: ESCALATE_TO,
    subject: `alert: la box '${box}' ne draine pas (${cycles} cycles de mute)`,
    body:
      `La box '${box}' reçoit du courrier réveillant mais sa session ne draine jamais ` +
      `(le dernier sujet: ${subject ?? "inconnu"}). Le backoff du wake est au cap. ` +
      `Action: un check-in de la session propriétaire (mesh_inbox) ou un re-register.`,
  });
}

export function startWakeLoop(options: WakeOptions): WakeHandle {
  const interval = options.intervalMs ?? DEFAULT_WAKE_INTERVAL_MS;
  if (interval <= 0) {
    return { stop: () => {} };
  }
  // Token economy (0.16.0): pool broadcasts never wake by default; since
  // 0.17.0 the sender can flag one deliberate broadcast wake:true.
  const wakePools = options.wakePools ?? false;
  const lastPromptAt = new Map<string, number>();
  const lastUnread = new Map<string, number>();
  const undrained = new Map<string, number>();
  const mutedSince = new Map<string, number>();
  const muteCycles = new Map<string, number>();
  const escalated = new Map<string, number>();
  // Collapse gate (0.28.0): at most ONE wake prompt in flight per session.
  // The host queue delivers one queued item per idle cycle: a second queued
  // prompt fires later with its count and subject already stale — the
  // phantom-unread class. Set at queue time, cleared when the session goes
  // busy (a delivered prompt CAUSES the turn, so the busy event is the
  // delivery receipt).
  const pendingPrompt = new Map<string, number>();
  let stopped = false;
  let failures = 0;
  // Overlap guard (0.18.0): a prompt slower than the interval must not run
  // two ticks concurrently (double prompt for the same mail).
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // The transaction-leak probe (0.30.0): every tick runs a noop
      // transaction. The 0.28.2 guard throws on a leaked BEGIN — the leak
      // pinned the WAL snapshot (the frozen-view class, seen live twice) —
      // and the probe recovers via the connection reopen, with the warn in
      // the plugin log. One noop txn per tick is negligible.
      try {
        withTransaction(options.db, () => {});
      } catch (error) {
        // Bare failure label: the probe cannot know whether an inner
        // recovery ran — a false "recovered" in the incident log is the
        // exact misread this file exists to prevent.
        pluginWarn(storeLogDir(options.db.path), `wake probe: ${String(error)}`);
      }
      const now = Date.now();
      // One grouped read for the whole host (0.21.0): per-box unread count,
      // wake gate and preview subject used to cost two queries per mailbox
      // plus one at prompt time. Boxes without unread deliveries are absent
      // from the result — their fatigue maps are cleared below like before.
      const statsByName = new Map(wakeBoxStats(options.db).map((s) => [s.box, s]));
      // Clear in-flight gates: (a) delivered — the delivery causes a turn, the
      // turn's busy event shows here as sessionRunning; (b) expired — a turn
      // shorter than the poll interval fits entirely between two ticks, so
      // the busy event can go unobserved; the TTL releases the gate and
      // bounds any stuck state at the cost of at most one duplicate flash
      // per TTL.
      if (options.sessionRunning) {
        for (const [sessionID, ts] of pendingPrompt) {
          if (options.sessionRunning(sessionID) || now - ts >= PROMPT_GATE_TTL_MS) {
            pendingPrompt.delete(sessionID);
          }
        }
      }
      for (const box of listMailboxes(options.db)) {
        const stat = statsByName.get(box.name);
        const previous = lastUnread.get(box.name) ?? 0;
        if (stat === undefined || stat.unread === 0) {
          lastUnread.delete(box.name);
          undrained.delete(box.name);
          mutedSince.delete(box.name);
          muteCycles.delete(box.name);
          escalated.delete(box.name);
          continue;
        }
        const unread = stat.unread;
        // Pool gate (Slack model, 0.17.0): a box wakes only for mail meant to
        // interrupt it — a direct mail (one recipient), or any pending mail
        // the sender flagged wake=1 (deliberate broadcast). A pool broadcast
        // without the flag (fanouted or local multi-recipient) never wakes;
        // wakePools is the operator-wide override. The box looks empty to the
        // loop until a wakeable mail lands — one prompt then drains all.
        if (!wakePools && !stat.wakeable) {
          continue;
        }
        lastUnread.set(box.name, unread);
        // Drained since the last prompt → the fatigue counter resets.
        if (unread < previous) {
          undrained.delete(box.name);
        }
        const cycles = undrained.get(box.name) ?? 0;
        // Fatigue guard: prompted MAX times, never drained, count unchanged
        // → mute. Fatigue mute TTL (0.28.2): a muted box never unmuted by
        // itself — the purge requires the count to drop, which requires the
        // box to drain, which requires a prompt — starvation (seen live: the
        // orq box held 8 unread mails while the session kept running). The
        // TTL releases the mute: one reminder per TTL, the mail never
        // starves.
        if (unread <= previous && cycles >= MAX_UNDRAINED_PROMPTS) {
          const mutedAt = mutedSince.get(box.name);
          if (mutedAt === undefined) {
            mutedSince.set(box.name, now);
            continue;
          }
          // The reminder backoff (0.30.0): each consecutive mute cycle
          // doubles the TTL (10 -> 20 -> 40 -> 80 min cap) — a blocked agent
          // costs one reminder per doubling instead of one per 10 minutes.
          const cycle = muteCycles.get(box.name) ?? 0;
          const ttl = Math.min(FATIGUE_MUTE_TTL_MS * 2 ** cycle, FATIGUE_MUTE_MAX_MS);
          if (now - mutedAt < ttl) continue;
          if (cycle >= ESCALATE_AFTER_MUTE_CYCLES) {
            escalateBox(options.db, box.name, cycle, stat.subject, escalated);
          }
          undrained.delete(box.name);
          mutedSince.set(box.name, now);
          muteCycles.set(box.name, cycle + 1);
        }
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
          typeof box.session_id === "string" &&
          box.session_id.length > 0 &&
          options.sessionKnown(box.session_id);
        if (!bound) {
          // Session this instance never saw (foreign host, dead session, or a
          // pre-restart id): its live session will re-register and re-bind.
          continue;
        }
        // Collapse gate: a prompt for this session is still queued — the host
        // delivers it one idle cycle at a time and its turn drains the box.
        // Queueing another only manufactures a stale phantom. Only engage
        // when a sessionRunning callback exists (no busy signal, no delivery
        // receipt — the gate would never clear).
        if (options.sessionRunning && pendingPrompt.has(box.session_id)) {
          continue;
        }
        if (options.sessionRunning?.(box.session_id)) {
          // Mid-turn: a queued prompt would fire with a stale unread count
          // after the turn acked the mail. The turn-start check-in reads the
          // box anyway (AGENTS.md convention) — skip.
          continue;
        }
        lastPromptAt.set(box.name, now);
        undrained.set(box.name, cycles + 1);
        // The flash recomputes from the database at the moment it is emitted
        // (0.24.6): the tick-start grouped stat can be seconds old by the time
        // the loop reaches this box, and the prompt is queued — it fires later
        // still. A count retained from a past delivery reads as a phantom
        // (observed live: 1-5 phantom unreads per turn with an empty inbox and
        // zero pending in the DB). One cheap COUNT per flash: drained since
        // the stat read → nothing is displayed at all; the count shown is the
        // database's, always.
        const fresh = unreadBoxCount(options.db, box.name);
        if (fresh === 0) {
          lastUnread.delete(box.name);
          undrained.delete(box.name);
          continue;
        }
        lastUnread.set(box.name, fresh);
        // Collapse gate set ONLY now — after every bail: a bail here queues no
        // prompt, and a gate set without one would mute the session forever.
        if (options.sessionRunning) pendingPrompt.set(box.session_id, now);
        // Dispose during this tick (stop() below the running interval): the
        // prompt would fire into a torn-down host binding.
        if (stopped) return;
        // The unread count was read from this process' database one statement
        // above the prompt: never an inherited or cached state. Compact
        // notification (0.16.0): count + first pending subject, truncated to
        // 60 chars — the message stays self-carrier, the agent knows
        // mesh_inbox from its standing guidance.
        const subject = stat.subject;
        const preview =
          subject === null ? "" : subject.length > 60 ? `${subject.slice(0, 59)}…` : subject;
        try {
          await options.prompt(
            box.session_id,
            preview === "" ? `mesh: ${fresh} unread` : `mesh: ${fresh} unread — "${preview}"`,
            `msg_${randomUUID()}`,
          );
        } catch (error) {
          // The prompt never queued: drop the gate so the next tick may retry.
          pendingPrompt.delete(box.session_id);
          throw error;
        }
        // The prompt resolved after dispose: do not touch any further box.
        if (stopped) return;
      }
      const hadBackoff = failures > 0;
      failures = 0;
      // A successful tick restores the normal interval (the backoff unwind).
      if (!stopped && hadBackoff) {
        clearInterval(timer);
        timer = setInterval(() => void tick(), interval);
      }
    } catch (error) {
      // A failed tick (db busy or closed, host rejecting a prompt) backs off
      // exponentially (capped) and recovers on the first successful tick —
      // the 0.28.x hard stop starved every box permanently.
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      // The backoff replaces the old hard stop: a busy database (25 s of
      // contention starved every box forever under the 0.28.x hard stop) or
      // a prompt-refusing host must not kill the wake permanently — the loop
      // retries on an exponential schedule (capped) and recovers on the
      // first successful tick. The warns land in the plugin log
      // (console.warn is /dev/null under serve --service).
      const backoff = Math.min(interval * 2 ** failures, TICK_BACKOFF_CAP_MS);
      if (failures >= MAX_TICK_FAILURES) {
        pluginWarn(
          storeLogDir(options.db.path),
          `wake tick failed ${failures} times — backing off to ${Math.round(backoff / 1000)}s: ${message}`,
        );
      }
      if (!stopped && backoff > interval) {
        clearInterval(timer);
        timer = setInterval(() => void tick(), backoff);
      }
    } finally {
      ticking = false;
    }
  };

  let timer: ReturnType<typeof setInterval> = setInterval(() => void tick(), interval);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
