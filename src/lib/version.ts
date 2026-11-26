import { createRequire } from "node:module";

// The loaded plugin version — the runtime truth (the process knows its own
// package, the config pin is only the intent). mesh_status and the debugWake
// flash line both surface it: the convergence survey asked agents for the
// loaded version and got guesses (the pin is per host, the process per
// serve). Read once at module load; a missing package.json reads as "?".
const require = createRequire(import.meta.url);

let cached: string | undefined;

export function pluginVersion(): string {
  if (cached === undefined) {
    try {
      cached = (require("../../package.json") as { version?: string }).version ?? "?";
    } catch {
      cached = "?";
    }
  }
  return cached;
}
