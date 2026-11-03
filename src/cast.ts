// The cast: one list of people (abelon-manual/cast.json), shared by the extension, the DM
// panel and the manual's Cast page. A token is linked to a person by id; its real name, the
// placeholder players see and its stat block all follow from that link.
//
// Name hiding keeps the Abelon Namer's own token data ({ realName, placeholder, hidden } under
// com.abelon.namer/data), so tokens set up with the old Namer carry straight on.
import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { FORGE_KEYS } from "./forge";
import { BRANCH, REPO, encode, getGitHubToken, headers, readJson } from "./mailbox";

export const CAST_LINK_KEY = "com.abelon.cast/id";
export const NAMER_KEY = "com.abelon.namer/data";
const NAMER_CHARACTERS_KEY = "com.abelon.namer/characters"; // the old Namer's room list
const EXTRA_KEY = "com.abelon.cast/extra"; // people made in Owlbear, not yet in cast.json

export interface Person {
  id: string;
  name: string;
  aka?: string[];
  gender?: string | null;
  species?: string | null;
  statBlock?: string | null;
  role?: string | null;
  /** made in Owlbear (or carried over from the old Namer), waiting to be added to cast.json */
  extra?: boolean;
}
export interface NamerData {
  realName: string;
  placeholder: string;
  hidden: boolean;
}

const CAST_URL = "https://api.github.com/repos/coldsnapdev/abelon-manual/contents/cast.json?ref=main";
const EXTRA_FILE = "cast-extra.json";
const EXTRA_URL = `https://api.github.com/repos/${REPO}/contents/${EXTRA_FILE}`;

export const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = (s: string) => s.trim().toLowerCase();

let cache: { at: number; people: Person[]; generics: string[] } | undefined;
/** cast.json plus anyone made in Owlbear (or left over from the old Namer's room list). */
export async function loadCast(force = false): Promise<{ people: Person[]; generics: string[] }> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache;
  const res = await readJson<{ people: Person[]; generics?: string[] }>(CAST_URL, getGitHubToken()).catch(() => undefined);
  const people = res?.data.people ?? [];
  const known = new Set(people.map((p) => norm(p.name)));
  const extras = (await getExtras()).filter((p) => !known.has(norm(p.name)));
  cache = { at: Date.now(), people: [...people, ...extras].sort((a, b) => a.name.localeCompare(b.name)), generics: res?.data.generics ?? [] };
  return cache;
}
export function forgetCast() {
  cache = undefined;
}

// --- People made in Owlbear -------------------------------------------------------------
// Kept in the room (so they work straight away) and mirrored to the combat mailbox, where the
// manual's Cast page offers them for import into cast.json.
export async function getExtras(): Promise<Person[]> {
  const meta = await OBR.room.getMetadata();
  const mine = Array.isArray(meta[EXTRA_KEY]) ? (meta[EXTRA_KEY] as Person[]) : [];
  // the old Namer's room list: anyone it knew that the cast doesn't, so nothing is lost
  const old = Array.isArray(meta[NAMER_CHARACTERS_KEY]) ? (meta[NAMER_CHARACTERS_KEY] as { name: string; gender?: string; race?: string }[]) : [];
  const have = new Set(mine.map((p) => norm(p.name)));
  const carried = old
    .filter((c) => c?.name && !have.has(norm(c.name)))
    .map((c): Person => ({ id: `namer-${slug(c.name)}`, name: c.name, gender: c.gender ?? null, species: c.race ?? null, aka: [], statBlock: null, extra: true }));
  return [...mine.map((p) => ({ ...p, extra: true })), ...carried];
}
export async function addExtra(p: Person) {
  const meta = await OBR.room.getMetadata();
  const mine = Array.isArray(meta[EXTRA_KEY]) ? (meta[EXTRA_KEY] as Person[]) : [];
  const next = [...mine.filter((x) => x.id !== p.id), { ...p, extra: undefined }];
  await OBR.room.setMetadata({ [EXTRA_KEY]: next });
  forgetCast();
  mirrorExtras().catch((e) => console.warn("[abelon] couldn't mirror new people for the Cast page", e));
}
export async function mirrorExtras() {
  const token = getGitHubToken();
  if (!token) return;
  const extras = await getExtras();
  const current = await readJson<{ people: Person[] }>(`${EXTRA_URL}?ref=${BRANCH}`, token);
  const body = JSON.stringify({ savedAt: new Date().toISOString(), people: extras.map(({ extra, ...p }) => p) }, null, 1) + "\n";
  if (current && JSON.stringify(current.data.people) === JSON.stringify(extras.map(({ extra, ...p }) => p))) return;
  const r = await fetch(EXTRA_URL, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message: "People made in Owlbear, for the Cast page", branch: BRANCH, content: encode(body), ...(current ? { sha: current.sha } : {}) }),
  });
  if (!r.ok) throw new Error(`save ${r.status}`);
}

// --- Finding people ---------------------------------------------------------------------
/** Best matches for a typed or token name: exact full name, then short names, then partial. */
export function search(people: Person[], q: string): Person[] {
  const s = norm(q.replace(/\s*\d+$/, ""));
  if (!s) return people;
  const score = (p: Person) => {
    const names = [p.name, ...(p.aka ?? [])].map(norm);
    if (norm(p.name) === s) return 0;
    if (names.includes(s)) return 1;
    if (names.some((n) => n.startsWith(s))) return 2;
    if ([p.name, p.role ?? "", p.species ?? ""].join(" ").toLowerCase().includes(s)) return 3;
    return 9;
  };
  return people.map((p) => [p, score(p)] as const).filter(([, n]) => n < 9).sort((a, b) => a[1] - b[1] || a[0].name.localeCompare(b[0].name)).map(([p]) => p);
}
/** The one person a token's name clearly means (full name, or a short name only one person has). */
export function clearMatch(people: Person[], name: string): Person | undefined {
  const hits = search(people, name);
  if (!hits.length) return undefined;
  const s = norm(name.replace(/\s*\d+$/, ""));
  if (norm(hits[0].name) === s) return hits[0];
  const short = hits.filter((p) => (p.aka ?? []).map(norm).includes(s));
  return short.length === 1 ? short[0] : undefined;
}
export function linkedPerson(people: Person[], item: Item): Person | undefined {
  const id = item.metadata[CAST_LINK_KEY] as string | undefined;
  if (id) return people.find((p) => p.id === id);
  const real = (item.metadata[NAMER_KEY] as NamerData | undefined)?.realName;
  return real ? people.find((p) => norm(p.name) === norm(real)) : undefined;
}

// --- Names on tokens ----------------------------------------------------------------------
/** "Female Human 3": the next free number for that description in this scene. */
export async function nextPlaceholder(p: Pick<Person, "gender" | "species">): Promise<string> {
  const prefix = [p.gender || "Unknown", p.species].filter(Boolean).join(" ") || "Stranger";
  const items = await OBR.scene.items.getItems((i) => i.layer === "CHARACTER");
  const used = new Set(
    items
      .map((i) => (i.metadata[NAMER_KEY] as NamerData | undefined)?.placeholder ?? "")
      .filter((ph) => ph.startsWith(prefix + " "))
      .map((ph) => Number(ph.slice(prefix.length + 1))),
  );
  let n = 1;
  while (used.has(n)) n++;
  return `${prefix} ${n}`;
}
/** Write a name everywhere it shows: the token, its name plate, and the combat name. */
export function applyDisplayName(it: Item, display: string) {
  it.name = display;
  const t = (it as Item & { text?: { plainText?: string; richText?: unknown } }).text;
  if (t) {
    t.plainText = display;
    t.richText = [{ type: "paragraph", children: [{ text: display }] }];
  }
  it.metadata[FORGE_KEYS.name] = display;
}

/** Link tokens to a person; hide their name behind a placeholder unless told not to. */
export async function linkTokens(ids: string[], person: Person, hide: boolean) {
  const placeholders: Record<string, string> = {};
  const items = await OBR.scene.items.getItems(ids);
  for (const it of items) {
    const was = it.metadata[NAMER_KEY] as NamerData | undefined;
    const keep = was && was.realName === person.name && was.placeholder;
    placeholders[it.id] = keep ? was!.placeholder : await nextPlaceholder(person);
    // a second token for the same description shouldn't reuse the first one's number
    if (!keep) {
      await OBR.scene.items.updateItems([it.id], (its) => {
        for (const x of its) x.metadata[NAMER_KEY] = { realName: person.name, placeholder: placeholders[it.id], hidden: hide } satisfies NamerData;
      });
    }
  }
  await OBR.scene.items.updateItems(ids, (its) => {
    for (const it of its) {
      it.metadata[CAST_LINK_KEY] = person.id;
      it.metadata[NAMER_KEY] = { realName: person.name, placeholder: placeholders[it.id], hidden: hide } satisfies NamerData;
      applyDisplayName(it, hide ? placeholders[it.id] : person.name);
    }
  });
}
export async function setHidden(ids: string[], hidden: boolean) {
  await OBR.scene.items.updateItems(ids, (its) => {
    for (const it of its) {
      const d = it.metadata[NAMER_KEY] as NamerData | undefined;
      if (!d) continue;
      it.metadata[NAMER_KEY] = { ...d, hidden };
      applyDisplayName(it, hidden ? d.placeholder : d.realName);
    }
  });
}

// --- Inventing a surname ------------------------------------------------------------------
// Short, worn, Abelon-sounding; checked against the whole cast so a full name never repeats.
const SURNAMES = [
  "Ashby", "Barrow", "Blackwood", "Brannock", "Carrow", "Colter", "Dunmore", "Elsworth", "Fairlie", "Fenwick", "Garrow", "Greaves",
  "Hallow", "Harrow", "Kestrel", "Larke", "Lowell", "Marlow", "Merrin", "Nettle", "Orrin", "Pellow", "Quarry", "Redgrave",
  "Rook", "Sallow", "Scarrow", "Thatcher", "Tolley", "Underhill", "Varrow", "Wexley", "Whitlow", "Wickham", "Yarrow", "Bellweather",
  "Copperfield", "Draycott", "Emberly", "Foxley", "Gilder", "Hobb", "Ivell", "Jessop", "Kettle", "Lamb", "Mossop", "Nayle",
];
export function suggestSurname(people: Person[], first: string): string {
  const taken = new Set(people.map((p) => norm(p.name)));
  const pool = SURNAMES.filter((s) => !taken.has(norm(`${first} ${s}`)) && !people.some((p) => norm(p.name).endsWith(` ${norm(s)}`)));
  const from = pool.length ? pool : SURNAMES.filter((s) => !taken.has(norm(`${first} ${s}`)));
  return from[Math.floor(Math.random() * from.length)] ?? "Ashby";
}
