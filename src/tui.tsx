/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";

type Context = Plugin.Context;
type Theme = Context["theme"];

import { MeshRpc, formatMeshSidebar, type MeshSnapshot } from "./rpc.js";
import { createSidebarState, type SidebarRpc } from "./sidebar-state.js";

const REFRESH_MS = 15_000;
/** quota-style event refresh: debounced immediate refresh after activity. */
const EVENT_DEBOUNCE_MS = 150;

function themedBody(theme: Theme, lines: () => string[] | null, unread: number): JSX.Element {
  return (
    <Show when={lines()} keyed>
      {(current) => (
        <box gap={0}>
          <For each={current}>
            {(line, index) => (
              <text
                fg={index() === 0 && unread > 0 ? theme.text.base : theme.text.muted}
                wrapMode="none"
              >
                {line}
              </text>
            )}
          </For>
        </box>
      )}
    </Show>
  );
}

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
    const [lines, setLines] = createSignal<string[] | null>(null);

    // Live sidebar: poll the server-side snapshot over RPC. On a v1 host (no
    // RPC) or while the server is unreachable, the slot stays hidden. The
    // sessionID arrives with the slot input (see register below).
    const mesh = context.client.rpc(MeshRpc);
    const sessionId = createSignal<string | null>(null);
    const refresh = async () => {
      try {
        const sid = sessionId[0]();
        const snap = (await mesh.snapshot({
          ...(sid !== null ? { sessionID: sid } : {}),
        })) as MeshSnapshot;
        setSnapshot(snap);
        setLines(formatMeshSidebar(snap, store.collapsed));
      } catch {
        setLines(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    // quota-style event refresh: debounced immediate refresh after activity.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS);
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

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        if (input.sessionID !== sessionId[0]()) {
          sessionId[1](input.sessionID);
          // Bind BEFORE any mesh tool call: a fresh idle session must wake on
          // incoming mail, and only the TUI knows the sessionID that early.
          void meshRpc.bind({ sessionID: input.sessionID }).catch(() => {});
          schedule();
        }
        const unread = snapshot()?.me?.unread ?? 0;
        return (
          <box gap={0}>
            <box flexDirection="row">
              <text
                fg={theme.text.base}
                onMouseDown={() => {
                  void mutate((draft) => {
                    draft.collapsed = !draft.collapsed;
                  }).then(() => void refresh());
                }}
              >
                <b>{store.collapsed ? "▶ Mesh" : "▼ Mesh"}</b>
              </text>
              <Show when={store.collapsed}>
                <text fg={theme.text.muted}>
                  {unread > 0
                    ? ` (${unread} unread)`
                    : ` (${snapshot()?.mailboxes.length ?? 0} agents)`}
                </text>
              </Show>
            </box>
            <box gap={0}>{themedBody(theme, lines, unread)}</box>
          </box>
        );
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
            await refresh();
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
            await mutate((draft) => {
              draft.collapsed = !draft.collapsed;
            });
            void refresh();
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
