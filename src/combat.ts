// Abelon combat: our own turn tracker, so nobody has to touch Forge's UI.
//
// Per-token data stays in the Forge-format metadata keys the rest of this extension already
// uses (HP Z005, max Z006, AC Z007, temp Z042, name, init, on-list). That keeps the DiceCloud
// sync, the DM panel and "Apply stat block" working unchanged, and means Forge can be switched
// off (or left on) without anything being lost. Whose turn it is and the round number live in
// our own scene key. Only the GM writes; every player reads the same data to draw the strip.
import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { FORGE_KEYS } from "./forge";

export const COMBAT_KEY = "com.abelon.combat/state";
const NAMER_KEY = "com.abelon.namer/data";
const MAPPING_KEY = "com.abelon.dicecloud-sync/mappings";

export interface PublicStatus {
  t: string; // text shown
  c: string; // colour
}
export interface CombatState {
  round: number;
  turn?: string;
  /** public statuses per token (DM-only ones never go here: players can read scene metadata) */
  statuses?: Record<string, PublicStatus[]>;
}

export interface Unit {
  id: string;
  /** the name everyone sees */
  name: string;
  /** the Namer's real name (GM only) */
  realName?: string;
  init?: number;
  hp?: number;
  maxHp?: number;
  tempHp?: number;
  ac?: number;
  visible: boolean;
  /** linked to a DiceCloud sheet: a party member */
  party: boolean;
  image?: string;
}

const num = (v: unknown) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const inCombat = (item: Item) => FORGE_KEYS.onList in item.metadata;

/** Everyone on the combat list, in turn order: highest initiative first, unrolled last. */
export function units(items: Item[], partyIds: Set<string>): Unit[] {
  return items
    .filter(inCombat)
    .map((item): Unit => {
      const m = item.metadata;
      const namer = m[NAMER_KEY] as { realName?: string } | undefined;
      return {
        id: item.id,
        name: (m[FORGE_KEYS.name] as string | undefined) || item.name,
        realName: namer?.realName || undefined,
        init: num(m[FORGE_KEYS.init]),
        hp: num(m[FORGE_KEYS.currentHP]),
        maxHp: num(m[FORGE_KEYS.maxHP]),
        tempHp: num(m[FORGE_KEYS.tempHP]),
        ac: num(m[FORGE_KEYS.ac]),
        visible: item.visible,
        party: partyIds.has(item.id),
        image: (item as Item & { image?: { url?: string } }).image?.url,
      };
    })
    .sort((a, b) => (b.init ?? -999) - (a.init ?? -999) || a.name.localeCompare(b.name));
}

export async function partyIds(): Promise<Set<string>> {
  const stored = (await OBR.scene.getMetadata())[MAPPING_KEY];
  return new Set(Array.isArray(stored) ? (stored as { itemId: string }[]).map((m) => m.itemId) : []);
}

export async function getState(): Promise<CombatState> {
  const s = (await OBR.scene.getMetadata())[COMBAT_KEY] as CombatState | undefined;
  return s && typeof s === "object" ? s : { round: 0 };
}
export async function patchState(patch: Partial<CombatState>) {
  const now = await getState();
  await OBR.scene.setMetadata({ [COMBAT_KEY]: { ...now, ...patch } });
}

export async function addToCombat(ids: string[]) {
  await OBR.scene.items.updateItems(ids, (items) => {
    for (const it of items) {
      it.metadata[FORGE_KEYS.onList] = true;
      if (!it.metadata[FORGE_KEYS.name]) it.metadata[FORGE_KEYS.name] = it.name;
    }
  });
}
export async function removeFromCombat(ids: string[]) {
  await OBR.scene.items.updateItems(ids, (items) => {
    for (const it of items) {
      delete it.metadata[FORGE_KEYS.onList];
      delete it.metadata[FORGE_KEYS.init];
    }
  });
  const st = await getState();
  if (st.turn && ids.includes(st.turn)) await patchState({ turn: undefined });
}

export async function setInit(id: string, value: number | undefined) {
  await OBR.scene.items.updateItems([id], (items) => {
    for (const it of items) {
      if (value === undefined) delete it.metadata[FORGE_KEYS.init];
      else it.metadata[FORGE_KEYS.init] = String(value);
    }
  });
}

/** Move the turn on (or back). Round goes up when the order wraps round to the top. */
export async function step(dir: 1 | -1) {
  const items = await OBR.scene.items.getItems(inCombat);
  const order = units(items, new Set());
  if (!order.length) return;
  const st = await getState();
  const at = order.findIndex((u) => u.id === st.turn);
  if (at < 0) return patchState({ turn: order[0].id, round: Math.max(1, st.round || 1) });
  let next = at + dir;
  let round = st.round || 1;
  if (next >= order.length) {
    next = 0;
    round += 1;
  } else if (next < 0) {
    next = order.length - 1;
    round = Math.max(1, round - 1);
  }
  await patchState({ turn: order[next].id, round });
}

export async function endCombat() {
  const items = await OBR.scene.items.getItems(inCombat);
  if (items.length) await removeFromCombat(items.map((i) => i.id));
  await patchState({ turn: undefined, round: 0 });
}
