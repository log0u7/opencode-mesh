/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";

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

    return context.ui.slot({
      append: "sidebar.content",
      render: () => null,
    });
  },
});
