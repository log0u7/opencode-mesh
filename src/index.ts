/**
 * OpenCode Mesh Plugin
 *
 * Multi-session coordination and peer pool for OpenCode.
 *
 * @packageDocumentation
 */

import { MeshV2 } from "./plugin-v2.js";

type V1Plugin = typeof import("./plugin.js").MeshPlugin;

/**
 * Dual entrypoint: v1 hosts call `server()`, v2 hosts call `setup()`
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1).
 *
 * The v1 implementation imports `@opencode-ai/plugin` and `@opencode-ai/sdk`,
 * which only v1 hosts resolve. It must stay out of the static import graph or
 * v2 hosts reject the whole package at load time, so `server()` loads it
 * lazily; a v2 host never calls `server()` and therefore never resolves it.
 */
export const pluginModule = {
  ...MeshV2,
  async server(...args: Parameters<V1Plugin>): Promise<Awaited<ReturnType<V1Plugin>>> {
    const { MeshPlugin } = await import("./plugin.js");
    return MeshPlugin(...args);
  },
} satisfies { id: string; server: V1Plugin; setup: (typeof MeshV2)["setup"] };

export default pluginModule;

export type { Lock, MailMessage, Peer } from "./types/peer.js";

export type { MeshPlugin } from "./plugin.js";
