/**
 * OpenCode Mesh Plugin
 *
 * Multi-session coordination and peer pool for OpenCode.
 *
 * @packageDocumentation
 */

import { MeshPlugin } from "./plugin.js";

const pluginModule = {
  id: "@log0u7/opencode-mesh",
  server: MeshPlugin,
} satisfies { id: string; server: typeof MeshPlugin };

export default pluginModule;

export type { Lock, MailMessage, Peer } from "./types/peer.js";

export { MeshPlugin } from "./plugin.js";
