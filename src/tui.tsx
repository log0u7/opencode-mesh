/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { For, createSignal } from "solid-js";

type Context = Plugin.Context;
type Theme = Context["theme"];

import {
  MeshRpc,
  formatMeshPoolsDialog,
  formatMeshPeersDialog,
  formatMeshSidebarCollapsed,
  formatMeshSidebarExpanded,
  formatMeshStatusDialog,
  type MeshSnapshot,
  type SidebarSegment,
  type SidebarTone,
} from "./rpc.js";
import { createSidebarState, type SidebarRpc } from "./sidebar-state.js";

const REFRESH_MS = 15_000;
/** quota-style event refresh: debounced immediate refresh after activity. */
const EVENT_DEBOUNCE_MS = 150;

/** One tone-colored segment row per line (the dialog twin of sidebarBody). */
function segmentDialog(theme: Theme, lines: SidebarSegment[][]): JSX.Element {
  return (
    <box gap={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <For each={lines}>
        {(line) => (
          <box flexDirection="row" gap={0}>
            <For each={line}>
              {(seg) => (
                <text fg={toneFg(theme, seg.tone)} wrapMode="none">
                  {seg.tone === "entity" ? <b>{seg.text}</b> : seg.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

/** A small focused dialog: one bold section title, then segment lines. */
function sectionDialog(theme: Theme, title: string, lines: SidebarSegment[][]): JSX.Element {
  return segmentDialog(theme, [[{ text: title, tone: "entity" }], ...lines]);
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
    // Sidebar glyphs default on; `icons: false` swaps them for lowercase text
    // labels, the fallback for terminals that draw ambiguous-width glyphs
    // double-cell and glue the next character (see rpc.ts).
    const icons = context.options?.icons !== false;

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
        return sidebarBody(theme, formatMeshSidebarExpanded(snap, { icons }), toggleCollapsed);
      },
    });

    // Keymap layers are disposed with the plugin; no manual disposer here.
    const MESH_USAGE = "usage: /mesh [status|pools|peers|board <pool>|inbox [agent]|toggle]";
    const toast = (message: string, variant: "info" | "warning" = "info") =>
      context.ui.toast.show({ title: "Mesh", message, variant });
    const unreachable = () => toast("Server unreachable");
    const show = (body: () => JSX.Element) => {
      context.ui.dialog.show(body);
      context.ui.dialog.set({ size: "medium" });
    };
    const statusDialog = (snap: MeshSnapshot): JSX.Element =>
      segmentDialog(theme, [
        [{ text: "Mesh · coordination", tone: "entity" }],
        ...formatMeshStatusDialog(snap, { width: 40 }),
      ]);
    const dispatch = async (input: string | undefined) => {
      const words = (input ?? "").trim().split(/\s+/).filter(Boolean);
      const [cmd, arg] = words;
      switch (cmd ?? "") {
        case "":
        case "status": {
          await refresh(currentSession);
          const snap = snapshot();
          if (!snap) {
            unreachable();
            return;
          }
          show(() => statusDialog(snap));
          return;
        }
        case "pools": {
          let snap = snapshot();
          if (!snap) {
            await refresh(currentSession);
            snap = snapshot();
          }
          if (!snap) {
            unreachable();
            return;
          }
          show(() => sectionDialog(theme, "Mesh · pools", formatMeshPoolsDialog(snap)));
          return;
        }
        case "peers": {
          let snap = snapshot();
          if (!snap) {
            await refresh(currentSession);
            snap = snapshot();
          }
          if (!snap) {
            unreachable();
            return;
          }
          show(() => sectionDialog(theme, "Mesh · peers", formatMeshPeersDialog(snap)));
          return;
        }
        case "board": {
          if (!arg) {
            toast("usage: /mesh board <pool>", "warning");
            return;
          }
          try {
            const result = (await mesh.board({ pool: arg })) as {
              rows: Array<{ box: string; line: string }>;
            };
            show(() =>
              sectionDialog(
                theme,
                `Mesh · board ${arg}`,
                result.rows.length === 0
                  ? [[{ text: "(empty board)", tone: "value" }]]
                  : result.rows.map((row) => [
                      { text: `${row.box} `, tone: "qualifier" },
                      { text: row.line, tone: "value" },
                    ]),
              ),
            );
          } catch {
            unreachable();
          }
          return;
        }
        case "inbox": {
          try {
            const result = (await mesh.inbox(arg ? { box: arg } : {})) as {
              rows: Array<{ box: string; from_box: string | null; subject: string; age_s: number }>;
              total: number;
            };
            show(() =>
              sectionDialog(
                theme,
                `Mesh · inbox${arg ? ` ${arg}` : ""}`,
                result.rows.length === 0
                  ? [[{ text: "inbox clear", tone: "value" }]]
                  : ([
                      ...result.rows.map((row): SidebarSegment[] => [
                        { text: "● ", tone: "alert" },
                        { text: row.subject.slice(0, 40), tone: "qualifier" },
                        { text: ` ${row.from_box ?? "?"} ${row.box}`, tone: "value" },
                        {
                          text: ` ${row.age_s < 90 ? `${row.age_s}s` : `${Math.round(row.age_s / 60)}m`} ago`,
                          tone: "value",
                        },
                      ]),
                      ...(result.total > result.rows.length
                        ? ([
                            [
                              {
                                text: `+${result.total - result.rows.length} more unread`,
                                tone: "value",
                              },
                            ],
                          ] as SidebarSegment[][])
                        : []),
                    ] as SidebarSegment[][]),
              ),
            );
          } catch {
            unreachable();
          }
          return;
        }
        case "toggle":
          toggleCollapsed();
          return;
        default:
          toast(MESH_USAGE, "warning");
      }
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "mesh.status",
          title: "Mesh",
          description:
            "Mesh /mesh shows the status. Subcommands: pools, peers, board <pool>, inbox [agent], toggle",
          group: "Mesh",
          slash: { name: "mesh", arguments: true },
          palette: true,
          run: async (input?: string) => {
            await dispatch(input);
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
