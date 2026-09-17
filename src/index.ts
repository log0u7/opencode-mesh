/**
 * OpenCode Mesh Plugin
 *
 * Multi-session coordination and peer pool for OpenCode.
 *
 * @packageDocumentation
 */

import { MeshPlugin } from "./plugin.js";

type V1PluginModule = {
  id: string;
  server: typeof MeshPlugin;
};

const pluginModule = {
  id: "@log0u7/opencode-mesh",
  server: MeshPlugin,
} satisfies V1PluginModule;

export default pluginModule;

export type { Lock, MailMessage, Peer } from "./types/peer.js";

export { MeshPlugin } from "./plugin.js";
