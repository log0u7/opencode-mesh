/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal } from "solid-js";
import { MeshRpc, formatMeshLines, type MeshSnapshot } from "./rpc.js";

const REFRESH_MS = 15_000;

export default Plugin.define({
  id: "@log0u7/opencode-mesh.tui",
  setup(context) {
    context.ui.toast.show({ message: "opencode-mesh loaded", variant: "info", duration: 2000 });

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
            context.ui.toast.show({
              title: "Mesh",
              message: "Multi-session coordination available",
              variant: "info",
            });
          },
        },
      ],
    }));

    // Live sidebar: poll the server-side snapshot over RPC. On a v1 host (no
    // RPC) or while the server is unreachable, the slot stays hidden.
    const [lines, setLines] = createSignal<string[] | null>(null);
    const mesh = context.client.rpc(MeshRpc);
    const refresh = async () => {
      try {
        const snap = (await mesh.snapshot({})) as MeshSnapshot;
        setLines(formatMeshLines(snap));
      } catch {
        setLines(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={lines()} keyed>
          {(current) => (
            <box>
              <For each={current}>{(line) => <text>{line}</text>}</For>
            </box>
          )}
        </Show>
      ),
    });

    return () => {
      clearInterval(timer);
      unregister();
    };
  },
});
