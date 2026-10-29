// The "combat mailbox": a JSON file on its own branch of this repo that the
// extension writes the current Forge combat roster into, and the standalone
// DM panel reads from on demand ("Update Roster").
//
// Why GitHub and not a live channel: browsers partition BroadcastChannel and
// storage by top-level site, so the extension (an iframe inside Owlbear) and
// the panel (its own tab on github.io) can't talk to each other directly even
// though they share an origin. A file both sides can reach sidesteps that,
// and the panel no longer needs to be in the same browser at all.
//
// The roster lives on the `combat-roster` branch, NOT main, so writing it
// never triggers a Pages rebuild. Only a browser holding a GitHub token (set
// in the popover, kept in localStorage — normally only the GM's) ever writes.
import type { Combatant } from "./forge";

export const REPO = "coldsnapdev/owlbear-dicecloud-sync";
export const BRANCH = "combat-roster";
export const PATH = "roster.json";
export const API_URL = `https://api.github.com/repos/${REPO}/contents/${PATH}`;

const TOKEN_KEY = "dicecloud-sync/github-token";
const STATUS_KEY = "dicecloud-sync/mailbox-status";

/** What the panel needs: who's in the fight, in what order, and their AC. No HP by design. */
export interface RosterEntry {
  itemId: string;
  name: string;
  /** Real name from the Abelon Namer, when the token is disguised. */
  realName?: string;
  initiative: number;
  ac?: number;
}

export interface RosterFile {
  savedAt: string | null;
  combatants: RosterEntry[];
}

export function getGitHubToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) || undefined;
}

export function setGitHubToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export interface MailboxStatus {
  ok: boolean;
  at: string;
  message: string;
}

export function getMailboxStatus(): MailboxStatus | undefined {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function setMailboxStatus(status: MailboxStatus) {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(status));
  } catch {
    // status is a convenience only
  }
}

export function toRosterEntries(combatants: Combatant[]): RosterEntry[] {
  return combatants.map((c) => ({ itemId: c.itemId, name: c.name, realName: c.realName, initiative: c.initiative, ac: c.ac }));
}

/** Fingerprint of exactly what the panel shows — HP changes deliberately don't count. */
export function rosterFingerprint(entries: RosterEntry[]): string {
  return JSON.stringify(entries);
}

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function decode(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function getCurrentSha(token: string): Promise<string | undefined> {
  const r = await fetch(`${API_URL}?ref=${BRANCH}&t=${Date.now()}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`read ${r.status}`);
  return (await r.json()).sha;
}

/** Writes the roster to the mailbox. Retries once if the file changed underneath us. */
export async function saveRoster(entries: RosterEntry[]): Promise<void> {
  const token = getGitHubToken();
  if (!token) return;
  const file: RosterFile = { savedAt: new Date().toISOString(), combatants: entries };
  const content = encode(JSON.stringify(file, null, 1) + "\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sha = await getCurrentSha(token);
      const r = await fetch(API_URL, {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `Combat roster: ${entries.length} combatant(s)`,
          branch: BRANCH,
          content,
          ...(sha ? { sha } : {}),
        }),
      });
      if (r.status === 409 || r.status === 422) continue; // stale sha — re-read and retry once
      if (!r.ok) throw new Error(`save ${r.status}`);
      setMailboxStatus({ ok: true, at: file.savedAt!, message: `Saved ${entries.length} combatant(s)` });
      return;
    } catch (err) {
      setMailboxStatus({ ok: false, at: new Date().toISOString(), message: String(err instanceof Error ? err.message : err) });
      throw err;
    }
  }
  setMailboxStatus({ ok: false, at: new Date().toISOString(), message: "save conflict" });
  throw new Error("save conflict");
}

/** Reads the mailbox. Public repo, so no token is needed (the panel has none). */
export async function loadRoster(): Promise<RosterFile> {
  const r = await fetch(`${API_URL}?ref=${BRANCH}&t=${Date.now()}`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
  const j = await r.json();
  return JSON.parse(decode(j.content)) as RosterFile;
}

// --- Stat block assignments -------------------------------------------------
// Per-token overrides chosen in the DM panel ("this token uses Tav's stat
// block"), keyed by Owlbear item id. Stored next to the roster so every device
// sees the same choices. Written by the panel, which needs its own token.
export const ASSIGNMENTS_PATH = "assignments.json";
const ASSIGNMENTS_URL = `https://api.github.com/repos/${REPO}/contents/${ASSIGNMENTS_PATH}`;

export type Assignments = Record<string, string>; // itemId -> bestiary entry id

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function readJson<T>(url: string, token?: string): Promise<{ data: T; sha: string } | undefined> {
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { headers: headers(token), cache: "no-store" });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
  const j = await r.json();
  return { data: JSON.parse(decode(j.content)) as T, sha: j.sha };
}

export async function loadRosterWith(token?: string): Promise<RosterFile> {
  const res = await readJson<RosterFile>(`${API_URL}?ref=${BRANCH}`, token);
  return res?.data ?? { savedAt: null, combatants: [] };
}

export async function loadAssignments(token?: string): Promise<Assignments> {
  const res = await readJson<Assignments>(`${ASSIGNMENTS_URL}?ref=${BRANCH}`, token);
  return res?.data ?? {};
}

export async function saveAssignments(assignments: Assignments, token: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readJson<Assignments>(`${ASSIGNMENTS_URL}?ref=${BRANCH}`, token);
    const r = await fetch(ASSIGNMENTS_URL, {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Stat block assignments",
        branch: BRANCH,
        content: encode(JSON.stringify(assignments, null, 1) + "\n"),
        ...(current ? { sha: current.sha } : {}),
      }),
    });
    if (r.status === 409 || r.status === 422) continue;
    if (!r.ok) throw new Error(`save ${r.status}`);
    return;
  }
  throw new Error("save conflict");
}

// --- Bestiary ----------------------------------------------------------------
// One current stat block per NPC/creature, kept in the DM manual repo
// (coldsnapdev/abelon-manual, bestiary.json). Each entry carries Forge JSON.
const BESTIARY_URL = "https://api.github.com/repos/coldsnapdev/abelon-manual/contents/bestiary.json?ref=main";

export interface BestiaryEntry {
  id: string;
  name: string;
  cr?: number;
  source?: string;
  updated?: string;
  forge: Record<string, unknown>;
  /** Optional flavour lines per action name (as in Forge's Z035). "{name}" is replaced with the token's visible name. */
  flavour?: Record<string, string[]>;
}

// --- Spells -------------------------------------------------------------------------
// Full rules text for spells NPCs cast, kept beside the bestiary in the DM
// manual (spells.json). Most come from the 2024 SRD (CC BY 4.0).
const SPELLS_URL = "https://api.github.com/repos/coldsnapdev/abelon-manual/contents/spells.json?ref=main";

export interface Spell {
  name: string;
  level: string; // e.g. "Level 2 Enchantment" or "Evocation Cantrip"
  castingTime: string;
  range: string;
  components: string;
  duration: string;
  text: string;
}

export async function loadSpells(token?: string): Promise<Spell[]> {
  const res = await readJson<{ spells: Spell[] }>(SPELLS_URL, token);
  return res?.data.spells ?? [];
}

export async function loadBestiary(token?: string): Promise<BestiaryEntry[]> {
  const res = await readJson<{ entries: BestiaryEntry[] }>(BESTIARY_URL, token);
  return res?.data.entries ?? [];
}
