// The standing anti-narration directive (PO decision, 2026-11-23): injected
// into every session's system prompt through the v2 session context hook (the
// v2 SDK has no chat.system.transform; mutating the context hook's `system`
// array is the supported injection point). One registration at setup, disposed
// with the plugin — a hot-swapped orphan must not inject it twice.

export const MESH_GUIDANCE =
  "Do not narrate routine ops to the human — status only on significant state changes " +
  "(release, block/unblock, decision, failure); `mesh_journal` answers 'what happened' on demand. " +
  "Ack silently: a DM that only confirms receipt needs no reply — the sender's delivery receipt " +
  "is the ack. Reply only when asked or when adding information. " +
  "Addressing: team-wide announcements go to the POOL as one post (fanout is silent — nobody wakes); " +
  "never as individual DMs — a DM wakes its recipient. DM = only what must be seen NOW by ONE mailbox. " +
  "role: keep it 1-3 words — the panel truncates at word boundary; the full role lives in mesh_status.";
