// Standalone DM panel. A plain page opened as its own tab (any browser, any
// device) — not an Owlbear extension page, so it has no OBR SDK access. It
// reads the combat roster that the extension saves to the GitHub mailbox
// (see mailbox.ts), matches each combatant to a bestiary entry from the DM
// manual, lets the DM roll from the stat block, and posts the results to
// Discord with flavour text (and full spell text) for the table.
import { BUILD } from "./build";
import { liveBuild } from "./refresh";
import { liveCode, liveTopic, onOwlbear, owlbearBuild, owlbearWindow, publishLive, relayStatus, sendDirect, sendLocal, type HpMessage, type HpResult, type LiveCombatant, type LiveMessage } from "./live";
import {
  loadAssignments,
  loadBestiary,
  loadRosterWith,
  loadSpells,
  saveAssignments,
  type Assignments,
  type BestiaryEntry,
  type RosterEntry,
  type RosterFile,
  type Spell,
  loadStatuses,
  saveStatuses,
  sendCommand,
  type TokenStatus,
  type ShowRollCommand,
} from "./mailbox";
import { STATUS_DEFS, statusDef, tokenText, CUSTOM_COLOUR } from "./statuses";
import type { ShownDie, ShownRoll } from "./diceTypes";

const F = "com.battle-system.forge/";
const TOKEN_KEY = "dm-panel/github-token";
const WEBHOOK_KEY = "dm-panel/discord-webhook";
const PUBLIC_KEY = "dm-panel/public";
// The DM manual (coldsnapdev.github.io/abelon-manual) lives on the same origin
// as this panel, so it shares localStorage: reuse its sync token if present.
const MANUAL_TOKEN_KEY = "abelonSyncToken";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $<HTMLElement>("app");
const updateBtn = $<HTMLButtonElement>("update-roster");
const meta = $<HTMLElement>("roster-meta");
const publicToggle = $<HTMLInputElement>("public-toggle");
const publicLabel = $<HTMLElement>("public-label");

let roster: RosterFile | undefined;
let bestiary: BestiaryEntry[] = [];
let spells: Spell[] = [];
let assignments: Assignments = {};
let statuses: Record<string, TokenStatus[]> = {};
const open = new Set<string>(); // itemIds whose stat block is expanded
const checksOpen = new Set<string>(); // itemIds whose "Saves & checks" drawer is open
const checkMode = new Map<string, "adv" | "dis">(); // advantage/disadvantage for that token's next save or check

// --- Local settings ------------------------------------------------------------------
function store(key: string, value?: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
}
const getToken = () => read(TOKEN_KEY) || read(MANUAL_TOKEN_KEY);
const getWebhook = () => read(WEBHOOK_KEY);
const isPublic = () => read(PUBLIC_KEY) !== "no";

function renderSettings() {
  const hasToken = !!getToken();
  const hasHook = !!getWebhook();
  showLiveCode();
  ($<HTMLInputElement>("gh-token")).placeholder = hasToken ? "•••••••• (saved)" : "GitHub token";
  ($<HTMLInputElement>("discord-webhook")).placeholder = hasHook ? "•••••••• (saved)" : "Discord webhook URL";
  const status = $<HTMLElement>("token-status");
  status.textContent = [
    hasToken ? "GitHub token found: stat block choices are saved for every device." : "No GitHub token: stat block choices can't be saved.",
    hasHook ? "Discord webhook set." : "No Discord webhook: public rolls won't post anywhere.",
  ].join(" ");
  status.className = hasToken && hasHook ? "hint" : "hint warn";
  publicToggle.checked = isPublic();
  publicLabel.textContent = isPublic() ? "Public rolls" : "Private rolls";
  document.body.classList.toggle("private", !isPublic());
}

$<HTMLButtonElement>("save-gh-token").addEventListener("click", () => {
  store(TOKEN_KEY, $<HTMLInputElement>("gh-token").value.trim());
  $<HTMLInputElement>("gh-token").value = "";
  renderSettings();
});
$<HTMLButtonElement>("save-webhook").addEventListener("click", () => {
  store(WEBHOOK_KEY, $<HTMLInputElement>("discord-webhook").value.trim());
  $<HTMLInputElement>("discord-webhook").value = "";
  renderSettings();
});
// Status chips on the character boxes: shown unless switched off (remembered per browser).
const CHIPS_KEY = "dm-panel/tile-statuses";
const chipsToggle = $<HTMLInputElement>("chips-toggle");
chipsToggle.checked = read(CHIPS_KEY) !== "no";
document.body.classList.toggle("hide-tile-status", !chipsToggle.checked);
chipsToggle.addEventListener("change", () => {
  store(CHIPS_KEY, chipsToggle.checked ? undefined : "no");
  document.body.classList.toggle("hide-tile-status", !chipsToggle.checked);
});

// the live roll channel's code: should match the one in the Owlbear extension's popover
// the fast routes to Owlbear: the direct link when this panel was opened from Owlbear's
// own link, otherwise the local relay (abelon-relay.mjs) if it's running
async function fastSend(msg: LiveMessage): Promise<boolean> {
  if (await sendDirect(msg)) return true;
  return (await sendLocal("owlbear", msg)) > 0;
}

// --- HP history: every change to a combatant's HP, whoever made it ----------------------
// For settling "how did I get to 9?" at the table. Built by comparing each live roster
// with the last HP seen for that token (kept in this browser, so changes made while the
// panel was shut still show up when it reopens). A change the panel itself asked for
// carries its reason; anything else is put down to the sheet or to Owlbear.
interface HpLogEntry { at: number; round: number; turn?: string; hp: number; temp: number; was: number; wasTemp: number; why: string }
interface HpLogStore { last: Record<string, { hp: number; temp: number }>; log: Record<string, HpLogEntry[]> }
const HP_LOG_KEY = "abelon.hpLog.v1";
const HP_LOG_KEEP_MS = 3 * 24 * 3600_000;
const hpWhy = new Map<string, { why: string; until: number }>();
function loadHpLog(): HpLogStore {
  try {
    const s = JSON.parse(localStorage.getItem(HP_LOG_KEY) || "null");
    if (s && typeof s === "object" && s.last && s.log) return s as HpLogStore;
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return { last: {}, log: {} };
}
const hpLog = loadHpLog();
function saveHpLog() {
  try { localStorage.setItem(HP_LOG_KEY, JSON.stringify(hpLog)); } catch { /* keep it in memory only */ }
}
/** say why the panel is about to change this token's HP, so the history can show it */
function noteHp(itemId: string, why: string) {
  hpWhy.set(itemId, { why, until: Date.now() + 20_000 });
}
function trackHp(list: LiveCombatant[], round: number, turnName?: string) {
  const now = Date.now();
  let changed = false;
  for (const c of list) {
    if (typeof c.hp !== "number" || !Number.isFinite(c.hp)) continue; // no reading this time: wait for one
    const temp = c.tempHp ?? 0;
    const prev = hpLog.last[c.itemId];
    if (prev && (prev.hp !== c.hp || prev.temp !== temp)) {
      const note = hpWhy.get(c.itemId);
      const why = note && note.until > now ? note.why : c.sheet ? "Changed on their DiceCloud sheet" : "Changed in Owlbear";
      hpWhy.delete(c.itemId);
      const rows = (hpLog.log[c.itemId] ??= []);
      rows.push({ at: now, round, turn: turnName, hp: c.hp, temp, was: prev.hp, wasTemp: prev.temp, why });
      if (rows.length > 100) rows.splice(0, rows.length - 100);
    }
    if (!prev || prev.hp !== c.hp || prev.temp !== temp) {
      hpLog.last[c.itemId] = { hp: c.hp, temp };
      changed = true;
    }
  }
  for (const [id, rows] of Object.entries(hpLog.log)) {
    const kept = rows.filter((r) => now - r.at < HP_LOG_KEEP_MS);
    if (kept.length !== rows.length) {
      changed = true;
      if (kept.length) hpLog.log[id] = kept;
      else delete hpLog.log[id];
    }
  }
  if (changed) saveHpLog();
}
function hpHistory(itemId: string): string {
  const rows = hpLog.log[itemId];
  if (!rows?.length) return "";
  const fmt = (hp: number, temp: number) => `${hp}${temp ? `<small>+${temp}</small>` : ""}`;
  const items = rows.slice().reverse().map((r) => {
    const d = r.hp + r.temp - (r.was + r.wasTemp);
    const time = new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const when = r.round ? `R${r.round}${r.turn ? ` · ${escapeHtml(r.turn)}` : ""}` : "Out of combat";
    return `<li><span class="hl-when">${time} · ${when}</span><span class="hl-hp">${fmt(r.was, r.wasTemp)} → <b>${fmt(r.hp, r.temp)}</b> <em class="${d < 0 ? "down" : "up"}">${d > 0 ? "+" : ""}${d}</em></span><span class="hl-why">${escapeHtml(r.why)}</span></li>`;
  }).join("");
  return `<details class="hp-log"><summary>HP history (${rows.length})</summary><ul>${items}</ul></details>`;
}
async function showLink() {
  const linked = await sendDirect({ kind: "ping", id: crypto.randomUUID(), at: new Date().toISOString() });
  const relay = linked ? undefined : await relayStatus();
  const stale = linked && owlbearBuild !== undefined && owlbearBuild !== BUILD;
  $("relay-status").classList.toggle("warn", stale);
  const warnEl = $("stale-warning");
  warnEl.hidden = !stale;
  warnEl.textContent = stale ? `Owlbear is still running ${owlbearBuild ? `build ${owlbearBuild}` : "an older build"} of the extension (this panel is build ${BUILD}). Reload the Owlbear tab, then reopen this panel from the popover link.` : "";
  $("relay-status").textContent = linked
    ? `Linked to Owlbear${owlbearBuild ? ` (build ${owlbearBuild})` : ""} — rolls, statuses and stat blocks go straight to the table`
    : relay?.owlbear
      ? "Linked to Owlbear through the local relay"
      : owlbearWindow()
        ? "Owlbear tab found but not answering yet (open a scene; reload Owlbear if this stays)"
        : "Not linked: open this panel from the Owlbear extension's \"Open DM panel\" link for instant rolls";
  setTimeout(showLink, 5000);
}
showLink();

// --- Live from Owlbear: the roster (with HP) and the GM's selection ---------------------
let liveRoster: LiveCombatant[] | undefined;
let turnId: string | undefined; // the active combatant
let round = 0;
let autoOpened: string | undefined;
let scrollToTurn = false;
let lastLiveFp = "";
const asEntry = (c: LiveCombatant): RosterEntry => ({ itemId: c.itemId, name: c.name, realName: c.realName, initiative: c.initiative, ac: c.ac, hp: c.hp, maxHp: c.maxHp, tempHp: c.tempHp, hasInit: c.hasInit, visible: c.visible, dex: c.dex, sheet: c.sheet, ally: c.ally, standby: c.standby, fallen: c.fallen });
onOwlbear((m) => {
  if (m.kind === "reload") {
    // the extension was just updated: fetch this page fresh and reload (the link comes back by itself)
    liveBuild().then((v) => location.replace(`dm-panel.html?v=${v ?? Date.now()}`));
    return;
  }
  if (m.kind === "roster") {
    // Forge's turn moved on: highlight the new combatant and open their card (closing the
    // previous one only if it was opened for its turn, not by hand)
    round = m.round ?? 0;
    if (m.turn !== turnId) {
      if (turnId && autoOpened === turnId) open.delete(turnId);
      turnId = m.turn;
      autoOpened = turnId && !open.has(turnId) ? turnId : undefined;
      if (turnId) open.add(turnId);
      scrollToTurn = !!turnId;
      lastLiveFp = "";
    }
    const fp = JSON.stringify(m.combatants);
    if (fp === lastLiveFp) return;
    lastLiveFp = fp;
    liveRoster = m.combatants;
    syncFallen(m.combatants);
    trackHp(m.combatants, round, m.combatants.find((c) => c.itemId === turnId)?.name);
    roster = { savedAt: new Date().toISOString(), combatants: m.combatants.map(asEntry) };
    const ids = new Set(m.combatants.map((c) => c.itemId));
    if (targets.some((id) => !ids.has(id))) setTargets(targets.filter((id) => ids.has(id)));
    meta.textContent = "Live from Owlbear";
    meta.className = "";
    if (!busyTyping()) render();
  } else if (m.kind === "selection") {
    if (!followSelection()) return;
    const onList = m.ids.filter((id) => roster?.combatants.some((c) => c.itemId === id));
    if (onList.length) setTargets(onList); // clicking empty map space doesn't clear your targets
  }
});
// don't redraw under someone typing a custom status
const busyTyping = () => document.activeElement instanceof HTMLInputElement && ["st-custom", "pc-init-in", "hp-in"].some((c) => (document.activeElement as HTMLElement).classList.contains(c));

// --- Targets ----------------------------------------------------------------------------
let targets: string[] = [];
const FOLLOW_KEY = "dm-panel/follow-selection";
const followSelection = () => read(FOLLOW_KEY) !== "no";
function setTargets(ids: string[]) {
  targets = [...new Set(ids)];
  syncResolveTargets();
  fastSend({ kind: "targets", id: crypto.randomUUID(), at: new Date().toISOString(), ids: targets });
  render();
}
const combatant = (id: string) => roster?.combatants.find((c) => c.itemId === id);
function targetBar(): string {
  const chips = targets.map((id) => combatant(id)).filter((c): c is RosterEntry => !!c);
  if (!chips.length) return "";
  return `<div class="target-bar"><span class="tb-label">Target${chips.length === 1 ? "" : "s"}</span>${
    chips.length
      ? chips.map((c) => `<span class="tb-chip">${escapeHtml(c.name)}${c.ac !== undefined ? ` <small>AC ${c.ac}</small>` : ""}<button type="button" class="tb-x" data-id="${escapeHtml(c.itemId)}" title="Drop this target">×</button></span>`).join("") +
        `<button type="button" class="tb-clear">Clear</button>`
      : `<span class="tb-hint">${owlbearWindow() ? "Select tokens in Owlbear, or tap ◎ on a tile" : "Tap ◎ on a tile"}</span>`
  }</div>`;
}
/** "hits Idony, misses Radek" against each target's AC; undefined when nobody's targeted. */
const lastHits = new Map<string, Map<string, boolean | undefined>>(); // action key -> target -> hit?
function versus(total: number, nat?: "crit" | "fumble", key?: string): { dm: string; pub: string; tag: string } | undefined {
  const list = targets.map((id) => combatant(id)).filter((c): c is RosterEntry => !!c);
  if (!list.length) return undefined;
  const rows = list.map((c) => {
    const hit = nat === "crit" ? true : nat === "fumble" ? false : c.ac === undefined ? undefined : total >= c.ac;
    return { c, hit };
  });
  if (key) lastHits.set(key, new Map(rows.map(({ c, hit }) => [c.itemId, hit])));
  const word = (h: boolean | undefined) => (h === undefined ? "vs" : h ? "hits" : "misses");
  return {
    dm: rows.map(({ c, hit }) => `${word(hit)} <b>${escapeHtml(c.realName || c.name)}</b>${c.ac !== undefined ? ` <span class="how">AC ${c.ac}</span>` : ""}`).join(", "),
    pub: rows.map(({ c, hit }) => `${hit === undefined ? "Against" : hit ? "Hits" : "Misses"} ${c.name}`).join(" · "),
    tag: rows.map(({ c, hit }) => `${hit === undefined ? "vs" : hit ? "Hits" : "Misses"} ${c.name}`).join(" · "),
  };
}
async function showLiveCode() {
  const token = getToken();
  $("live-code").textContent = token ? `Live roll channel: ${liveCode(await liveTopic(token))} (should match the code in the Owlbear extension)` : "";
}
// "Test DiceCloud write": a 0-point change on every sheet-linked combatant
const testRefs = new Map<string, string>();
const testOut: string[] = [];
$("dc-test").addEventListener("click", async () => {
  const sheets = (liveRoster ?? []).filter((c) => c.sheet);
  testOut.length = 0;
  $("dc-test-result").textContent = sheets.length
    ? `Testing ${sheets.map((c) => c.realName || c.name).join(", ")}…`
    : liveRoster
      ? "None of the combatants on Forge's list is linked to a DiceCloud sheet."
      : "No live roster: open this panel from the Owlbear extension's link (with the party on Forge's list).";
  setTimeout(() => {
    if (!testRefs.size) return;
    for (const name of testRefs.values()) testOut.push(`${name}: no answer from Owlbear (reload the Owlbear tab; it may be running an older build)`);
    testRefs.clear();
    $("dc-test-result").textContent = testOut.join(" · ");
  }, 15000);
  for (const c of sheets) {
    const ref = crypto.randomUUID();
    testRefs.set(ref, c.realName || c.name);
    if (!(await fastSend({ kind: "hp", id: ref, at: new Date().toISOString(), itemId: c.itemId, test: true }))) {
      testOut.push(`${c.realName || c.name}: Owlbear not linked`);
    }
  }
});
onOwlbear((m) => {
  if (m.kind !== "hp-result" || !testRefs.has(m.ref)) return;
  testOut.push(`${testRefs.get(m.ref)}: ${m.ok ? "✓ can write" : `✗ ${m.error}`}`);
  testRefs.delete(m.ref);
  $("dc-test-result").textContent = testOut.join(" · ");
});
const followToggle = $<HTMLInputElement>("follow-selection");
followToggle.checked = followSelection();
followToggle.addEventListener("change", () => store(FOLLOW_KEY, followToggle.checked ? undefined : "no"));
const diceToggle = $<HTMLInputElement>("dice-owlbear");
diceToggle.checked = read("dm-panel/dice-in-owlbear") !== "no";
diceToggle.addEventListener("change", () => store("dm-panel/dice-in-owlbear", diceToggle.checked ? undefined : "no"));

publicToggle.addEventListener("change", () => {
  store(PUBLIC_KEY, publicToggle.checked ? undefined : "no");
  renderSettings();
});

// --- Matching ------------------------------------------------------------------------
const norm = (s: string) => s.trim().toLowerCase();

/** Real name first (the Namer's), then Forge's name; also tries without a trailing number ("Blighted Wolf 3"). */
function autoMatch(c: RosterEntry): BestiaryEntry | undefined {
  const byName = new Map(bestiary.map((e) => [norm(e.name), e]));
  for (const n of [c.realName, c.name]) {
    if (!n) continue;
    const hit = byName.get(norm(n)) ?? byName.get(norm(n.replace(/\s*\d+$/, "")));
    if (hit) return hit;
  }
  return undefined;
}

function entryFor(c: RosterEntry): { entry?: BestiaryEntry; manual: boolean } {
  const chosen = assignments[c.itemId];
  if (chosen) {
    const e = bestiary.find((b) => b.id === chosen);
    if (e) return { entry: e, manual: true };
  }
  return { entry: autoMatch(c), manual: false };
}

// --- Dice -------------------------------------------------------------------------------
// Forge writes dice in square brackets: [1d20+7] is a to-hit roll, anything
// else is damage or other dice. To-hit and damage are deliberately separate
// clicks. With targets chosen, the to-hit is also compared against each target's AC.
const DICE_RE = /^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i;

interface Roll { total: number; dice: number[]; mod: number; kept?: number; sides: number }

function randInt(sides: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % sides) + 1;
}

function rollExpr(expr: string, opts: { double?: boolean; mode?: "adv" | "dis" } = {}): Roll | undefined {
  const m = expr.replace(/\s+/g, "").match(DICE_RE);
  if (!m) return undefined;
  let count = Number(m[1] || 1);
  const sides = Number(m[2]);
  const mod = m[3] ? Number(m[3].replace(/\s+/g, "")) : 0;
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return undefined;
  if (opts.double) count *= 2;
  if (sides === 20 && count === 1 && opts.mode) {
    const a = randInt(20), b = randInt(20);
    const kept = opts.mode === "adv" ? Math.max(a, b) : Math.min(a, b);
    return { total: kept + mod, dice: [a, b], mod, kept, sides };
  }
  const dice = Array.from({ length: count }, () => randInt(sides));
  return { total: dice.reduce((x, y) => x + y, 0) + mod, dice, mod, sides };
}

const signed = (n: number) => (n === 0 ? "" : n > 0 ? ` + ${n}` : ` − ${-n}`);
const working = (r: Roll) => `${r.dice.join(" + ")}${signed(r.mod)}`;

// --- Parsing a Forge action ----------------------------------------------------------
const DAMAGE_TYPES = new Set(["acid","bludgeoning","cold","fire","force","lightning","necrotic","piercing","poison","psychic","radiant","slashing","thunder","healing"]);
const ABILITIES: Record<string, string> = { strength: "Str", dexterity: "Dex", constitution: "Con", intelligence: "Int", wisdom: "Wis", charisma: "Cha", str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };

type Category = "action" | "bonus" | "reaction" | "legendary" | "trait" | "tactics";
interface DieSpec { expr: string; type: string }
interface ParsedAction {
  title: string;
  category: Category;
  hit?: { expr: string; mod: number };
  damage: DieSpec[]; // typed damage, rolled together by one "Damage" button
  extras: DieSpec[]; // untyped dice ("add [1d6] if…"), rolled individually
  dcs: string[];
  text: string; // HTML for the panel
  plain: string; // plain rules text for Discord
}

function categorise(name: string): { category: Category; title: string } {
  const strip = (re: RegExp) => name.replace(re, "").trim();
  if (/^tactics/i.test(name)) return { category: "tactics", title: "Tactics" };
  if (/^trait:|\(trait\)/i.test(name)) return { category: "trait", title: strip(/^trait:\s*|\s*\(trait\)/gi) };
  if (/^bonus action:|\(bonus action\)/i.test(name)) return { category: "bonus", title: strip(/^bonus action:\s*|\s*\(bonus action\)/gi) };
  if (/^reaction:|\(reaction\)/i.test(name)) return { category: "reaction", title: strip(/^reaction:\s*|\s*\(reaction\)/gi) };
  if (/legendary/i.test(name)) return { category: "legendary", title: strip(/^legendary( action)?:\s*|\s*\(legendary( action)?\)/gi) };
  return { category: "action", title: name };
}

function parseAction(a: { name: string; description: string }, forced?: Category): ParsedAction {
  const cat = categorise(a.name);
  const category = forced && cat.category !== "tactics" ? forced : cat.category;
  const title = forced && forced !== "action" ? cat.title.replace(/^(trait|bonus action|reaction|legendary( action)?):\s*/i, "") : cat.title;
  const p: ParsedAction = { title, category, damage: [], extras: [], dcs: [], text: "", plain: "" };
  const re = /\[([^\]]+)\]\s*([A-Za-z]+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(a.description))) {
    const expr = m[1].trim();
    const d = expr.replace(/\s+/g, "").match(DICE_RE);
    if (!d) continue;
    if (Number(d[2]) === 20 && Number(d[1] || 1) === 1) {
      if (!p.hit) p.hit = { expr, mod: Number((d[3] || "0").replace(/\s+/g, "")) };
      continue;
    }
    const word = (m[2] || "").toLowerCase();
    if (DAMAGE_TYPES.has(word)) p.damage.push({ expr, type: word });
    else if (word === "hit") p.extras.push({ expr, type: "hit points" });
    else p.extras.push({ expr, type: "" });
  }
  // DCs from the name too ("Command (DC 16 Wisdom save)"), so they still reach the post
  p.dcs = [...new Set(Array.from(`${a.name} ${a.description}`.matchAll(/DC\s*(\d+)\s+([A-Za-z]+)/g)).map((x) => `DC ${x[1]} ${ABILITIES[x[2].toLowerCase()] ?? x[2]}`))];
  p.text = escapeHtml(a.description).replace(/\[([^\]]+)\]/g, '<span class="dice">$1</span>');
  p.plain = a.description.replace(/\[([^\]]+)\]/g, "$1");
  return p;
}

function spellFor(title: string): Spell | undefined {
  const base = norm(title.replace(/\s*\(.*$/, ""));
  return spells.find((s) => norm(s.name) === base);
}

// --- Discord ------------------------------------------------------------------------
const COLOUR = { brass: 0xc9a25e, crit: 0x5fb39b, fumble: 0xc0614a, dice: 0x75674f };

interface Embed {
  author?: { name: string };
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function postToDiscord(embed: Embed, privateRoll: boolean): Promise<"posted" | "private" | "no-webhook" | "failed"> {
  if (privateRoll) return "private";
  const hook = getWebhook();
  if (!hook) return "no-webhook";
  embed.description = embed.description ? clip(embed.description, 4000) : undefined;
  try {
    const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embeds: [embed] }) });
    return r.ok ? "posted" : "failed";
  } catch {
    return "failed";
  }
}

function spellBlock(s: Spell): string {
  return `**${s.name}** · *${s.level}*\n**Casting Time:** ${s.castingTime} · **Range:** ${s.range} · **Components:** ${s.components} · **Duration:** ${s.duration}\n${s.text}`;
}

// --- Action registry (buttons refer to actions by key) ------------------------------
interface ActionCtx {
  key: string;
  itemId: string;
  dmName: string; // what the DM sees (real name)
  shown: string; // what players see (Forge/placeholder name) — the only name sent to Discord
  entry: BestiaryEntry;
  raw: { name: string; description: string };
  p: ParsedAction;
}
const actions = new Map<string, ActionCtx>();

interface LogLine { who: string; action: string; text: string; tone?: "crit" | "fumble"; status?: string }
const rollLog: LogLine[] = [];
const lastResult = new Map<string, string>(); // button key -> short result shown beside it
const critPending = new Set<string>(); // action keys after a natural 20, until that action's next to-hit
let freshKey: string | undefined;

function flavour(ctx: ActionCtx): string | undefined {
  const lines = ctx.entry.flavour?.[ctx.raw.name];
  if (!lines?.length) return undefined;
  return lines[randInt(lines.length) - 1].replace(/\{name\}/g, ctx.shown);
}

/** The ability name as players see it: name brackets (uses, slots, recharge, x2) stay in the panel. */
const publicName = (ctx: ActionCtx) => ctx.p.title.replace(/\s*\([^)]*\)/g, "").trim() || ctx.p.title;

/** Flavour (or the rules text) plus full spell text, for attack and "use" posts. */
function describe(ctx: ActionCtx): string {
  const parts = [flavour(ctx) ?? ctx.p.plain];
  const spell = spellFor(ctx.p.title);
  if (spell) parts.push(spellBlock(spell));
  return parts.join("\n\n");
}

type DiceShow = Omit<ShownRoll, "id" | "private">;
// Dice in Owlbear: the roll goes through the mailbox to the GM's Owlbear tab, which shows it
// to everyone (or only the GM, for private rolls). The Discord post waits for the dice to land.
const DICE_KEY = "dm-panel/dice-in-owlbear";
const diceEnabled = () => read(DICE_KEY) !== "no";
// Discord waits until the dice have landed in Owlbear: sooner when the roll went live
const DISCORD_AFTER_LIVE_DICE_MS = 3500;
const DISCORD_AFTER_DICE_MS = 5000; // GitHub route
/** Sends the dice to Owlbear. Undefined if not shown; otherwise resolves to whether it went live. */
function showDice(show: DiceShow, privateRoll: boolean): Promise<boolean> | undefined {
  const token = getToken();
  if (!diceEnabled() || !token || !show.dice.length) return undefined;
  const id = crypto.randomUUID();
  const cmd: ShowRollCommand = { id, at: new Date().toISOString(), kind: "show-roll", roll: { ...show, id, private: privateRoll } };
  // live channel first (near-instant); GitHub as the backup, which Owlbear skips if the
  // live copy already arrived
  return (async () => {
    // 1. straight to Owlbear (direct link, or the relay): instant, private
    if (await fastSend(cmd)) return true;
    // 2. ntfy.sh, with the GitHub mailbox behind it in case that doesn't arrive either
    const live = await publishLive(token, cmd);
    sendCommand(cmd, token).catch(() => {});
    return live;
  })();
}
const d20s = (r: Roll, tint: string): ShownDie[] =>
  r.kept === undefined
    ? [{ sides: 20, value: r.dice[0], tint }]
    : r.dice.map((v, i) => ({ sides: 20, value: v, tint, kept: i === r.dice.indexOf(r.kept!) }));
const diceOf = (r: Roll, tint: string): ShownDie[] => r.dice.map((v) => ({ sides: r.sides, value: v, tint }));

async function log(line: LogLine, embed: Embed, privateRoll = !isPublic(), dice?: DiceShow) {
  rollLog.unshift(line);
  rollLog.splice(15);
  render();
  const shown = dice ? showDice(dice, privateRoll) : undefined;
  if (shown && !privateRoll) {
    line.status = "Rolling in Owlbear…";
    renderLog();
    const t0 = Date.now();
    const wait = (await shown) ? DISCORD_AFTER_LIVE_DICE_MS : DISCORD_AFTER_DICE_MS;
    await new Promise((r) => setTimeout(r, Math.max(0, wait - (Date.now() - t0))));
  }
  const status = await postToDiscord(embed, privateRoll);
  line.status = status === "posted" ? "" : status === "private" ? "Private" : status === "no-webhook" ? "Not posted: no webhook" : "Discord post failed";
  renderLog();
}

// --- Recharge ------------------------------------------------------------------------
// "Recharge 5-6" abilities are spent when used and come back on a d6 roll at the start
// of the creature's turn. Spent state survives a panel reload (per browser).
const RECHARGE_KEY = "dm-panel/recharge-spent";
const spent = new Set<string>(JSON.parse(read(RECHARGE_KEY) || "[]") as string[]);
const saveSpent = () => store(RECHARGE_KEY, spent.size ? JSON.stringify([...spent]) : undefined);
const spentKey = (ctx: ActionCtx) => `${ctx.itemId}|${ctx.raw.name}`;
function rechargeMin(name: string): number | undefined {
  const m = name.match(/recharge\s*(\d)(?:\s*[–-]\s*\d)?/i);
  return m ? Number(m[1]) : undefined;
}
function markUsed(ctx: ActionCtx) {
  if (rechargeMin(ctx.raw.name) === undefined) return;
  spent.add(spentKey(ctx));
  saveSpent();
}
function doRecharge(ctx: ActionCtx) {
  const min = rechargeMin(ctx.raw.name)!;
  const d = randInt(6);
  const back = d >= min;
  if (back) spent.delete(spentKey(ctx));
  saveSpent();
  lastResult.set(`${ctx.key}|rc`, `<b>${d}</b> ${back ? `<em class="crit">ready</em>` : "still spent"}`);
  freshKey = `${ctx.key}|rc`;
  log(
    { who: ctx.dmName, action: ctx.p.title, text: `<span class="big">${d}</span> recharge <span class="how">needs ${min}+</span> ${back ? `<em class="crit">Ready</em>` : "Still spent"}`, tone: back ? "crit" : undefined },
    { description: "" },
    true, // recharge rolls are the DM's business
    { who: ctx.shown, action: `${publicName(ctx)} recharge`, dice: [{ sides: 6, value: d, tint: "ivory" }], results: [{ value: d, label: back ? "recharged" : "still spent" }], tone: back ? "crit" : undefined },
  );
}
function setReady(ctx: ActionCtx) {
  spent.delete(spentKey(ctx));
  saveSpent();
  lastResult.delete(`${ctx.key}|rc`);
  render();
}

function doAttack(ctx: ActionCtx, mode?: "adv" | "dis") {
  const r = rollExpr(ctx.p.hit!.expr, { mode });
  if (!r) return;
  markUsed(ctx);
  const d20 = r.kept ?? r.dice[0];
  const nat = d20 === 20 ? "crit" : d20 === 1 ? "fumble" : undefined;
  if (nat === "crit") critPending.add(ctx.key);
  else critPending.delete(ctx.key);
  const how = r.kept !== undefined ? `d20 ${r.dice.join(" / ")} ${mode === "adv" ? "with advantage" : "with disadvantage"}${signed(r.mod)}` : `d20 ${d20}${signed(r.mod)}`;
  const tag = nat === "crit" ? "Natural 20!" : nat === "fumble" ? "Natural 1" : "";
  const vs = versus(r.total, nat, ctx.key);
  lastResult.set(`${ctx.key}|hit`, `<b>${r.total}</b>${tag ? ` <em class="${nat}">${tag}</em>` : ""}`);
  freshKey = `${ctx.key}|hit`;
  log(
    { who: ctx.dmName, action: ctx.p.title, text: `<span class="big">${r.total}</span> to hit <span class="how">${how}</span>${tag ? ` <em class="${nat}">${tag}</em>` : ""}${vs ? `<br>${vs.dm}` : ""}`, tone: nat },
    {
      author: { name: ctx.shown },
      title: publicName(ctx),
      description: `${describe(ctx)}\n\n**To hit: ${r.total}** (${how})${tag ? ` — **${tag}**` : ""}${vs ? `\n**${vs.pub}**` : ""}`,
      color: nat ? COLOUR[nat] : COLOUR.brass,
    },
    undefined,
    { who: ctx.shown, action: publicName(ctx), dice: d20s(r, "brass"), mod: r.mod, results: [{ value: r.total, label: "to hit" }], detail: how, tag: [tag.replace("!", ""), vs?.tag].filter(Boolean).join(" · ") || undefined, tone: nat },
  );
}

/** No to-hit roll means no second stage: Use/Cast rolls every die in the ability and posts it all at once. */
function doUse(ctx: ActionCtx) {
  markUsed(ctx);
  const dice = [...ctx.p.damage, ...ctx.p.extras].map((d) => ({ d, r: rollExpr(d.expr)! })).filter((x) => x.r);
  const label = (d: DieSpec) => (DAMAGE_TYPES.has(d.type) && d.type !== "healing" ? `${d.type} damage` : d.type === "healing" ? "hit points" : d.type || d.expr);
  lastResult.set(`${ctx.key}|use`, dice.length ? `<b>${dice.map((x) => x.r.total).join(" + ")}</b>` : `<em>posted</em>`);
  freshKey = `${ctx.key}|use`;
  const dcs = ctx.p.dcs.length ? `\n\n**${ctx.p.dcs.join(" · ")}**` : "";
  // Save-for-half abilities also show the halved figure (rounded down) for anyone who saves.
  const halves = /half as much|half damage|half on a success|half the damage|, half on/i.test(ctx.raw.description);
  const half = (x: { d: DieSpec; r: Roll }) => (halves && DAMAGE_TYPES.has(x.d.type) && x.d.type !== "healing" ? ` (**${Math.floor(x.r.total / 2)}** on a successful save)` : "");
  const rolled = dice.length ? `\n\n${dice.map((x) => `**${x.r.total}** ${label(x.d)}${half(x)}`).join("\n")}` : "";
  const hpParts = dice.filter((x) => DAMAGE_TYPES.has(x.d.type) || x.d.type === "hit points").map((x) => ({ type: x.d.type === "hit points" ? "healing" : x.d.type, amount: x.r.total }));
  startResolve(ctx, hpParts, { dc: ctx.p.dcs.find((d) => / (Str|Dex|Con|Int|Wis|Cha)$/.test(d)), half: halves });
  log(
    {
      who: ctx.dmName,
      action: ctx.p.title,
      text: dice.length
        ? dice.map((x) => `<span class="big">${x.r.total}</span> ${escapeHtml(label(x.d))}${half(x) ? ` <span class="how">(${Math.floor(x.r.total / 2)} on a save)</span>` : ""} <span class="how">${working(x.r)}</span>`).join("<br>")
        : `uses ${escapeHtml(ctx.p.title)}`,
    },
    {
      author: { name: ctx.shown },
      title: publicName(ctx),
      description: describe(ctx) + dcs + rolled,
      color: COLOUR.brass,
    },
    undefined,
    dice.length
      ? {
          who: ctx.shown,
          action: publicName(ctx),
          dice: dice.flatMap((x) => diceOf(x.r, x.d.type === "hit points" ? "healing" : x.d.type || "brass")),
          mod: dice.reduce((a, x) => a + x.r.mod, 0),
          results: dice.map((x) => ({ value: x.r.total, label: label(x.d), tint: x.d.type === "hit points" ? "healing" : x.d.type })),
          detail: halves ? `Half on a successful save: ${dice.filter((x) => half(x)).map((x) => Math.floor(x.r.total / 2)).join(" · ")}` : dice.map((x) => x.d.expr).join(" · "),
        }
      : undefined,
  );
}

function doDamage(ctx: ActionCtx) {
  const crit = critPending.has(ctx.key); // stays until this action's next to-hit, so every die in a crit doubles
  const rolls = ctx.p.damage.map((d) => ({ d, r: rollExpr(d.expr, { double: crit })! })).filter((x) => x.r);
  if (!rolls.length) return;
  startResolve(ctx, rolls.map((x) => ({ type: x.d.type, amount: x.r.total })), { fromAttack: true });
  lastResult.set(`${ctx.key}|dmg`, `<b>${rolls.map((x) => x.r.total).join(" + ")}</b>${crit ? ` <em class="crit">crit</em>` : ""}`);
  freshKey = `${ctx.key}|dmg`;
  log(
    {
      who: ctx.dmName,
      action: ctx.p.title,
      text: rolls.map((x) => `<span class="big">${x.r.total}</span> ${x.d.type} <span class="how">${working(x.r)}</span>`).join("<br>") + (crit ? ` <em class="crit">Critical: dice doubled</em>` : ""),
      tone: crit ? "crit" : undefined,
    },
    {
      author: { name: ctx.shown },
      description: `${ctx.shown}'s ${publicName(ctx)} deals:\n\n${rolls.map((x) => `**${x.r.total}** ${x.d.type} damage`).join("\n")}${crit ? "\n*Critical hit: damage dice doubled*" : ""}`,
      color: crit ? COLOUR.crit : COLOUR.brass,
    },
    undefined,
    {
      who: ctx.shown,
      action: publicName(ctx),
      dice: rolls.flatMap((x) => diceOf(x.r, x.d.type)),
      mod: rolls.reduce((a, x) => a + x.r.mod, 0),
      results: rolls.map((x) => ({ value: x.r.total, label: x.d.type, tint: x.d.type })),
      detail: rolls.map((x) => x.d.expr).join(" · "),
      tag: crit ? "Critical hit" : undefined,
      tone: crit ? "crit" : undefined,
    },
  );
}

function doExtra(ctx: ActionCtx, i: number) {
  const d = ctx.p.extras[i];
  const r = rollExpr(d.expr, { double: critPending.has(ctx.key) });
  if (!r) return;
  lastResult.set(`${ctx.key}|x${i}`, `<b>${r.total}</b>`);
  freshKey = `${ctx.key}|x${i}`;
  log(
    { who: ctx.dmName, action: ctx.p.title, text: `<span class="big">${r.total}</span> <span class="how">${escapeHtml(d.expr)}: ${working(r)}</span>` },
    { author: { name: ctx.shown }, description: `${ctx.shown}'s ${publicName(ctx)}: **${r.total}** (${d.expr}: ${working(r)})`, color: COLOUR.brass },
    undefined,
    { who: ctx.shown, action: publicName(ctx), dice: diceOf(r, d.type && d.type !== "hit points" ? d.type : d.type === "hit points" ? "healing" : "brass"), mod: r.mod, results: [{ value: r.total, label: d.type || d.expr }], detail: `${d.expr}: ${working(r)}` },
  );
}

// --- Free dice box ------------------------------------------------------------------
const diceInput = $<HTMLInputElement>("dice-input");
function rollBox() {
  const expr = diceInput.value.trim();
  const r = rollExpr(expr);
  if (!r) {
    diceInput.classList.add("bad");
    return;
  }
  diceInput.classList.remove("bad");
  freshKey = "box";
  const privateRoll = !isPublic();
  log(
    { who: "Dice", action: expr, text: `<span class="big">${r.total}</span> <span class="how">${working(r)}</span>` },
    { author: { name: "The DM rolls" }, description: `**${r.total}** (${expr}: ${working(r)})`, color: COLOUR.dice },
    privateRoll,
    { who: "The DM rolls", action: "", dice: diceOf(r, "brass"), mod: r.mod, results: [{ value: r.total, label: expr }], detail: working(r) },
  );
}
$<HTMLButtonElement>("dice-roll").addEventListener("click", rollBox);
diceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") rollBox();
});

// --- Saves and checks ---------------------------------------------------------------
const ABILITY_LIST = [
  { key: "Str", name: "Strength", score: "Z017", save: "Z023" },
  { key: "Dex", name: "Dexterity", score: "Z018", save: "Z024" },
  { key: "Con", name: "Constitution", score: "Z019", save: "Z025" },
  { key: "Int", name: "Intelligence", score: "Z020", save: "Z026" },
  { key: "Wis", name: "Wisdom", score: "Z021", save: "Z027" },
  { key: "Cha", name: "Charisma", score: "Z022", save: "Z028" },
];
const SKILLS: [string, string][] = [
  ["Athletics", "Str"],
  ["Acrobatics", "Dex"], ["Sleight of Hand", "Dex"], ["Stealth", "Dex"],
  ["Arcana", "Int"], ["History", "Int"], ["Investigation", "Int"], ["Nature", "Int"], ["Religion", "Int"],
  ["Animal Handling", "Wis"], ["Insight", "Wis"], ["Medicine", "Wis"], ["Perception", "Wis"], ["Survival", "Wis"],
  ["Deception", "Cha"], ["Intimidation", "Cha"], ["Performance", "Cha"], ["Persuasion", "Cha"],
];

interface CheckCtx { key: string; itemId: string; dmName: string; shown: string; label: string; post: string; mod: number }
const checks = new Map<string, CheckCtx>();

const num = (v: unknown): number | undefined => {
  const n = Number(String(v ?? "").trim());
  return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : undefined;
};
const fmtMod = (n: number) => (n >= 0 ? `+${n}` : `−${-n}`);

/** Ability mods, saves (never below the plain mod) and skills (listed bonus, else the ability mod). */
function checkTable(f: Record<string, any>) {
  const abilities = ABILITY_LIST.map((a) => {
    const mod = Math.floor(((num(f[F + a.score]) ?? 10) - 10) / 2);
    const stored = num(f[F + a.save]);
    const save = Math.max(stored ?? mod, mod);
    return { ...a, mod, save, saveProf: save > mod };
  });
  const listed = new Map<string, number>();
  for (const m of String(f[F + "Z014"] ?? "").matchAll(/([A-Za-z][A-Za-z ]*?)\s*([+\-−]\s*\d+)/g)) {
    listed.set(norm(m[1]), Number(m[2].replace("−", "-").replace(/\s+/g, "")));
  }
  const skills = SKILLS.map(([name, ab]) => {
    const base = abilities.find((a) => a.key === ab)!.mod;
    const own = listed.get(norm(name));
    return { name, ab, mod: own ?? base, prof: own !== undefined && own !== base };
  });
  return { abilities, skills };
}

function doCheck(c: CheckCtx) {
  const mode = checkMode.get(c.itemId);
  checkMode.delete(c.itemId);
  const r = rollExpr(`1d20${c.mod >= 0 ? "+" : ""}${c.mod}`, { mode });
  if (!r) return;
  const d20 = r.kept ?? r.dice[0];
  const nat = d20 === 20 ? "crit" : d20 === 1 ? "fumble" : undefined;
  const how = r.kept !== undefined ? `d20 ${r.dice.join(" / ")} ${mode === "adv" ? "with advantage" : "with disadvantage"}${signed(r.mod)}` : `d20 ${d20}${signed(r.mod)}`;
  const tag = nat === "crit" ? "Natural 20" : nat === "fumble" ? "Natural 1" : "";
  lastResult.set(c.key, `<b>${r.total}</b>`);
  freshKey = c.key;
  log(
    { who: c.dmName, action: c.label, text: `<span class="big">${r.total}</span> <span class="how">${how}</span>${tag ? ` <em class="${nat}">${tag}</em>` : ""}`, tone: nat },
    { author: { name: c.shown }, description: `${c.shown} makes ${c.post}:\n\n**${r.total}** (${how})${tag ? ` — **${tag}**` : ""}`, color: nat ? COLOUR[nat] : COLOUR.brass },
    undefined,
    { who: c.shown, action: c.label, dice: d20s(r, "verdigris"), mod: r.mod, results: [{ value: r.total, label: c.label }], detail: how, tag: tag || undefined, tone: nat },
  );
}

function defences(f: Record<string, any>): string {
  const rows: [string, string][] = [["Z030", "Vulnerable"], ["Z031", "Resists"], ["Z032", "Immune"], ["Z033", "Condition immunities"], ["Z013", "Senses"], ["Z041", "Notes"]];
  const items = rows.filter(([k]) => String(f[F + k] ?? "").trim()).map(([k, label]) => `<div><b>${label}</b> ${escapeHtml(String(f[F + k]))}</div>`);
  return items.length ? `<div class="defences">${items.join("")}</div>` : "";
}

function checksDrawer(f: Record<string, any>, c: RosterEntry): string {
  const { abilities, skills } = checkTable(f);
  const dmName = c.realName || c.name;
  const btn = (id: string, label: string, post: string, mod: number, strong: boolean, text = label) => {
    const key = `${c.itemId}|chk|${id}`;
    checks.set(key, { key, itemId: c.itemId, dmName, shown: c.name, label, post, mod });
    return `<span class="rollgroup"><button type="button" class="chk${strong ? " prof" : ""}" data-chk="${escapeHtml(key)}" title="Roll ${escapeHtml(label)}">${escapeHtml(text)} <b>${fmtMod(mod)}</b></button>${resultSpan(key)}</span>`;
  };
  const mode = checkMode.get(c.itemId);
  const id = escapeHtml(c.itemId);
  const article = (n: string) => (/^[AEIOU]/.test(n) ? "an" : "a");
  return `
    <details class="checks" data-id="${id}" ${checksOpen.has(c.itemId) ? "open" : ""}>
      <summary>Saves &amp; checks</summary>
      <div class="chk-mode">Next roll:
        <span class="seg"><button type="button" class="mode-pick ${!mode ? "on" : ""}" data-id="${id}" data-mode="">Normal</button><button type="button" class="mode-pick ${mode === "adv" ? "on" : ""}" data-id="${id}" data-mode="adv">Adv</button><button type="button" class="mode-pick ${mode === "dis" ? "on" : ""}" data-id="${id}" data-mode="dis">Dis</button></span>
      </div>
      <h4>Saving throws</h4>
      <div class="chk-row">${abilities.map((a) => btn(`save-${a.key}`, `${a.name} save`, `${article(a.name)} ${a.name} saving throw`, a.save, a.saveProf, a.key)).join("")}</div>
      <h4>Ability checks</h4>
      <div class="chk-row">${abilities.map((a) => btn(`check-${a.key}`, `${a.name} check`, `${article(a.name)} ${a.name} check`, a.mod, false, a.key)).join("")}</div>
      <h4>Skills</h4>
      <div class="chk-row skills">${skills.map((s) => btn(`skill-${s.name}`, s.name, `${article(ABILITY_LIST.find((a) => a.key === s.ab)!.name)} ${ABILITY_LIST.find((a) => a.key === s.ab)!.name} (${s.name}) check`, s.mod, s.prof)).join("")}</div>
    </details>`;
}

// --- Statuses ----------------------------------------------------------------------
// Edited here, saved to statuses.json; the extension in the GM's Owlbear tab draws
// them on the tokens a few seconds later.
const colourOf = (st: TokenStatus) => (st.key.startsWith("custom:") ? CUSTOM_COLOUR : statusDef(st.key)?.colour ?? CUSTOM_COLOUR);
let statusTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleStatusSave() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(async () => {
    const token = getToken();
    if (!token) {
      meta.textContent = "Statuses not saved: no GitHub token";
      meta.className = "warn";
      return;
    }
    try {
      for (const id of Object.keys(statuses)) if (!statuses[id].length) delete statuses[id];
      await saveStatuses(statuses, token);
      meta.textContent = "Statuses saved";
      meta.className = "";
    } catch (err) {
      meta.textContent = `Statuses not saved: ${err instanceof Error ? err.message : err}`;
      meta.className = "warn";
    }
  }, 700);
}
function changeStatuses(itemId: string, fn: (list: TokenStatus[]) => TokenStatus[]) {
  statuses[itemId] = fn([...(statuses[itemId] ?? [])]);
  render();
  // straight to Owlbear through the relay, if it's running; GitHub keeps the saved copy
  const tokens = Object.fromEntries(Object.entries(statuses).filter(([, l]) => l.length));
  fastSend({ kind: "statuses", id: crypto.randomUUID(), at: new Date().toISOString(), file: { savedAt: new Date().toISOString(), tokens } });
  scheduleStatusSave();
}
function addStatus(itemId: string, key: string, dmOnly: boolean, customText?: string) {
  changeStatuses(itemId, (list) => {
    if (customText) {
      const k = `custom:${customText.toLowerCase()}`;
      return list.some((x) => x.key === k) ? list : [...list, { key: k, label: customText, ...(dmOnly ? { dmOnly } : {}) }];
    }
    const def = statusDef(key);
    if (!def) return list;
    const have = list.find((x) => x.key === key);
    if (have) {
      if (def.max) have.value = Math.min(def.max, (have.value ?? 1) + 1);
      return list;
    }
    return [...list, { key, label: def.label, ...(def.max ? { value: 1 } : {}), ...(dmOnly ? { dmOnly } : {}) }];
  });
}
// --- The fallen: dead (tipped over, skull, skipped) or down (a party member at 0 HP) -------
// The token carries the state; the panel keeps a matching status chip, added or removed
// whenever the state changes, from here or from the right-click menu in Owlbear.
const lastFallen = new Map<string, string | undefined>();
function syncFallen(list: LiveCombatant[]) {
  for (const c of list) {
    const known = lastFallen.has(c.itemId);
    const was = lastFallen.get(c.itemId);
    lastFallen.set(c.itemId, c.fallen);
    if (!known || was === c.fallen) continue; // first sight after a reload: the saved statuses already match
    const have = (k: string) => (statuses[c.itemId] ?? []).some((s) => s.key === k);
    if (was === "dead" && have("dead")) changeStatuses(c.itemId, (l) => l.filter((s) => s.key !== "dead"));
    if (was === "down" && have("unconscious")) changeStatuses(c.itemId, (l) => l.filter((s) => s.key !== "unconscious"));
    if (c.fallen === "dead" && !have("dead")) addStatus(c.itemId, "dead", false);
    if (c.fallen === "down" && !have("unconscious")) addStatus(c.itemId, "unconscious", false);
  }
}
function isParty(itemId: string): boolean {
  const c = combatant(itemId);
  return !!c && (!!c.sheet || !entryFor(c).entry);
}
function sendFallen(itemId: string, state: "dead" | "down" | null) {
  const c = combatant(itemId);
  if (c) c.fallen = state ?? undefined;
  fastSend({ kind: "combat", id: crypto.randomUUID(), at: new Date().toISOString(), op: "fallen", values: { [itemId]: state === "dead" ? 1 : state === "down" ? 2 : null } });
  render();
}
function fallRow(c: RosterEntry): string {
  const id = escapeHtml(c.itemId);
  if (c.fallen) return `<div class="fall-row"><span class="fall-now ${c.fallen}">${c.fallen === "dead" ? "☠ Dead" : "Down"}</span><button type="button" class="fall-btn" data-fall="${id}" data-state="">Revive</button></div>`;
  return `<div class="fall-row">${isParty(c.itemId) ? `<button type="button" class="fall-btn" data-fall="${id}" data-state="down">Down</button>` : ""}<button type="button" class="fall-btn dead" data-fall="${id}" data-state="dead">☠ Mark dead</button></div>`;
}
function headChips(itemId: string): string {
  const list = statuses[itemId] ?? [];
  return list.length
    ? `<span class="st-mini">${list.map((st) => `<span style="--c:${colourOf(st)}" class="${st.dmOnly ? "dm" : ""}">${escapeHtml(tokenText(st))}</span>`).join("")}</span>`
    : "";
}
function statusEditor(itemId: string): string {
  const list = statuses[itemId] ?? [];
  const id = escapeHtml(itemId);
  const chips = list
    .map((st, i) => {
      const def = statusDef(st.key);
      return `<span class="st-chip ${st.dmOnly ? "dm" : ""}" style="--c:${colourOf(st)}" title="${escapeHtml(def?.reminder ?? "Custom status")}">
        <span class="st-name">${escapeHtml(st.label)}</span>
        ${def?.max ? `<button type="button" class="st-btn" data-id="${id}" data-i="${i}" data-op="dec" title="One fewer">−</button><b>${st.value ?? 1}</b><button type="button" class="st-btn" data-id="${id}" data-i="${i}" data-op="inc" title="One more">+</button>` : ""}
        <button type="button" class="st-btn eye" data-id="${id}" data-i="${i}" data-op="dm" title="${st.dmOnly ? "Hidden from players: click to show" : "Visible to players: click to hide"}">${st.dmOnly ? "DM only" : "Shown"}</button>
        <button type="button" class="st-btn" data-id="${id}" data-i="${i}" data-op="del" title="Remove">×</button>
      </span>`;
    })
    .join("");
  const reminders = list
    .map((st) => statusDef(st.key))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => `<li><b>${escapeHtml(d.label)}.</b> ${escapeHtml(d.reminder)}</li>`)
    .join("");
  return `
    <div class="statuses" data-id="${id}">
      ${chips ? `<div class="st-row">${chips}</div>` : ""}
      <div class="st-add">
        <select class="st-pick" data-id="${id}">
          <option value="">Add a status…</option>
          ${STATUS_DEFS.map((d) => `<option value="${d.key}">${escapeHtml(d.label)}</option>`).join("")}
          <option value="__custom">Custom…</option>
        </select>
        <input class="st-custom" data-id="${id}" type="text" placeholder="Custom status, then Enter" hidden />
        <label class="check"><input type="checkbox" class="st-dm" data-id="${id}" /> DM only</label>
      </div>
      ${reminders ? `<ul class="st-reminders">${reminders}</ul>` : ""}
    </div>`;
}

// --- Rendering -------------------------------------------------------------------------
const crText = (c?: number) => (c === undefined ? "–" : c === 0.125 ? "1/8" : c === 0.25 ? "1/4" : c === 0.5 ? "1/2" : String(c));

function resultSpan(key: string): string {
  const res = lastResult.get(key);
  return res ? `<span class="result${freshKey === key ? " fresh" : ""}">${res}</span>` : "";
}

function rollRow(ctx: ActionCtx): string {
  const p = ctx.p;
  const k = escapeHtml(ctx.key);
  const parts: string[] = [];
  const min = rechargeMin(ctx.raw.name);
  const isSpent = min !== undefined && spent.has(spentKey(ctx));
  const off = isSpent ? ` disabled title="Spent: roll to recharge"` : "";
  if (p.hit) {
    const sign = p.hit.mod >= 0 ? "+" : "−";
    parts.push(`<span class="rollgroup"><button type="button" class="roll hit" data-act="${k}" data-op="hit"${off || ` title="Roll to hit and post the attack"`}>Attack ${sign}${Math.abs(p.hit.mod)}</button><span class="seg"><button type="button" class="roll mode" data-act="${k}" data-op="hit" data-mode="adv"${off || ` title="Roll with advantage"`}>Adv</button><button type="button" class="roll mode" data-act="${k}" data-op="hit" data-mode="dis"${off || ` title="Roll with disadvantage"`}>Dis</button></span>${resultSpan(`${ctx.key}|hit`)}</span>`);
  } else if (p.category !== "trait" && p.category !== "tactics") {
    const dice = [...p.damage, ...p.extras];
    const diceText = dice.length ? ` <span class="parts">${dice.map((d) => `${escapeHtml(d.expr)}${d.type ? ` <i class="t-${d.type.split(" ")[0]}">${escapeHtml(d.type)}</i>` : ""}`).join(" · ")}</span>` : "";
    parts.push(`<span class="rollgroup"><button type="button" class="roll use" data-act="${k}" data-op="use"${off || ` title="${dice.length ? "Roll and post in one go" : "Post this action's description to Discord"}"`}>${spellFor(p.title) ? "Cast" : "Use"}${diceText}</button>${resultSpan(`${ctx.key}|use`)}</span>`);
  }
  const twoStage = !!p.hit; // attacks: to-hit first, damage once the table says it hits
  if (min !== undefined) {
    parts.push(isSpent
      ? `<span class="rollgroup"><span class="rc-tag spent">Spent</span><button type="button" class="roll recharge" data-act="${k}" data-op="recharge" title="Roll a d6 privately at the start of its turn">Recharge ${min}–6</button><button type="button" class="roll ready" data-act="${k}" data-op="ready" title="Mark ready without rolling">Ready</button>${resultSpan(`${ctx.key}|rc`)}</span>`
      : `<span class="rollgroup"><span class="rc-tag">Ready</span>${resultSpan(`${ctx.key}|rc`)}</span>`);
  }
  if (twoStage && p.damage.length) {
    parts.push(`<span class="rollgroup"><button type="button" class="roll dmg" data-act="${k}" data-op="dmg" title="Roll all damage">Damage <span class="parts">${p.damage.map((d) => `${escapeHtml(d.expr)} <i class="t-${d.type}">${d.type}</i>`).join(" · ")}</span></button>${resultSpan(`${ctx.key}|dmg`)}</span>`);
  }
  if (twoStage) p.extras.forEach((d, i) => {
    parts.push(`<span class="rollgroup"><button type="button" class="roll extra" data-act="${k}" data-op="extra" data-i="${i}" title="Roll ${escapeHtml(d.expr)}">${escapeHtml(d.expr)}</button>${resultSpan(`${ctx.key}|x${i}`)}</span>`);
  });
  return parts.length ? `<div class="rolls">${parts.join("")}</div>` : "";
}

const SECTIONS: [Category, string][] = [["action", "Actions"], ["bonus", "Bonus actions"], ["reaction", "Reactions"], ["legendary", "Legendary actions"], ["trait", "Traits"]];

function statBlock(e: BestiaryEntry, c: RosterEntry): string {
  const f = e.forge as Record<string, any>;
  // Forge keeps traits (Z034), actions (Z035), bonus actions (Z036), reactions (Z037) and
  // legendary actions (Z038) in separate lists; some blocks put everything in Z035 with prefixes.
  const lists: [string, Category | undefined][] = [["Z034", "trait"], ["Z035", undefined], ["Z036", "bonus"], ["Z037", "reaction"], ["Z038", "legendary"]];
  const raw = lists.flatMap(([k, cat]) => ((f[F + k] as { name: string; description: string }[] | undefined) ?? []).map((a) => ({ a, cat })));
  const ctxs = raw.map(({ a, cat }, i) => {
    const ctx: ActionCtx = { key: `${c.itemId}#${i}`, itemId: c.itemId, dmName: c.realName || c.name, shown: c.name, entry: e, raw: a, p: parseAction(a, cat) };
    actions.set(ctx.key, ctx);
    return ctx;
  });
  const card = (ctx: ActionCtx) => `
    <div class="action ${ctx.p.category}">
      <div class="action-head"><span class="action-name">${escapeHtml(ctx.p.title)}</span>${ctx.p.dcs.map((d) => `<span class="dc">${escapeHtml(d)}</span>`).join("")}${spellFor(ctx.p.title) ? `<span class="spell-tag">Spell</span>` : ""}${e.flavour?.[ctx.raw.name]?.length ? `<span class="flav-tag" title="Has flavour text for Discord">Flavour</span>` : ""}</div>
      ${e.notes?.[ctx.raw.name] ? `<div class="dm-note-line" title="DM only: never posted to Discord">${escapeHtml(e.notes[ctx.raw.name])}</div>` : ""}
      ${rollRow(ctx)}
      <div class="action-text">${ctx.p.text}</div>
    </div>`;
  return `
    <div class="sheet">
      <div class="vitals">
        <span><small>CR</small>${crText(e.cr)}</span><span><small>AC</small>${f[F + "Z007"] ?? "–"}</span><span><small>HP</small>${f[F + "Z005"] ?? "–"}</span><span><small>Speed</small>${f[F + "Z008"] ?? "–"} ft</span>
        ${c.sheet ? "" : `<label class="ally-check" title="Fights on the party's side: teal on the combat strip instead of orange"><input type="checkbox" class="ally-box" data-id="${escapeHtml(c.itemId)}" ${c.ally ? "checked" : ""} /> Party aligned</label>`}
        <button type="button" class="apply-btn ${applyArmed === c.itemId ? "armed" : ""}" data-id="${escapeHtml(c.itemId)}" data-entry="${escapeHtml(e.id)}" title="Write this stat block's HP (full), max HP, AC and the rest onto the token in Owlbear">${applyArmed === c.itemId ? "Click again to apply" : "Apply to token"}</button>
      </div>
      ${defences(f)}
      ${checksDrawer(f, c)}
      ${SECTIONS.map(([cat, label]) => {
        const items = ctxs.filter((x) => x.p.category === cat);
        return items.length ? `<h3>${label}</h3>${items.map(card).join("")}` : "";
      }).join("")}
      ${ctxs.filter((x) => x.p.category === "tactics").map((x) => `<div class="tactics"><b>Tactics.</b> ${x.p.text}</div>`).join("")}
      <div class="source">From ${escapeHtml(e.source ?? "the bestiary")}${e.updated ? ` · updated ${escapeHtml(e.updated)}` : ""}</div>
    </div>`;
}

function renderLog() {
  const el = $<HTMLElement>("roll-log");
  el.innerHTML = rollLog.length
    ? rollLog
        .map(
          (l, i) =>
            `<div class="logline ${l.tone ?? ""} ${i === 0 ? "latest" : ""} ${i === 0 && freshKey ? "fresh" : ""}"><span class="who">${escapeHtml(l.who)} · ${escapeHtml(l.action)}${l.status ? ` <span class="st">${escapeHtml(l.status)}</span>` : ""}</span><span class="what">${l.text}</span></div>`,
        )
        .join("")
    : "";
}

// "Apply to token": two clicks (arm, then confirm) so a stray click can't reset HP.
let applyArmed: string | undefined;
let applyTimer: ReturnType<typeof setTimeout> | undefined;
async function applyToToken(itemId: string, entryId: string) {
  const e = bestiary.find((x) => x.id === entryId);
  const token = getToken();
  if (!e) return;
  if (!token) {
    meta.textContent = "Not sent: no GitHub token";
    meta.className = "warn";
    return;
  }
  meta.textContent = `Sending ${e.name}…`;
  meta.className = "";
  try {
    const cmd = { id: crypto.randomUUID(), at: new Date().toISOString(), kind: "apply-statblock" as const, itemId, entryName: e.name, forge: e.forge };
    if (!(await fastSend(cmd))) await sendCommand(cmd, token);
    meta.textContent = `${e.name} sent to token`;
  } catch (err) {
    meta.textContent = `Not sent: ${err instanceof Error ? err.message : err}`;
    meta.className = "warn";
  }
}

// --- Resolve: damage (or healing) waits here until the DM applies it ------------------
// One row per target, one multiplier per damage type (pre-set from the bestiary or the
// sheet's resistances), a save prompt when the ability has a DC, then Apply: Owlbear
// changes the token (and the DiceCloud sheet for the party). Undo for 30 seconds.
interface ResolveTarget {
  itemId: string;
  missed?: boolean;
  mults: number[];
  save?: "saved" | "failed";
  saveText?: string;
  state?: "applying" | "done" | "error";
  ref?: string;
  result?: HpResult;
  error?: string;
  undoUntil?: number;
}
interface Resolve {
  id: string;
  dmWho: string;
  shownWho: string;
  action: string;
  parts: { type: string; amount: number }[];
  healing: boolean;
  dc?: { dc: number; ability: string };
  half: boolean;
  targets: ResolveTarget[];
  posted?: boolean;
}
let resolve: Resolve | undefined;
let scrollToResolve = false;
const UNDO_MS = 30_000;
const MULTS: [number, string][] = [[0, "×0"], [0.5, "½"], [1, "×1"], [2, "×2"]];

function defaultMult(c: RosterEntry, type: string): number {
  const live = liveRoster?.find((x) => x.itemId === c.itemId);
  if (live?.multipliers && type in live.multipliers) return live.multipliers[type];
  const e = entryFor(c).entry;
  if (!e) return 1;
  const f = e.forge as Record<string, any>;
  const has = (k: string) => new RegExp(`\\b${type}\\b`, "i").test(String(f[F + k] ?? ""));
  return has("Z032") ? 0 : has("Z031") ? 0.5 : has("Z030") ? 2 : 1;
}
function startResolve(ctx: ActionCtx, parts: { type: string; amount: number }[], opts: { fromAttack?: boolean; dc?: string; half?: boolean }) {
  const list = targets.map((id) => combatant(id)).filter((c): c is RosterEntry => !!c);
  if (!parts.length) return;
  const healing = parts.every((p) => p.type === "healing" || p.type === "hit points");
  const hits = opts.fromAttack ? lastHits.get(ctx.key) : undefined;
  const dcm = opts.dc?.match(/DC (\d+) (\w+)/);
  resolve = {
    id: crypto.randomUUID(),
    dmWho: ctx.dmName,
    shownWho: ctx.shown,
    action: publicName(ctx),
    parts,
    healing,
    dc: dcm && !healing ? { dc: Number(dcm[1]), ability: dcm[2] } : undefined,
    half: !!opts.half,
    targets: list.map((c) => newRow(c, parts, healing, hits)),
  };
  scrollToResolve = true;
}
function newRow(c: RosterEntry, parts: { type: string }[], healing: boolean, hits?: Map<string, boolean | undefined>): ResolveTarget {
  return { itemId: c.itemId, missed: hits?.get(c.itemId) === false || undefined, mults: parts.map((p) => (healing ? 1 : defaultMult(c, p.type))) };
}
/** Targets picked (or dropped) after the roll join (or leave) the open damage card. */
function syncResolveTargets() {
  const r = resolve;
  if (!r || r.posted) return;
  r.targets = r.targets.filter((t) => t.state || targets.includes(t.itemId));
  for (const id of targets) {
    const c = combatant(id);
    if (c && !r.targets.some((t) => t.itemId === id)) r.targets.push(newRow(c, r.parts, r.healing));
  }
}
function amountFor(r: Resolve, t: ResolveTarget): number {
  if (t.missed) return 0;
  return r.parts.reduce((sum, p, i) => {
    let v = p.amount;
    if (r.healing) return sum + v;
    if (r.dc && t.save === "saved") v = r.half ? Math.floor(v / 2) : 0;
    const m = t.mults[i];
    v = m === 0 ? 0 : m === 0.5 ? Math.floor(v / 2) : m === 2 ? v * 2 : v;
    return sum + v;
  }, 0);
}
const needsSave = (r: Resolve, t: ResolveTarget) => !!r.dc && !t.missed && !t.save;
function npcSaveBonus(c: RosterEntry, ability: string): number | undefined {
  const e = entryFor(c).entry;
  if (!e) return undefined;
  const a = checkTable(e.forge as Record<string, any>).abilities.find((x) => x.key === ability);
  return a?.save;
}
function rollSave(t: ResolveTarget) {
  const r = resolve;
  const c = combatant(t.itemId);
  if (!r?.dc || !c) return;
  const bonus = npcSaveBonus(c, r.dc.ability) ?? 0;
  const roll = rollExpr(`1d20${bonus >= 0 ? "+" : ""}${bonus}`)!;
  const d20 = roll.dice[0];
  const ok = d20 === 20 ? true : d20 === 1 ? false : roll.total >= r.dc.dc;
  t.save = ok ? "saved" : "failed";
  t.saveText = `${roll.total} (d20 ${d20}${signed(bonus)})`;
  const label = `${r.dc.ability} save`;
  log(
    { who: c.realName || c.name, action: label, text: `<span class="big">${roll.total}</span> vs DC ${r.dc.dc} <span class="how">d20 ${d20}${signed(bonus)}</span> <em class="${ok ? "crit" : "fumble"}">${ok ? "Saved" : "Failed"}</em>` },
    { author: { name: c.name }, description: `${c.name} makes a ${label} against ${r.shownWho}'s ${r.action}:\n\n**${roll.total}** — **${ok ? "Saved" : "Failed"}**`, color: ok ? COLOUR.crit : COLOUR.fumble },
    undefined,
    { who: c.name, action: label, dice: d20s(roll, "verdigris"), mod: roll.mod, results: [{ value: roll.total, label: `vs DC ${r.dc.dc}` }], detail: `d20 ${d20}${signed(bonus)}`, tag: ok ? "Saved" : "Failed", tone: ok ? "crit" : "fumble" },
  );
}
async function applyTarget(t: ResolveTarget, forgeOnly = false) {
  const r = resolve;
  if (!r || t.state === "applying" || t.state === "done") return;
  const amount = amountFor(r, t);
  t.state = "applying";
  t.error = undefined;
  t.ref = crypto.randomUUID();
  render();
  noteHp(t.itemId, `${r.healing ? "Healed by" : "Hit by"} ${r.shownWho}: ${r.action} (${amount})`);
  const sent = await fastSend({ kind: "hp", id: t.ref, at: new Date().toISOString(), itemId: t.itemId, damage: r.healing ? -amount : amount, forgeOnly });
  if (!sent) {
    t.state = "error";
    t.error = "Owlbear isn't linked: open the panel from the extension's link";
    render();
  }
}
function applyAll() {
  const r = resolve;
  if (!r) return;
  for (const t of r.targets) if (!t.state && !needsSave(r, t)) applyTarget(t);
}
function undoTarget(t: ResolveTarget) {
  if (!t.result?.before) return;
  const ref = crypto.randomUUID();
  t.undoUntil = undefined;
  noteHp(t.itemId, "Undo");
  fastSend({ kind: "hp", id: ref, at: new Date().toISOString(), itemId: t.itemId, set: { hp: t.result.before.hp, temp: t.result.before.temp } });
  log({ who: combatant(t.itemId)?.realName || "?", action: "Undo", text: `HP put back to ${t.result.before.hp}${t.result.before.temp ? ` (+${t.result.before.temp})` : ""}` }, { description: "" }, true);
  t.state = undefined;
  t.result = undefined;
  if (resolve) resolve.posted = false;
  render();
}
// Owlbear reports each change; once every target is settled, Discord gets the outcome.
onOwlbear((m) => {
  if (m.kind !== "hp-result" || !resolve) return;
  const t = resolve.targets.find((x) => x.ref === m.ref);
  if (!t) return;
  if (m.ok) {
    t.state = "done";
    t.result = m;
    t.undoUntil = Date.now() + UNDO_MS;
    setTimeout(render, UNDO_MS + 50);
  } else {
    t.state = "error";
    t.error = m.error;
  }
  maybePostOutcome();
  render();
});
function maybePostOutcome() {
  const r = resolve;
  if (!r || r.posted) return;
  const settled = r.targets.filter((t) => !t.missed);
  if (!settled.length || settled.some((t) => t.state !== "done")) return;
  r.posted = true;
  const lines = settled.map((t) => {
    const c = combatant(t.itemId);
    const name = c?.name ?? "?";
    const amt = amountFor(r, t);
    const conc = !r.healing && amt > 0 && (statuses[t.itemId] ?? []).some((s) => s.key === "concentrating");
    const main = r.healing ? `**${name}** regains **${amt}** hit points` : amt > 0 ? `**${name}** takes **${amt}** damage` : `**${name}** takes no damage`;
    return main + (conc ? `\n*${name} must make a Constitution save to keep concentrating: DC ${Math.min(30, Math.max(10, Math.floor(amt / 2)))}*` : "");
  });
  log(
    { who: r.dmWho, action: r.action, text: lines.map((l) => l.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>")).join("<br>") },
    { author: { name: r.shownWho }, title: r.action, description: lines.join("\n"), color: r.healing ? COLOUR.crit : COLOUR.brass },
  );
  setTargets([]); // resolved: rings come off
}
function resolveCard(): string {
  const r = resolve;
  if (!r) return "";
  const e = escapeHtml;
  const rows = r.targets.map((t, ti) => {
    const c = combatant(t.itemId);
    if (!c) return "";
    const amt = amountFor(r, t);
    const pc = !!liveRoster?.find((x) => x.itemId === t.itemId)?.sheet;
    const save = !r.dc || t.missed
      ? ""
      : t.save
        ? `<span class="rs-save ${t.save}">${t.save === "saved" ? "Saved" : "Failed"}${t.saveText ? ` <small>${e(t.saveText)}</small>` : ""}</span><button type="button" class="rs-mini" data-rs="clear-save" data-t="${ti}">change</button>`
        : entryFor(c).entry && !pc
          ? `<button type="button" class="rs-btn rs-roll" data-rs="roll-save" data-t="${ti}">Roll ${e(r.dc.ability)} save ${fmtMod(npcSaveBonus(c, r.dc.ability) ?? 0)}</button>`
          : `<span class="rs-ask">${e(r.dc.ability)} save?</span><button type="button" class="rs-btn" data-rs="saved" data-t="${ti}">Saved</button><button type="button" class="rs-btn" data-rs="failed" data-t="${ti}">Failed</button>`;
    const parts = r.healing || t.missed
      ? ""
      : r.parts.map((p, pi) => `<span class="rs-part"><b>${p.amount}</b> <i class="t-${e(p.type)}">${e(p.type)}</i><span class="seg">${MULTS.map(([m, l]) => `<button type="button" class="rs-m ${t.mults[pi] === m ? "on" : ""}" data-rs="mult" data-t="${ti}" data-p="${pi}" data-m="${m}" ${t.state ? "disabled" : ""}>${l}</button>`).join("")}</span></span>`).join("");
    const res = t.result?.after;
    const after = t.state === "done" && res ? `<span class="rs-done">${t.result!.before!.hp}${t.result!.before!.temp ? `+${t.result!.before!.temp}` : ""} → <b>${res.hp}</b>${res.temp ? `+${res.temp}` : ""}${res.max ? `/${res.max}` : ""} <small>${t.result!.via === "dicecloud" ? "sheet" : "Forge"}</small></span>${t.undoUntil && t.undoUntil > Date.now() ? `<button type="button" class="rs-mini" data-rs="undo" data-t="${ti}">Undo</button>` : ""}${res.hp === 0 && !r.healing ? `<button type="button" class="rs-mini" data-rs="ko" data-t="${ti}">${pc ? "Down" : "☠ Dead"}</button>` : ""}` : "";
    const action = t.missed
      ? `<span class="rs-missed">Missed</span><button type="button" class="rs-mini" data-rs="hit-anyway" data-t="${ti}">Hit anyway</button>`
      : t.state === "done"
        ? after
        : t.state === "applying"
          ? `<span class="rs-wait">Applying…</span>`
          : `<button type="button" class="rs-btn rs-apply" data-rs="apply" data-t="${ti}" ${needsSave(r, t) ? "disabled" : ""}>${r.healing ? "Heal" : "Apply"} ${amt}</button><button type="button" class="rs-mini" data-rs="drop" data-t="${ti}" title="Leave this target out">×</button>`;
    const err = t.state === "error" ? `<div class="rs-err">${e(t.error ?? "Failed")}${pc ? ` <button type="button" class="rs-mini" data-rs="forge-only" data-t="${ti}">Apply to Forge only</button>` : ""}</div>` : "";
    const conc = t.state === "done" && !r.healing && amt > 0 && (statuses[t.itemId] ?? []).some((s) => s.key === "concentrating") ? `<div class="rs-note">Concentration save: DC ${Math.min(30, Math.max(10, Math.floor(amt / 2)))}</div>` : "";
    const rot = t.state === "done" && r.healing && (statuses[t.itemId] ?? []).some((s) => s.key === "rotten") ? `<div class="rs-note">Rotten: magical healing clears all stacks</div>` : "";
    return `<div class="rs-row ${t.state ?? ""}"><div class="rs-who">${e(c.name)}${c.realName && c.realName !== c.name ? ` <small class="real-name">${e(c.realName)}</small>` : ""}${pc ? ` <small title="Changes go to their DiceCloud sheet">sheet</small>` : ""}${c.hp !== undefined ? ` <small>${c.hp}${c.tempHp ? `+${c.tempHp}` : ""}/${c.maxHp ?? "?"}</small>` : ""}</div><div class="rs-mid">${save}${parts}</div><div class="rs-act">${action}</div>${err}${conc}${rot}</div>`;
  });
  const open = r.targets.some((t) => !t.state && !t.missed);
  return `<div class="resolve">
    <div class="rs-head"><span class="rs-title">${r.healing ? "Healing" : "Damage"} · ${e(r.dmWho)} · ${e(r.action)}</span>${r.dc ? `<span class="dc">DC ${r.dc.dc} ${e(r.dc.ability)}${r.half ? " · half on save" : ""}</span>` : ""}
    <span class="rs-total">${r.parts.map((p) => `${p.amount} ${e(p.type)}`).join(" + ")}</span>
    ${open ? `<button type="button" class="rs-btn rs-all" data-rs="all">Apply all</button>` : ""}<button type="button" class="rs-mini" data-rs="close" title="Close without applying anything else">Close</button></div>
    ${rows.join("") || `<div class="rs-row"><div class="rs-who" style="grid-column:1/-1;font-weight:400;opacity:.75">No targets yet: select tokens in Owlbear or tap ◎ on a tile, and they'll appear here.</div></div>`}
  </div>`;
}
function wireResolve() {
  app.querySelectorAll<HTMLButtonElement>("[data-rs]").forEach((b) =>
    b.addEventListener("click", () => {
      const r = resolve;
      if (!r) return;
      const t = r.targets[Number(b.dataset.t)];
      const op = b.dataset.rs;
      if (op === "close") resolve = undefined;
      else if (op === "all") applyAll();
      else if (!t) return;
      else if (op === "mult") t.mults[Number(b.dataset.p)] = Number(b.dataset.m);
      else if (op === "saved" || op === "failed") t.save = op;
      else if (op === "clear-save") { t.save = undefined; t.saveText = undefined; }
      else if (op === "roll-save") rollSave(t);
      else if (op === "apply") return applyTarget(t);
      else if (op === "forge-only") { t.state = undefined; return applyTarget(t, true); }
      else if (op === "undo") return undoTarget(t);
      else if (op === "drop") r.targets.splice(r.targets.indexOf(t), 1);
      else if (op === "hit-anyway") t.missed = undefined;
      else if (op === "ko") { sendFallen(t.itemId, isParty(t.itemId) ? "down" : "dead"); return; }
      render();
    }),
  );
}

// --- Initiative and the fight itself (the strip in Owlbear shows the result) -------------
let initEditing: string | undefined;
// --- Changing HP by hand (Forge's job before): click a card's HP and type ----------------
// "-6" damage (temp HP first), "+4" healing, "20" sets HP, "t5" sets temp HP. Party members
// change on their DiceCloud sheet, everyone else in Owlbear, exactly as an applied hit does.
let hpEditing: string | undefined;
function applyHpText(id: string, text: string) {
  const c = combatant(id);
  const t = text.replace(/\s+/g, "").toLowerCase();
  if (!c || !t) return;
  const at = new Date().toISOString();
  let m: RegExpMatchArray | null;
  const send = (extra: Partial<HpMessage>) => fastSend({ kind: "hp", id: crypto.randomUUID(), at, itemId: id, ...extra }).then((ok) => {
    if (!ok) {
      meta.textContent = "HP not changed: Owlbear isn't linked";
      meta.className = "warn";
    }
  });
  if (/^([-+=t]?)\d+$/.test(t)) noteHp(id, `Typed "${t}"`);
  if ((m = t.match(/^-(\d+)$/))) send({ damage: Number(m[1]) });
  else if ((m = t.match(/^\+(\d+)$/))) send({ damage: -Number(m[1]) });
  else if ((m = t.match(/^=?(\d+)$/))) send({ set: { hp: Number(m[1]), temp: c.tempHp ?? 0 } });
  else if ((m = t.match(/^t(\d+)$/))) send({ set: { hp: c.hp ?? 0, temp: Number(m[1]) } });
}
function wireHp() {
  app.querySelectorAll<HTMLElement>("[data-hp]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      hpEditing = el.dataset.hp;
      render();
    }),
  );
  const input = app.querySelector<HTMLInputElement>("[data-hp-in]");
  if (!input) return;
  input.focus();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    hpEditing = undefined;
    if (keep) applyHpText(input.dataset.hpIn!, input.value);
    render();
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}
let endArmed = false;
function combatBar(): string {
  if (!roster?.combatants.some((c) => !c.standby) || !owlbearWindow()) return "";
  const npcsToRoll = roster.combatants.filter((c) => !c.standby && !c.sheet && entryFor(c).entry && c.hasInit === false).length;
  return `<div class="combat-bar">
    <span class="cb-round">${turnId ? `Round ${round || 1}` : "Not started"}</span>
    <button type="button" class="cb-btn" data-cb="roll" ${npcsToRoll ? "" : "disabled"} title="Roll initiative for every NPC that hasn't rolled">Roll NPCs${npcsToRoll ? ` (${npcsToRoll})` : ""}</button>
    <button type="button" class="cb-btn ${endArmed ? "armed" : ""}" data-cb="end">${endArmed ? "Click again to end" : "End combat"}</button>
  </div>`;
}
function sendInit(values: Record<string, number | null>) {
  for (const [id, v] of Object.entries(values)) {
    const c = combatant(id);
    if (c) {
      c.initiative = v ?? 0;
      c.hasInit = v !== null;
    }
  }
  fastSend({ kind: "combat", id: crypto.randomUUID(), at: new Date().toISOString(), op: "init", values });
}
function dexMod(c: RosterEntry): number {
  const own = c.dex;
  const dex = own ?? Number((entryFor(c).entry?.forge as Record<string, unknown> | undefined)?.[F + "Z018"]);
  return Number.isFinite(dex) && dex > 0 ? Math.floor((dex - 10) / 2) : 0;
}
function rollInitiative(list: RosterEntry[]) {
  if (!list.length) return;
  const rolls = list.map((c) => ({ c, d: randInt(20), mod: dexMod(c) }));
  sendInit(Object.fromEntries(rolls.map((r) => [r.c.itemId, r.d + r.mod])));
  // the table sees visible creatures roll; hidden ones roll privately
  for (const [group, priv] of [[rolls.filter((r) => r.c.visible !== false), false], [rolls.filter((r) => r.c.visible === false), true]] as const) {
    if (!group.length) continue;
    const one = group.length === 1 ? group[0] : undefined;
    log(
      { who: one ? one.c.realName || one.c.name : "Initiative", action: one ? "Initiative" : "NPC initiative", text: group.map((r) => `${group.length > 1 ? `${escapeHtml(r.c.realName || r.c.name)}: ` : ""}<span class="big">${r.d + r.mod}</span> <span class="how">d20 ${r.d}${signed(r.mod)}</span>`).join("<br>") },
      { author: { name: one ? one.c.name : "Initiative" }, description: group.map((r) => `${r.c.name}: **${r.d + r.mod}**`).join("\n"), color: COLOUR.brass },
      priv,
      {
        who: one ? one.c.name : "Initiative",
        action: one ? "Initiative" : "",
        dice: group.slice(0, 12).map((r) => ({ sides: 20, value: r.d, tint: "brass" })),
        mod: one?.mod,
        results: group.map((r) => ({ value: r.d + r.mod, label: one ? "initiative" : r.c.name })),
        detail: group.map((r) => `${group.length > 1 ? `${r.c.name}: ` : ""}d20 ${r.d}${signed(r.mod)}`).join(" · "),
      },
    );
  }
  render();
}
function wireInitiative() {
  app.querySelectorAll<HTMLElement>("[data-init]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      initEditing = el.dataset.init;
      render();
    }),
  );
  app.querySelectorAll<HTMLElement>("[data-roll]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const c = combatant(el.dataset.roll!);
      if (c) rollInitiative([c]);
    }),
  );
  const input = app.querySelector<HTMLInputElement>("[data-init-in]");
  if (input) {
    input.focus();
    input.select();
    let done = false;
    const save = (keep: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      initEditing = undefined;
      if (keep && v !== "" && Number.isFinite(Number(v))) sendInit({ [input.dataset.initIn!]: Math.round(Number(v)) });
      render();
    };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save(true);
      if (e.key === "Escape") save(false);
    });
    input.addEventListener("blur", () => save(true));
  }
  app.querySelector<HTMLButtonElement>('[data-cb="roll"]')?.addEventListener("click", () =>
    rollInitiative((roster?.combatants ?? []).filter((c) => !c.standby && !c.sheet && entryFor(c).entry && c.hasInit === false)),
  );
  app.querySelector<HTMLButtonElement>('[data-cb="end"]')?.addEventListener("click", () => {
    if (!endArmed) {
      endArmed = true;
      render();
      setTimeout(() => {
        endArmed = false;
        render();
      }, 3000);
      return;
    }
    endArmed = false;
    fastSend({ kind: "combat", id: crypto.randomUUID(), at: new Date().toISOString(), op: "end" });
    render();
  });
}

function hpBar(c: RosterEntry): string {
  if (c.hp === undefined || !c.maxHp) return "";
  const pct = Math.max(0, Math.min(100, (c.hp / c.maxHp) * 100));
  const tone = pct <= 25 ? "low" : pct <= 50 ? "mid" : "";
  return `<span class="pc-hp ${tone}" title="${c.hp}/${c.maxHp} HP${c.tempHp ? ` (+${c.tempHp} temp)` : ""}"><i style="width:${pct.toFixed(0)}%"></i>${c.tempHp ? `<b></b>` : ""}</span>`;
}

function render() {
  renderLog();
  actions.clear();
  checks.clear();
  if (!roster) {
    app.innerHTML = `<p class="empty">Click "Update Roster" to load the combat list saved from Owlbear.</p>`;
    freshKey = undefined;
    return;
  }
  if (roster.combatants.length === 0) {
    app.innerHTML = `<p class="empty">Nobody is in combat or on the panel. Right-click a token in Owlbear: "Add to combat", or "Add to panel (not initiative)".</p>`;
    freshKey = undefined;
    return;
  }
  const options = [...bestiary].sort((a, b) => a.name.localeCompare(b.name));
  const card = (c: RosterEntry) => {
      const { entry, manual } = entryFor(c);
      const auto = autoMatch(c);
      const isOpen = open.has(c.itemId);
      // the name the players know is the heading; the real one sits under it for you
      const alias = c.realName && c.realName !== c.name ? `<span class="alias real-under"><small>Real name</small> ${escapeHtml(c.realName)}</span>` : "";
      const tag = !entry ? `<span class="tag">Party</span>` : manual ? `<span class="tag set">${escapeHtml(entry.name)}</span>` : "";
      return `
        <section class="combatant ${isOpen ? "open" : ""} ${c.fallen ?? ""} ${entry ? "" : "party"} ${c.itemId === turnId ? "turn" : ""}" data-id="${escapeHtml(c.itemId)}">
          <div class="head" role="button" tabindex="0" aria-expanded="${isOpen}">
            <span class="init">${c.initiative}</span>
            <span class="who"><span class="name">${escapeHtml(c.name)}<span class="sb-pick" title="Stat block">▾<select class="pick" aria-label="Stat block">
                  <option value="">${auto ? `Auto: ${escapeHtml(auto.name)}` : "None (party member)"}</option>
                  ${options.map((o) => `<option value="${escapeHtml(o.id)}" ${manual && entry?.id === o.id ? "selected" : ""}>${escapeHtml(o.name)}</option>`).join("")}
                </select></span></span>${alias}</span>
            ${headChips(c.itemId)}
            ${tag}
            ${hpEditing === c.itemId
              ? `<span class="hpv editing"><input class="hp-in" data-hp-in="${escapeHtml(c.itemId)}" placeholder="-6 / +4 / 20" title="-6 damage · +4 healing · 20 sets HP · t5 sets temp HP" /></span>`
              : `<span class="hpv" data-hp="${escapeHtml(c.itemId)}" title="Click to change HP: -6 damage, +4 heal, 20 sets it, t5 sets temp HP"><span><small>HP</small>${c.hp ?? "–"}${c.maxHp !== undefined ? `/${c.maxHp}` : ""}${c.tempHp ? ` <small class="tmp">+${c.tempHp}</small>` : ""}</span></span>`}
            <span class="ac" title="Armour class"><small>AC</small>${c.ac ?? "–"}</span>
            <span class="chev" aria-hidden="true"></span>
          </div>
          ${isOpen ? `
            <div class="body">
              ${fallRow(c)}
              ${statusEditor(c.itemId)}
              ${hpHistory(c.itemId)}
              ${entry ? statBlock(entry, c) : ""}
            </div>` : ""}
        </section>`;
  };
  // Everyone sits in a strip of small tiles (name, initiative) in turn order; a tile
  // opens the full card below the strip, in initiative order.
  const pill = (c: RosterEntry) => {
      const { entry } = entryFor(c);
      const alias = c.realName && c.realName !== c.name ? ` (shown as ${c.name})` : "";
      const tgt = targets.includes(c.itemId);
      const id = escapeHtml(c.itemId);
      const init = initEditing === c.itemId
        ? `<input class="pc-init-in" type="number" data-init-in="${id}" value="${c.hasInit === false ? "" : c.initiative}" />`
        : `<span class="pc-init ${c.hasInit === false ? "none" : ""}" data-init="${id}" title="Click to enter initiative">${c.hasInit === false ? "–" : c.initiative}</span>`;
      const roll = entry && !c.sheet ? `<span class="pc-roll" data-roll="${id}" title="Roll initiative">⚄</span>` : "";
      const sb = c.standby
        ? `<span class="pc-sb"><button type="button" class="pc-join" data-join="${id}" title="Put in initiative: HP bar and strip">⚔ Join</button><button type="button" class="pc-unstage" data-unstage="${id}" title="Take off the panel">✕</button></span>`
        : init;
      return `<div role="button" tabindex="0" class="pc-pill ${c.fallen ?? ""} ${open.has(c.itemId) ? "on" : ""} ${!entry || c.sheet ? "party" : c.ally ? "ally" : "npc"} ${c.standby ? "standby" : ""} ${tgt ? "targeted" : ""} ${c.itemId === turnId ? "turn" : ""} ${c.visible === false ? "hid" : ""}" data-id="${id}" title="${escapeHtml(c.realName && c.realName !== c.name ? `${c.name} (really ${c.realName})` : c.name)}">${c.standby ? "" : roll}<span class="tgt" data-tgt="${id}" title="${tgt ? "Untarget" : "Target"}">◎</span><span class="pc-name">${c.fallen === "dead" ? "☠ " : ""}${escapeHtml(c.name)}</span>${sb}${hpBar(c)}${headChips(c.itemId)}</div>`;
  };
  const fighting = roster.combatants.filter((c) => !c.standby);
  const standing = roster.combatants.filter((c) => c.standby).sort((a, b) => a.name.localeCompare(b.name));
  const standbyTiles = standing.length ? `<div class="sb-head"><span>On the panel, not in initiative</span>${standing.length > 1 ? `<button type="button" class="pc-join" data-join-all="1">⚔ All join</button>` : ""}</div><div class="pc-bar standby-bar">${standing.map(pill).join("")}</div>` : "";
  const fightTiles = fighting.length ? `${standing.length ? `<div class="sb-head"><span>In initiative</span></div>` : ""}<div class="pc-bar">${fighting.map(pill).join("")}</div>` : "";
  // standby first, then the fight; cards follow the same order
  app.innerHTML = standbyTiles + combatBar() + fightTiles + targetBar() + resolveCard() + [...standing, ...fighting].filter((c) => open.has(c.itemId)).map(card).join("");
  const sendCombat = (op: "join" | "unstage", ids: string[]) =>
    fastSend({ kind: "combat", id: crypto.randomUUID(), at: new Date().toISOString(), op, values: Object.fromEntries(ids.map((i) => [i, 1])) });
  app.querySelectorAll<HTMLButtonElement>("[data-join]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); sendCombat("join", [b.dataset.join!]); }));
  app.querySelector<HTMLButtonElement>("[data-join-all]")?.addEventListener("click", () => sendCombat("join", standing.map((c) => c.itemId)));
  app.querySelectorAll<HTMLButtonElement>("[data-unstage]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); sendCombat("unstage", [b.dataset.unstage!]); }));
  wireResolve();
  if (scrollToTurn && !scrollToResolve) {
    scrollToTurn = false;
    app.querySelector(".combatant.turn")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (scrollToResolve) {
    scrollToResolve = false;
    app.querySelector(".resolve")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  freshKey = undefined;

  app.querySelectorAll<HTMLElement>(".tgt").forEach((t) =>
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = t.dataset.tgt!;
      setTargets(targets.includes(id) ? targets.filter((x) => x !== id) : [...targets, id]);
    }),
  );
  app.querySelectorAll<HTMLButtonElement>(".tb-x").forEach((b) => b.addEventListener("click", () => setTargets(targets.filter((x) => x !== b.dataset.id))));
  app.querySelector<HTMLButtonElement>(".tb-clear")?.addEventListener("click", () => setTargets([]));
  wireInitiative();
  wireHp();
  app.querySelectorAll<HTMLButtonElement>("[data-fall]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      sendFallen(b.dataset.fall!, (b.dataset.state || null) as "dead" | "down" | null);
    }),
  );
  app.querySelectorAll<HTMLInputElement>(".ally-box").forEach((box) =>
    box.addEventListener("change", () => {
      const c = combatant(box.dataset.id!);
      if (c) c.ally = box.checked;
      fastSend({ kind: "combat", id: crypto.randomUUID(), at: new Date().toISOString(), op: "ally", values: { [box.dataset.id!]: box.checked ? 1 : null } });
      render();
    }),
  );
  app.querySelectorAll<HTMLElement>(".pc-pill").forEach((b) =>
    b.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-init], [data-roll], [data-init-in]")) return;
      const id = b.dataset.id!;
      if (open.has(id)) open.delete(id);
      else open.add(id);
      if (id === autoOpened) autoOpened = undefined;
      render();
    }),
  );


  app.querySelectorAll<HTMLButtonElement>("button.roll").forEach((b) =>
    b.addEventListener("click", () => {
      const ctx = actions.get(b.dataset.act!);
      if (!ctx) return;
      const op = b.dataset.op;
      if (op === "hit") doAttack(ctx, (b.dataset.mode as "adv" | "dis") || undefined);
      else if (op === "use") doUse(ctx);
      else if (op === "dmg") doDamage(ctx);
      else if (op === "extra") doExtra(ctx, Number(b.dataset.i));
      else if (op === "recharge") doRecharge(ctx);
      else if (op === "ready") setReady(ctx);
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("button.apply-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.id!;
      clearTimeout(applyTimer);
      if (applyArmed === id) {
        applyArmed = undefined;
        render();
        applyToToken(id, b.dataset.entry!);
        return;
      }
      applyArmed = id;
      render();
      applyTimer = setTimeout(() => {
        applyArmed = undefined;
        render();
      }, 4000);
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("button.st-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.id!;
      const i = Number(b.dataset.i);
      changeStatuses(id, (list) => {
        const st = list[i];
        if (!st) return list;
        const max = statusDef(st.key)?.max;
        if (b.dataset.op === "del") list.splice(i, 1);
        else if (b.dataset.op === "dm") list[i] = { ...st, dmOnly: !st.dmOnly };
        else if (b.dataset.op === "inc" && max) list[i] = { ...st, value: Math.min(max, (st.value ?? 1) + 1) };
        else if (b.dataset.op === "dec") {
          if ((st.value ?? 1) <= 1) list.splice(i, 1);
          else list[i] = { ...st, value: (st.value ?? 1) - 1 };
        }
        return list;
      });
    }),
  );
  app.querySelectorAll<HTMLSelectElement>("select.st-pick").forEach((sel) =>
    sel.addEventListener("change", () => {
      const id = sel.dataset.id!;
      const box = sel.closest(".statuses")!;
      const dm = box.querySelector<HTMLInputElement>(".st-dm")!.checked;
      if (sel.value === "__custom") {
        const inp = box.querySelector<HTMLInputElement>(".st-custom")!;
        inp.hidden = false;
        inp.focus();
        return;
      }
      if (sel.value) addStatus(id, sel.value, dm);
    }),
  );
  app.querySelectorAll<HTMLInputElement>("input.st-custom").forEach((inp) =>
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = inp.value.trim().slice(0, 40);
      if (!text) return;
      const dm = inp.closest(".statuses")!.querySelector<HTMLInputElement>(".st-dm")!.checked;
      addStatus(inp.dataset.id!, "", dm, text);
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("button.chk").forEach((b) =>
    b.addEventListener("click", () => {
      const c = checks.get(b.dataset.chk!);
      if (c) doCheck(c);
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("button.mode-pick").forEach((b) =>
    b.addEventListener("click", () => {
      const m = b.dataset.mode as "adv" | "dis" | "";
      if (m) checkMode.set(b.dataset.id!, m);
      else checkMode.delete(b.dataset.id!);
      render();
    }),
  );
  app.querySelectorAll<HTMLDetailsElement>("details.checks").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) checksOpen.add(d.dataset.id!);
      else checksOpen.delete(d.dataset.id!);
    }),
  );
  app.querySelectorAll<HTMLElement>(".combatant").forEach((row) => {
    const id = row.dataset.id!;
    const head = row.querySelector<HTMLElement>(".head")!;
    const toggle = () => {
      if (open.has(id)) open.delete(id);
      else open.add(id);
      if (id === autoOpened) autoOpened = undefined;
      render();
    };
    head.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".sb-pick, [data-hp], .hp-in")) return; // menus and HP edit, not a toggle
      toggle();
    });
    head.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).closest(".sb-pick")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    row.querySelector<HTMLSelectElement>(".pick")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v) assignments[id] = v;
      else delete assignments[id];
      render();
      persistAssignments();
    });
  });
}

async function persistAssignments() {
  const token = getToken();
  if (!token) {
    meta.textContent = "Choice not saved: no GitHub token";
    meta.className = "warn";
    return;
  }
  try {
    await saveAssignments(assignments, token);
    meta.textContent = "Stat block saved";
    meta.className = "";
  } catch (err) {
    meta.textContent = `Stat block not saved: ${err instanceof Error ? err.message : err}`;
    meta.className = "warn";
  }
}

async function update() {
  // linked: ask Owlbear for a fresh live roster too (the GitHub copy has no HP)
  lastLiveFp = "";
  fastSend({ kind: "roster-request", id: crypto.randomUUID(), at: new Date().toISOString() });
  updateBtn.disabled = true;
  meta.textContent = "Loading…";
  meta.className = "";
  const token = getToken();
  try {
    let st;
    [roster, bestiary, assignments, spells, st] = await Promise.all([
      loadRosterWith(token),
      loadBestiary(token),
      loadAssignments(token),
      loadSpells(token).catch(() => [] as Spell[]),
      loadStatuses(token).catch(() => ({ savedAt: null, tokens: {} })),
    ]);
    statuses = st.tokens ?? {};
    if (liveRoster) roster = { savedAt: new Date().toISOString(), combatants: liveRoster.map(asEntry) }; // live beats the saved copy
    meta.textContent = liveRoster
      ? "Live from Owlbear"
      : roster.savedAt
      ? `Saved at ${new Date(roster.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Nothing saved from Owlbear yet.";
  } catch (err) {
    meta.textContent = `Couldn't load: ${err instanceof Error ? err.message : err}`;
    meta.className = "warn";
  } finally {
    updateBtn.disabled = false;
    render();
  }
}

updateBtn.addEventListener("click", update);
renderSettings();
render();
update();

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
