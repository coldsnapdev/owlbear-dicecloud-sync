import OBR, { type Item } from "@owlbear-rodeo/sdk";
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
  // Captured 2026-09-14 by watching the room socket's Messages while typing
  // a Temp HP value into Arjay's token by hand in Forge — the resulting
  // patch was `/metadata/com.battle-system.forge~1Z042` -> "15", which
  // unescapes (the ~1 escapes a "/" within the one property name, not a
  // path separator — same gotcha as the other three keys) to this flat key.
  tempHP: "com.battle-system.forge/Z042",
  // Captured 2026-10-28 the same way, while adding Alric Venn's token to
  // combat and setting his initiative to 15 in Forge. Three keys this time,
  // and unlike the HP/AC/tempHP ones, Forge used readable names instead of
  // Z-codes:
  //   name     - the display name Forge shows in its own initiative list
  //   init     - the initiative number. Written as an actual JSON number
  //              (15), NOT a string like the other stat keys ("15") — worth
  //              remembering when reading it back.
  //   onList   - presence of this key is what actually means "in the
  //              current fight". Confirmed by removing Alric Venn from
  //              combat and watching the resulting patch: it was an
  //              `"op":"remove"` on this exact key, while `init` was left
  //              untouched (it persists even after combat ends — a token
  //              can have a leftover init value without being on-list).
  //              So "on combat list" must be checked by key presence, not
  //              by truthiness of a value.
  name: "com.battle-system.forge/name",
  init: "com.battle-system.forge/init",
  onList: "com.battle-system.forge/on-list",
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
      if (stats.tempHP !== undefined) {
        item.metadata[FORGE_KEYS.tempHP] = String(Math.round(stats.tempHP));
      }
    }
  });
}

/** Reads a token's current Forge stats back out, for the popover's preview. */
export function readForgeStats(metadata: Record<string, unknown>): {
  currentHP?: string;
  maxHP?: string;
  ac?: string;
  tempHP?: string;
} {
  return {
    currentHP: metadata[FORGE_KEYS.currentHP] as string | undefined,
    maxHP: metadata[FORGE_KEYS.maxHP] as string | undefined,
    ac: metadata[FORGE_KEYS.ac] as string | undefined,
    tempHP: metadata[FORGE_KEYS.tempHP] as string | undefined,
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

/** True if this item is currently on Forge's combat/initiative list. See the on-list note above. */
export function isOnCombatList(metadata: Record<string, unknown>): boolean {
  return FORGE_KEYS.onList in metadata;
}

// The Abelon Namer extension keeps a disguised token's real name here
// ({ realName, placeholder, hidden }), so the DM panel can match the right
// bestiary entry even while players see "Male Human 3".
const NAMER_KEY = "com.abelon.namer/data";

export interface Combatant {
  itemId: string;
  /** Forge's own tracked name for this combatant — falls back to the item's own name if absent. */
  name: string;
  /** The real name stored by the Abelon Namer when the token is showing a placeholder. */
  realName?: string;
  initiative: number;
  currentHP?: number;
  maxHP?: number;
  ac?: number;
  tempHP?: number;
}

/**
 * Builds the current combat roster straight from scene items: anyone
 * carrying Forge's on-list key, sorted by initiative descending (highest
 * acts first, standard 5e order).
 */
export function getCombatRoster(items: Item[]): Combatant[] {
  return items
    .filter((item) => isOnCombatList(item.metadata))
    .map((item): Combatant => {
      const stats = readForgeStats(item.metadata);
      const name = (item.metadata[FORGE_KEYS.name] as string | undefined) ?? item.name;
      const initiative = Number(item.metadata[FORGE_KEYS.init] ?? 0);
      const namer = item.metadata[NAMER_KEY] as { realName?: string } | undefined;
      return {
        itemId: item.id,
        name,
        realName: namer?.realName || undefined,
        initiative: Number.isFinite(initiative) ? initiative : 0,
        currentHP: numberOrUndefined(stats.currentHP),
        maxHP: numberOrUndefined(stats.maxHP),
        ac: numberOrUndefined(stats.ac),
        tempHP: numberOrUndefined(stats.tempHP),
      };
    })
    .sort((a, b) => b.initiative - a.initiative);
}

function numberOrUndefined(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
