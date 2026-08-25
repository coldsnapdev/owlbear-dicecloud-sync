import OBR from "@owlbear-rodeo/sdk";
import type { CreatureStats } from "./dicecloud";

// Forge! (by Battle-System) stores each unit's attributes as ordinary
// Owlbear item metadata. This was NOT found in any documentation — Forge is
// closed-source — it was captured by watching the room's WebSocket traffic
// (Network tab -> Socket -> Messages) while manually editing a unit's HP,
// Max HP, and AC in Forge, and confirmed to be the same three keys across
// multiple party tokens.
//
// IMPORTANT: these are three separate FLAT metadata keys, not one
// "com.battle-system.forge" object containing sub-keys. The captured
// JSON-Patch path was:
//   /metadata/com.battle-system.forge~1Z005
// A JSON Pointer only splits on UNESCAPED "/" — the "~1" here is an
// escaped "/" *inside* a single property name, not a path separator. So
// this unescapes to one flat key: metadata["com.battle-system.forge/Z005"].
// (An earlier version of this file got this wrong and treated it as a
// nested object, which is why the sync silently found nothing.)
export const FORGE_KEYS = {
  currentHP: "com.battle-system.forge/Z005",
  maxHP: "com.battle-system.forge/Z006",
  ac: "com.battle-system.forge/Z007",
} as const;

/**
 * Writes DiceCloud-sourced stats into a token's existing Forge metadata
 * keys. Values are written as strings to match exactly what Forge itself
 * writes when a value is edited by hand in its own UI.
 */
export async function writeForgeStats(
  itemId: string,
  stats: CreatureStats
): Promise<void> {
  await OBR.scene.items.updateItems([itemId], (items) => {
    for (const item of items) {
      if (stats.currentHP !== undefined) {
        item.metadata[FORGE_KEYS.currentHP] = String(Math.round(stats.currentHP));
      }
      if (stats.maxHP !== undefined) {
        item.metadata[FORGE_KEYS.maxHP] = String(Math.round(stats.maxHP));
      }
      if (stats.ac !== undefined) {
        item.metadata[FORGE_KEYS.ac] = String(Math.round(stats.ac));
      }
    }
  });
}

/** Reads a token's current Forge stats back out, for the popover's preview. */
export function readForgeStats(metadata: Record<string, unknown>): {
  currentHP?: string;
  maxHP?: string;
  ac?: string;
} {
  return {
    currentHP: metadata[FORGE_KEYS.currentHP] as string | undefined,
    maxHP: metadata[FORGE_KEYS.maxHP] as string | undefined,
    ac: metadata[FORGE_KEYS.ac] as string | undefined,
  };
}

/** True if this item looks like a Forge-managed unit (has any of our three keys). */
export function isForgeUnit(metadata: Record<string, unknown>): boolean {
  return (
    FORGE_KEYS.currentHP in metadata ||
    FORGE_KEYS.maxHP in metadata ||
    FORGE_KEYS.ac in metadata
  );
}
