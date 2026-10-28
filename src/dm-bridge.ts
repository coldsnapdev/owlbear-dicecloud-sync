// Shared contract between background.ts (which runs inside Owlbear and has
// real OBR SDK access) and dm-panel.ts (a standalone page opened as an
// ordinary browser tab — NOT embedded in Owlbear, so it has no OBR access of
// its own at all).
//
// BroadcastChannel is what bridges them: it only reaches other tabs/windows
// of the exact same browser profile on the same machine, but it does reach
// across top-level windows regardless of one side being inside an iframe —
// both background.html and dm-panel.html are served from this same origin
// (coldsnapdev.github.io), which is what makes this work with no backend at
// all. If the DM panel is ever opened in a different browser/profile/device
// than Owlbear itself, this channel simply won't reach it.
import type { Combatant } from "./forge";

export const DM_PANEL_CHANNEL = "com.abelon.dicecloud-sync/dm-panel";

export type BridgeMessage =
  // background.ts -> dm-panel.ts: the current combat roster. Sent whenever
  // scene items change, and once immediately on request (see below) — the
  // panel has no other way to get an initial snapshot if it opens after the
  // last real change happened.
  | { type: "roster"; combatants: Combatant[] }
  // dm-panel.ts -> background.ts: "send me the current state now". Used on
  // the panel's initial load, and retried on a short timer until a response
  // arrives, in case background.ts hasn't finished loading yet.
  | { type: "requestSnapshot" };
