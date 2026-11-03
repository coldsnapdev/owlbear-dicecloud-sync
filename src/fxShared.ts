// What a player's own screen feels: worked out from their token's public statuses and whether
// it has fallen. Shared by the background (opens the overlay) and the overlay page (draws it).
export const FX_ID = "com.abelon.fx/overlay";
export const FX_CHANNEL = "com.abelon.fx/effects";
export const FX_HELLO = "com.abelon.fx/hello";
export const FX_PREVIEW_KEY = "abelon.fx.preview"; // GM: feel the selected token's effects
export const FX_OFF_KEY = "com.abelon.fx/off"; // room: the GM has switched screen effects off

export interface Effects {
  rot?: number;
  exhaustion?: number;
  poisoned?: boolean;
  charmed?: boolean;
  frightened?: boolean;
  blinded?: boolean;
  paralyzed?: boolean;
  stunned?: boolean;
  down?: boolean;
  dead?: boolean;
}

/** From status texts ("Rotten 3", "Poisoned"...) and the fallen state; the strongest wins across tokens. */
export function effectsFrom(texts: string[], fallen?: "dead" | "down", into: Effects = {}): Effects {
  for (const t of texts) {
    const m = t.trim().toLowerCase().match(/^([a-z ]+?)\s*(\d+)?$/);
    if (!m) continue;
    const [, name, n] = m;
    const lvl = Number(n ?? 1);
    if (name === "rotten") into.rot = Math.max(into.rot ?? 0, Math.min(6, lvl));
    else if (name === "exhaustion") into.exhaustion = Math.max(into.exhaustion ?? 0, Math.min(6, lvl));
    else if (name === "poisoned") into.poisoned = true;
    else if (name === "charmed") into.charmed = true;
    else if (name === "frightened") into.frightened = true;
    else if (name === "blinded") into.blinded = true;
    else if (name === "paralyzed" || name === "petrified") into.paralyzed = true;
    else if (name === "stunned" || name === "incapacitated") into.stunned = true;
    else if (name === "unconscious") into.down = true;
    else if (name === "dead") into.dead = true;
  }
  if (fallen === "dead") into.dead = true;
  if (fallen === "down") into.down = true;
  return into;
}
export const anyEffect = (e: Effects) => Object.values(e).some(Boolean);
