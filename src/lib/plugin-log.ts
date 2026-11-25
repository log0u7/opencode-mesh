import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The plugin's own log file: console.warn goes to the serve's stdout, which
// is /dev/null under `opencode serve --service` — a warn written there is
// invisible in production (the 0.28.2 leak warn was). This file is the one
// place the plugin's operational warnings actually land. Capped: past the
// limit the file truncates to its tail before the append (a rolling window,
// no rotation machinery).

const PLUGIN_LOG_NAME = "plugin.log";
const PLUGIN_LOG_CAP = 512 * 1024;
const PLUGIN_LOG_TAIL = 64 * 1024;

export function pluginWarn(dir: string | undefined, message: string): void {
  try {
    const file = join(dir ?? ".", PLUGIN_LOG_NAME);
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > PLUGIN_LOG_CAP) {
        const tail = readFileSync(file, "utf8").slice(-PLUGIN_LOG_TAIL);
        writeFileSync(file, tail);
      }
    } catch {
      // A missing/unreadable file is fine: the append creates it.
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // The log must never take the caller down with it.
  }
}

/** The log file path, for tests and diagnostics. */
export function pluginLogPath(dir: string): string {
  return join(dir ?? ".", PLUGIN_LOG_NAME);
}
