import OBR, { type Item } from "@owlbear-rodeo/sdk";

// --- Credentials -----------------------------------------------------------
// The DiceCloud "reader" account's credentials are kept in this browser's
// localStorage only — never written into shared scene/room metadata. That
// means only whichever machine configures them can run the sync (normally
// the GM's), and no other player who has the extension enabled can read
// them out of Owlbear's own synced state.

const CREDENTIALS_KEY = "dicecloud-sync/credentials";

export interface StoredCredentials {
  usernameOrEmail: string;
  password: string;
}

export function getStoredCredentials(): StoredCredentials | undefined {
  const raw = localStorage.getItem(CREDENTIALS_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function setStoredCredentials(creds: StoredCredentials): void {
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(creds));
}

export function clearStoredCredentials(): void {
  localStorage.removeItem(CREDENTIALS_KEY);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// --- Character links (room-level, persists across scenes) ------------------
// Keyed by the Owlbear token's NAME, not its item id. Owlbear hands out a
// fresh item id every time a token shows up in a scene — even "the same"
// party member dragged onto a new map — so an id-based link can't survive a
// scene change on its own. A name is the one thing that *does* stay
// consistent from the GM's point of view, so this list lives on the room
// (persists across every scene in it) and is what makes auto-attaching and
// hiding tokens work no matter which scene you're in.

const CHARACTER_LINKS_KEY = "com.abelon.dicecloud-sync/character-links";

export interface CharacterLink {
  /** The Owlbear token name this applies to (matched case-insensitively). */
  itemName: string;
  /** DiceCloud creature id to auto-sync tokens with this name from. */
  creatureId?: string;
  /** True if tokens with this name should be hidden from the list entirely (e.g. NPCs). */
  ignored?: boolean;
}

export async function getCharacterLinks(): Promise<CharacterLink[]> {
  const metadata = await OBR.room.getMetadata();
  const stored = metadata[CHARACTER_LINKS_KEY];
  return Array.isArray(stored) ? (stored as CharacterLink[]) : [];
}

export async function setCharacterLinks(links: CharacterLink[]): Promise<void> {
  await OBR.room.setMetadata({ [CHARACTER_LINKS_KEY]: links });
}

export async function upsertCharacterLink(link: CharacterLink): Promise<void> {
  const links = await getCharacterLinks();
  const key = normalizeName(link.itemName);
  const next = links.filter((l) => normalizeName(l.itemName) !== key);
  next.push(link);
  await setCharacterLinks(next);
}

export async function removeCharacterLink(itemName: string): Promise<void> {
  const links = await getCharacterLinks();
  const key = normalizeName(itemName);
  await setCharacterLinks(links.filter((l) => normalizeName(l.itemName) !== key));
}

export function findCharacterLink(
  links: CharacterLink[],
  itemName: string
): CharacterLink | undefined {
  const key = normalizeName(itemName);
  return links.find((l) => normalizeName(l.itemName) === key);
}

export function isNameIgnored(links: CharacterLink[], itemName: string): boolean {
  return findCharacterLink(links, itemName)?.ignored === true;
}

/** Hide every token with this name from the list, in every scene, from now on. */
export async function ignoreItemName(itemName: string): Promise<void> {
  // Ignoring drops any creatureId — an ignored name is never auto-synced.
  await upsertCharacterLink({ itemName, ignored: true });
  const mappings = await getMappings();
  const key = normalizeName(itemName);
  const next = mappings.filter((m) => normalizeName(m.itemName) !== key);
  if (next.length !== mappings.length) await setMappings(next);
}

/** Undo ignoreItemName — the name goes back to being offered for mapping. */
export async function unignoreItemName(itemName: string): Promise<void> {
  await removeCharacterLink(itemName);
}

// --- Token -> character mapping (per scene) ---------------------------------
// This is the list the background sync loop actually reads from — it needs
// real item ids to write Forge stats back to. It's derived from (and kept
// in sync with) the room-level character links above via reconcileMappings.

const MAPPING_METADATA_KEY = "com.abelon.dicecloud-sync/mappings";

export interface Mapping {
  /** Owlbear scene item id (the token). */
  itemId: string;
  /** Just for display in the popover. */
  itemName: string;
  /** DiceCloud creature id. */
  creatureId: string;
}

export async function getMappings(): Promise<Mapping[]> {
  const metadata = await OBR.scene.getMetadata();
  const stored = metadata[MAPPING_METADATA_KEY];
  return Array.isArray(stored) ? (stored as Mapping[]) : [];
}

export async function setMappings(mappings: Mapping[]): Promise<void> {
  await OBR.scene.setMetadata({ [MAPPING_METADATA_KEY]: mappings });
}

export async function upsertMapping(mapping: Mapping): Promise<void> {
  const mappings = await getMappings();
  const next = mappings.filter((m) => m.itemId !== mapping.itemId);
  next.push(mapping);
  await setMappings(next);
  // Remember this name -> creatureId link at the room level too, so any
  // token with the same name auto-attaches in a future scene.
  await upsertCharacterLink({ itemName: mapping.itemName, creatureId: mapping.creatureId });
}

export async function removeMapping(itemId: string, itemName?: string): Promise<void> {
  const mappings = await getMappings();
  const removed = mappings.find((m) => m.itemId === itemId);
  await setMappings(mappings.filter((m) => m.itemId !== itemId));

  const name = itemName ?? removed?.itemName;
  if (!name) return;
  // Clear the room-level link too, but keep an `ignored` flag if one was
  // set — clearing a mapping shouldn't silently un-hide an ignored name.
  const links = await getCharacterLinks();
  const existing = findCharacterLink(links, name);
  if (existing?.ignored) {
    await upsertCharacterLink({ itemName: name, ignored: true });
  } else {
    await removeCharacterLink(name);
  }
}

// --- Reconciliation ----------------------------------------------------------
// Matches this scene's items against the room-wide character-links list by
// name, and auto-creates a scene mapping for any match that isn't already
// mapped. Call this before reading mappings anywhere (popover render,
// background sync loop) so a token that matches a name we already know
// picks up its DiceCloud link the moment it appears, with no manual
// re-mapping needed after a scene change.
//
// Deliberately NOT gated on isForgeUnit here: Forge only writes its own
// tracking metadata onto a token once ITS UI has been told about it, which
// left a real gap — the same party token could work fine in one scene and
// be invisible to us in the next, purely because Forge hadn't "seen" it
// there yet. A name match against this list is already an explicit,
// GM-curated link (something you typed a DiceCloud URL in for), so it's a
// strong enough signal on its own — the background sync loop's
// writeForgeStats will create Forge's three metadata keys on the token the
// moment it syncs, forcing Forge-tracking into existence rather than
// waiting for Forge's own UI to do it. (The isForgeUnit filter is still
// used elsewhere, for the "which unmapped tokens should I offer to map"
// list in the popover — that's a different, narrower question.)
export async function reconcileMappings(items: Item[]): Promise<Mapping[]> {
  const [mappings, links] = await Promise.all([getMappings(), getCharacterLinks()]);
  const mappingByItem = new Map(mappings.map((m) => [m.itemId, m]));
  let changed = false;

  for (const item of items) {
    if (mappingByItem.has(item.id)) continue; // already mapped this scene

    const link = findCharacterLink(links, item.name);
    if (link?.creatureId && !link.ignored) {
      mappingByItem.set(item.id, {
        itemId: item.id,
        itemName: item.name,
        creatureId: link.creatureId,
      });
      changed = true;
    }
  }

  if (!changed) return mappings;
  const next = Array.from(mappingByItem.values());
  await setMappings(next);
  return next;
}
