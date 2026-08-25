import OBR from "@owlbear-rodeo/sdk";
import type { CreatureStats } from "./dicecloud";

// Forge! (by Battle-System) stores each unit's attributes as ordinary
// Owlbear item metadata, namespaced as "com.battle-system.forge", one flat
// key per attribute (e.g. "Z005"). This was NOT found in any documentation
// — Forge is closed-source — it was captured by watching the room's
// WebSocket traffic (Network tab -> Socket -> Messages) while manually
// editing a unit's HP, Max HP, and AC in Forge, and confirmed to be the
// same three keys across multiple party tokens.
//
// If Forge ever changes its internal attribute layout for this campaign's
// system (e.g. attributes reordered or added before these three), these
// keys will need to be re-captured the same way and updated here.
export const FORGE_NAMESPACE = "com.battle-system.forge";

export const FORGE_KEYS = {
  currentHP: "Z005",
  maxHP: "Z006",
  ac: "Z007",
} as const;

/**
 * Writes DiceCloud-sourced stats into a token's existing Forge metadata.
 * Values are written as strings to match exactly what Forge itself writes
 * when a value is edited by hand in its own UI.
 */
export async function writeForgeStats(
  itemId: string,
  stats: CreatureStats
): Promise<void> {
  await OBR.scene.items.updateItems([itemId], (items) => {
    for (const item of items) {
      const forgeMeta = { ...(item.metadata[FORGE_NAMESPACE] as Record<string, unknown> | undefined) };

      if (stats.currentHP !== undefined) {
        forgeMeta[FORGE_KEYS.currentHP] = String(Math.round(stats.currentHP));
      }
      if (stats.maxHP !== undefined) {
        forgeMeta[FORGE_KEYS.maxHP] = String(Math.round(stats.maxHP));
      }
      if (stats.ac !== undefined) {
        forgeMeta[FORGE_KEYS.ac] = String(Math.round(stats.ac));
      }

      item.metadata[FORGE_NAMESPACE] = forgeMeta;
    }
  });
}

/** Reads a token's current Forge stats back out, for the popover's preview. */
export function readForgeStats(metadata: Record<string, unknown>): {
  currentHP?: string;
  maxHP?: string;
  ac?: string;
} {
  const forgeMeta = (metadata[FORGE_NAMESPACE] as Record<string, unknown> | undefined) ?? {};
  return {
    currentHP: forgeMeta[FORGE_KEYS.currentHP] as string | undefined,
    maxHP: forgeMeta[FORGE_KEYS.maxHP] as string | undefined,
    ac: forgeMeta[FORGE_KEYS.ac] as string | undefined,
  };
}
