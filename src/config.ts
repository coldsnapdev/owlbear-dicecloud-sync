import OBR from "@owlbear-rodeo/sdk";

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

// --- Token -> character mapping ---------------------------------------------
// The mapping itself isn't sensitive, and every player benefits from seeing
// it stay in sync — so it lives in the scene's own metadata, under our
// namespace, and follows the room like any other extension data.

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
}

export async function removeMapping(itemId: string): Promise<void> {
  const mappings = await getMappings();
  await setMappings(mappings.filter((m) => m.itemId !== itemId));
}
