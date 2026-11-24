/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { For, createSignal } from "solid-js";

type Context = Plugin.Context;
type Theme = Context["theme"];

import {
  MeshRpc,
  formatMeshSidebarCollapsed,
  formatMeshSidebarExpanded,
  type MeshSnapshot,
  type SidebarSegment,
  type SidebarTone,
} from "./rpc.js";
import { createSidebarState, type SidebarRpc } from "./sidebar-state.js";

const REFRESH_MS = 15_000;
/** quota-style event refresh: debounced immediate refresh after activity. */
const EVENT_DEBOUNCE_MS = 150;

function dialogBody(theme: Theme, snapshot: MeshSnapshot): JSX.Element {
  const self = snapshot.hostname.length > 0 ? snapshot.hostname : snapshot.node_id;
  const peers = snapshot.peers.map((p) => (p.hostname.length > 0 ? p.hostname : p.node_id));
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={theme.text.base}>
        <b>Mesh — coordination</b>
      </text>
      <text fg={theme.text.muted}>Node: {self}</text>
      <text fg={theme.text.muted}>
        Paired peers: {peers.length === 0 ? "none" : peers.join(", ")}
      </text>
      <text fg={theme.text.muted}>Active locks: {snapshot.active_locks}</text>
    </box>
  );
}

/** The theme's attention color for the alert glyph: warning or error when the
 * theme exposes one, plain text otherwise. */
function alertFg(theme: Theme): string {
  const palette = theme as {
    warning?: { base?: string };
    error?: { base?: string };
    text: { base: string };
  };
  return palette.warning?.base ?? palette.error?.base ?? theme.text.base;
}

/** Quota tone tiers to theme colors: entity and qualifier render in text,
 * values in muted, the alert glyph in the attention color. */
function toneFg(theme: Theme, tone: SidebarTone): string {
  if (tone === "value") {
    return theme.text.muted;
  }
  if (tone === "alert") {
    return alertFg(theme);
  }
  return theme.text.base;
}

/** One row of tone-colored segments; entity tones render bold. wrapMode="none"
 * everywhere: long lines clip instead of wrapping. */
function segmentRow(theme: Theme, line: SidebarSegment[], onClick?: () => void): JSX.Element {
  return (
    <box flexDirection="row" gap={0}>
      {line.map((seg) => (
        <text
          fg={toneFg(theme, seg.tone)}
          wrapMode="none"
          {...(onClick ? { onMouseDown: onClick } : {})}
        >
          {seg.tone === "entity" ? <b>{seg.text}</b> : seg.text}
        </text>
      ))}
    </box>
  );
}

/** The expanded v4 body: clickable bold header row, then one segment row per
 * formatter line so each tone tier gets its own color. */
function sidebarBody(theme: Theme, lines: SidebarSegment[][], onToggle: () => void): JSX.Element {
  return (
    <box gap={0}>
      {segmentRow(theme, lines[0] ?? [], onToggle)}
      <For each={lines.slice(1)}>{(line) => segmentRow(theme, line)}</For>
    </box>
  );
}

export default Plugin.define({
  id: "@log0u7/opencode-mesh.tui",
  setup(context: Context) {
    const theme = context.theme;
    context.ui.toast.show({ message: "opencode-mesh loaded", variant: "info", duration: 2000 });

    // Durable collapse state when the host allows it (scoped plugin ids hit a
    // host-side segment validation error — anomalyco/opencode#62634); RPC
    // fallback persists through the setup side; pure in-memory as last resort.
    // The RPC client output is untyped (Promise<unknown>): narrow to the
    // sidebar subset we consume.
    const meshRpc = context.client.rpc(MeshRpc) as unknown as SidebarRpc;
    const [store, mutate] = createSidebarState(context.storage, meshRpc);
    const [snapshot, setSnapshot] = createSignal<MeshSnapshot | null>(null);

    // Live sidebar: poll the server-side snapshot over RPC. On a v1 host (no
    // RPC) or while the server is unreachable, the slot falls back to the bare
    // toggle line. The sessionID arrives with the slot input (see register).
    const mesh = context.client.rpc(MeshRpc);
    // Snapshots per session: switching tabs must show THAT session's state
    // instantly (a single "latest" cache made the panel stale on tab switch).
    const snapBySession = new Map<string, MeshSnapshot>();
    let currentSession: string | null = null;
    const refresh = async (sid: string | null) => {
      if (sid === null) return;
      try {
        const snap = (await mesh.snapshot({ sessionID: sid })) as MeshSnapshot;
        snapBySession.set(sid, snap);
        if (currentSession === sid) {
          setSnapshot(snap);
        }
      } catch {
        if (currentSession === sid) setSnapshot(null);
      }
    };
    const timer = setInterval(() => void refresh(currentSession), REFRESH_MS);

    // quota-style event refresh: debounced immediate refresh after activity.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(currentSession), EVENT_DEBOUNCE_MS);
    };
    // context.client.event is an AsyncIterable of V2Event, not an EventEmitter.
    const events = context.client.event.subscribe();
    void (async () => {
      try {
        for await (const _event of events) {
          schedule();
        }
      } catch {
        // stream ended or errored: polling fallback stays active.
      }
    })();

    const toggleCollapsed = () => {
      // Formatting is pure: flipping the store re-renders the sidebar from the
      // snapshot already in hand, no refetch needed.
      void mutate((draft) => {
        draft.collapsed = !draft.collapsed;
      });
    };

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        if (input.sessionID !== currentSession) {
          currentSession = input.sessionID;
          // Bind BEFORE any mesh tool call: a fresh idle session must wake on
          // incoming mail, and only the TUI knows the sessionID that early.
          void meshRpc.bind({ sessionID: input.sessionID }).catch(() => {});
          void refresh(currentSession);
          schedule();
        }
        const snap = snapshot();
        // No snapshot (v1 host, unreachable server): the bare toggle line.
        if (!snap) {
          return (
            <box flexDirection="row">
              <text fg={theme.text.base} wrapMode="none" onMouseDown={toggleCollapsed}>
                <b>{store.collapsed ? "▶ Mesh" : "▼ Mesh"}</b>
              </text>
            </box>
          );
        }
        // Formatting is pure: both shapes derive from the snapshot in hand.
        if (store.collapsed) {
          return (
            <box flexDirection="row">
              {segmentRow(theme, formatMeshSidebarCollapsed(snap), toggleCollapsed)}
            </box>
          );
        }
        return sidebarBody(theme, formatMeshSidebarExpanded(snap), toggleCollapsed);
      },
    });

    // Keymap layers are disposed with the plugin; no manual disposer here.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "mesh.status",
          title: "Mesh status",
          group: "Mesh",
          slash: { name: "mesh" },
          palette: true,
          run: async () => {
            await refresh(currentSession);
            const current = snapshot();
            if (!current) {
              context.ui.toast.show({
                title: "Mesh",
                message: "Server unreachable",
                variant: "info",
              });
              return;
            }
            context.ui.dialog.show(() => dialogBody(theme, current));
            context.ui.dialog.set({ size: "medium" });
          },
        },
        {
          id: "mesh.toggleSidebar",
          title: "Toggle mesh sidebar",
          group: "Mesh",
          run: async () => {
            toggleCollapsed();
          },
        },
      ],
    }));

    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
      unregister();
    };
  },
});
