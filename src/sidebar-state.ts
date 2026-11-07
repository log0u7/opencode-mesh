import { Plugin } from "@opencode/plugin/tui";
import { createStore, produce } from "solid-js/store";

type SidebarState = { collapsed: boolean };

/** Collapse state for the mesh sidebar: durable via the host's TUI storage when
 * available, in-memory fallback when it is not. The host composes storage keys
 * as `plugin.<id>.<key>` and its segment() validation rejects scoped npm ids
 * (`@scope/name.tui`), so `storage.store()` throws on first use for any plugin
 * installed from a scoped package (anomalyco/opencode#62634). The upstream fix
 * removes the throw; until then the fallback keeps the sidebar functional, at
 * the cost of not persisting the collapse state across TUI restarts.
 * Returns the same `[store, mutate]` shape as `storage.store` either way. */
export function createSidebarState(storage: Plugin.Context["storage"]) {
  try {
    return storage.store("mesh-sidebar", { initial: { collapsed: false } });
  } catch {
    const [store, setStore] = createStore<SidebarState>({ collapsed: false });
    return [
      store,
      (mutation: (draft: SidebarState) => void) => {
        setStore(produce(mutation));
        return Promise.resolve();
      },
    ] as readonly [
      { readonly collapsed: boolean },
      (mutation: (draft: SidebarState) => void) => Promise<void>,
    ];
  }
}
