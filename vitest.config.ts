import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // tui.tsx: rolldown ne parse pas le TSX du plugin-tui (la classe
      // pre-existante) — le CI l'exclut, le run local doit faire pareil.
      exclude: ["src/tui.tsx"],
      thresholds: {
        // The 0.33.0 refonte added ~900 lines (the tasks, the outbox, the
        // board, the stream, the ack) with their tests. The refonte2-A-D
        // pass ALSO REMOVED ~200 TESTED lines (the dead mesh_wait machinery)
        // and restructured the delivery: the thresholds track the
        // post-refonte2 reality (the follow-up: the pre-existing untested
        // error paths in client.ts, tools.ts's spawn branches, distant-spawn
        // — the 0.34 grind). The audit PO approved the transition approach.
        lines: 89,
        functions: 89,
        statements: 87.5,
        branches: 77.5,
      },
    },
  },
});
