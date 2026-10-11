/**
 * OpenCode Mesh Plugin
 *
 * Multi-session coordination and peer pool for OpenCode.
 *
 * @packageDocumentation
 */

import { MeshV2 } from "./plugin-v2.js";
import { MeshPlugin } from "./plugin.js";

/**
 * Dual entrypoint: v1 hosts call `server()`, v2 hosts call `setup()`
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1).
 */
export const pluginModule = {
  ...MeshV2,
  server: MeshPlugin,
} satisfies { id: string; server: typeof MeshPlugin; setup: (typeof MeshV2)["setup"] };

export default pluginModule;

export type { Lock, MailMessage, Peer } from "./types/peer.js";

export { MeshPlugin } from "./plugin.js";
