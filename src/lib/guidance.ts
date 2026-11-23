// The standing anti-narration directive (PO decision, 2026-11-23): injected
// into every session's system prompt through the v2 session context hook (the
// v2 SDK has no chat.system.transform; mutating the context hook's `system`
// array is the supported injection point). One registration at setup, disposed
// with the plugin — a hot-swapped orphan must not inject it twice.

export const MESH_GUIDANCE =
  "Do not narrate routine ops to the human — status only on significant state changes " +
  "(release, block/unblock, decision, failure); `mesh_journal` answers 'what happened' on demand.";
