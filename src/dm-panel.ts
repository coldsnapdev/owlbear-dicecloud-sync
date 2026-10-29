// Standalone DM panel. A plain page opened as its own tab (any browser, any
// device) — not an Owlbear extension page, so it has no OBR SDK access. It
// reads the combat roster that the extension saves to the GitHub mailbox
// (see mailbox.ts), matches each combatant to a bestiary entry from the DM
// manual, lets the DM roll from the stat block, and posts the results to
// Discord with flavour text (and full spell text) for the table.
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
} from "./mailbox";

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
const open = new Set<string>(); // itemIds whose stat block is expanded

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
  ($<HTMLInputElement>("gh-token")).placeholder = hasToken ? "•••••••• (saved)" : "GitHub token";
  ($<HTMLInputElement>("discord-webhook")).placeholder = hasHook ? "•••••••• (saved)" : "Discord webhook URL";
  const status = $<HTMLElement>("token-status");
  status.textContent = [
    hasToken ? "GitHub token found: stat block choices are saved for every device." : "No GitHub token: stat block choices can't be saved.",
    hasHook ? "Discord webhook set." : "No Discord webhook: public rolls won't post anywhere.",
  ].join(" ");
  status.className = hasToken && hasHook ? "hint" : "hint warn";
  publicToggle.checked = isPublic();
  publicLabel.textContent = isPublic() ? "Public: rolls post to Discord" : "Private: rolls stay here";
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
// clicks: at the table the DM asks "does 15 beat your AC?" and the player
// answers, so the panel never compares against AC itself.
const DICE_RE = /^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i;

interface Roll { total: number; dice: number[]; mod: number; kept?: number }

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
    return { total: kept + mod, dice: [a, b], mod, kept };
  }
  const dice = Array.from({ length: count }, () => randInt(sides));
  return { total: dice.reduce((x, y) => x + y, 0) + mod, dice, mod };
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

function parseAction(a: { name: string; description: string }): ParsedAction {
  const { category, title } = categorise(a.name);
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
    else p.extras.push({ expr, type: "" });
  }
  p.dcs = Array.from(a.description.matchAll(/DC\s*(\d+)\s+([A-Za-z]+)/g)).map((x) => `DC ${x[1]} ${ABILITIES[x[2].toLowerCase()] ?? x[2]}`);
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

/** Flavour (or the rules text) plus full spell text, for attack and "use" posts. */
function describe(ctx: ActionCtx): string {
  const parts = [flavour(ctx) ?? ctx.p.plain];
  const spell = spellFor(ctx.p.title);
  if (spell) parts.push(spellBlock(spell));
  return parts.join("\n\n");
}

async function log(line: LogLine, embed: Embed, privateRoll = !isPublic()) {
  rollLog.unshift(line);
  rollLog.splice(15);
  render();
  const status = await postToDiscord(embed, privateRoll);
  line.status = status === "posted" ? "" : status === "private" ? "Private" : status === "no-webhook" ? "Not posted: no webhook" : "Discord post failed";
  renderLog();
}

function doAttack(ctx: ActionCtx, mode?: "adv" | "dis") {
  const r = rollExpr(ctx.p.hit!.expr, { mode });
  if (!r) return;
  const d20 = r.kept ?? r.dice[0];
  const nat = d20 === 20 ? "crit" : d20 === 1 ? "fumble" : undefined;
  if (nat === "crit") critPending.add(ctx.key);
  else critPending.delete(ctx.key);
  const how = r.kept !== undefined ? `d20 ${r.dice.join(" / ")} ${mode === "adv" ? "with advantage" : "with disadvantage"}${signed(r.mod)}` : `d20 ${d20}${signed(r.mod)}`;
  const tag = nat === "crit" ? "Natural 20!" : nat === "fumble" ? "Natural 1" : "";
  lastResult.set(`${ctx.key}|hit`, `<b>${r.total}</b>${tag ? ` <em class="${nat}">${tag}</em>` : ""}`);
  freshKey = `${ctx.key}|hit`;
  log(
    { who: ctx.dmName, action: ctx.p.title, text: `<span class="big">${r.total}</span> to hit <span class="how">${how}</span>${tag ? ` <em class="${nat}">${tag}</em>` : ""}`, tone: nat },
    {
      author: { name: ctx.shown },
      title: ctx.p.title,
      description: `${describe(ctx)}\n\n**To hit: ${r.total}** (${how})${tag ? ` — **${tag}**` : ""}`,
      color: nat ? COLOUR[nat] : COLOUR.brass,
    },
  );
}

function doUse(ctx: ActionCtx) {
  lastResult.set(`${ctx.key}|use`, `<em>posted</em>`);
  freshKey = `${ctx.key}|use`;
  const dcs = ctx.p.dcs.length ? `\n\n**${ctx.p.dcs.join(" · ")}**` : "";
  log({ who: ctx.dmName, action: ctx.p.title, text: `uses ${escapeHtml(ctx.p.title)}` }, {
    author: { name: ctx.shown },
    title: ctx.p.title,
    description: describe(ctx) + dcs,
    color: COLOUR.brass,
  });
}

function doDamage(ctx: ActionCtx) {
  const crit = critPending.has(ctx.key); // stays until this action's next to-hit, so every die in a crit doubles
  const rolls = ctx.p.damage.map((d) => ({ d, r: rollExpr(d.expr, { double: crit })! })).filter((x) => x.r);
  if (!rolls.length) return;
  const verb = ctx.p.hit ? "hits and deals" : "deals";
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
      description: `${ctx.shown}'s ${ctx.p.title} ${verb}:\n${rolls.map((x) => `**${x.r.total}** ${x.d.type} damage`).join("\n")}${crit ? "\n*Critical hit: damage dice doubled*" : ""}`,
      color: crit ? COLOUR.crit : COLOUR.brass,
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
    { author: { name: ctx.shown }, description: `${ctx.shown}'s ${ctx.p.title}: **${r.total}** (${d.expr}: ${working(r)})`, color: COLOUR.brass },
  );
}

// --- Free dice box ------------------------------------------------------------------
const diceInput = $<HTMLInputElement>("dice-input");
const dicePrivate = $<HTMLInputElement>("dice-private");
function rollBox() {
  const expr = diceInput.value.trim();
  const r = rollExpr(expr);
  if (!r) {
    diceInput.classList.add("bad");
    return;
  }
  diceInput.classList.remove("bad");
  freshKey = "box";
  const privateRoll = dicePrivate.checked || !isPublic();
  log(
    { who: "Dice", action: expr, text: `<span class="big">${r.total}</span> <span class="how">${working(r)}</span>` },
    { author: { name: "The DM rolls" }, description: `**${r.total}** (${expr}: ${working(r)})`, color: COLOUR.dice },
    privateRoll,
  );
}
$<HTMLButtonElement>("dice-roll").addEventListener("click", rollBox);
diceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") rollBox();
});

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
  if (p.hit) {
    const sign = p.hit.mod >= 0 ? "+" : "−";
    parts.push(`<span class="rollgroup"><button type="button" class="roll hit" data-act="${k}" data-op="hit" title="Roll to hit and post the attack">Attack ${sign}${Math.abs(p.hit.mod)}</button><span class="seg"><button type="button" class="roll mode" data-act="${k}" data-op="hit" data-mode="adv" title="Roll with advantage">Adv</button><button type="button" class="roll mode" data-act="${k}" data-op="hit" data-mode="dis" title="Roll with disadvantage">Dis</button></span>${resultSpan(`${ctx.key}|hit`)}</span>`);
  } else if (p.category !== "trait" && p.category !== "tactics") {
    parts.push(`<span class="rollgroup"><button type="button" class="roll use" data-act="${k}" data-op="use" title="Post this action's description to Discord">${spellFor(p.title) ? "Cast" : "Use"}</button>${resultSpan(`${ctx.key}|use`)}</span>`);
  }
  if (p.damage.length) {
    parts.push(`<span class="rollgroup"><button type="button" class="roll dmg" data-act="${k}" data-op="dmg" title="Roll all damage">Damage <span class="parts">${p.damage.map((d) => `${escapeHtml(d.expr)} <i class="t-${d.type}">${d.type}</i>`).join(" · ")}</span></button>${resultSpan(`${ctx.key}|dmg`)}</span>`);
  }
  p.extras.forEach((d, i) => {
    parts.push(`<span class="rollgroup"><button type="button" class="roll extra" data-act="${k}" data-op="extra" data-i="${i}" title="Roll ${escapeHtml(d.expr)}">${escapeHtml(d.expr)}</button>${resultSpan(`${ctx.key}|x${i}`)}</span>`);
  });
  return parts.length ? `<div class="rolls">${parts.join("")}</div>` : "";
}

const SECTIONS: [Category, string][] = [["action", "Actions"], ["bonus", "Bonus actions"], ["reaction", "Reactions"], ["legendary", "Legendary actions"], ["trait", "Traits"]];

function statBlock(e: BestiaryEntry, c: RosterEntry): string {
  const f = e.forge as Record<string, any>;
  const raw = (f[F + "Z035"] as { name: string; description: string }[] | undefined) ?? [];
  const ctxs = raw.map((a, i) => {
    const ctx: ActionCtx = { key: `${c.itemId}#${i}`, itemId: c.itemId, dmName: c.realName || c.name, shown: c.name, entry: e, raw: a, p: parseAction(a) };
    actions.set(ctx.key, ctx);
    return ctx;
  });
  const card = (ctx: ActionCtx) => `
    <div class="action ${ctx.p.category}">
      <div class="action-head"><span class="action-name">${escapeHtml(ctx.p.title)}</span>${ctx.p.dcs.map((d) => `<span class="dc">${escapeHtml(d)}</span>`).join("")}${spellFor(ctx.p.title) ? `<span class="spell-tag">Spell</span>` : ""}${e.flavour?.[ctx.raw.name]?.length ? `<span class="flav-tag" title="Has flavour text for Discord">Flavour</span>` : ""}</div>
      ${rollRow(ctx)}
      <div class="action-text">${ctx.p.text}</div>
    </div>`;
  return `
    <div class="sheet">
      <div class="vitals">
        <span><small>CR</small>${crText(e.cr)}</span><span><small>AC</small>${f[F + "Z007"] ?? "–"}</span><span><small>HP</small>${f[F + "Z005"] ?? "–"}</span><span><small>Speed</small>${f[F + "Z008"] ?? "–"} ft</span>
      </div>
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
    : `<p class="empty">Rolls appear here.</p>`;
}

function render() {
  renderLog();
  actions.clear();
  if (!roster) {
    app.innerHTML = `<p class="empty">Click "Update Roster" to load the combat list saved from Owlbear.</p>`;
    freshKey = undefined;
    return;
  }
  if (roster.combatants.length === 0) {
    app.innerHTML = `<p class="empty">Nobody is on Forge's combat list.</p>`;
    freshKey = undefined;
    return;
  }
  const options = [...bestiary].sort((a, b) => a.name.localeCompare(b.name));
  app.innerHTML = roster.combatants
    .map((c) => {
      const { entry, manual } = entryFor(c);
      const auto = autoMatch(c);
      const isOpen = open.has(c.itemId);
      const alias = c.realName && c.realName !== c.name ? `<span class="alias">shown as ${escapeHtml(c.name)}</span>` : "";
      const tag = !entry ? `<span class="tag">Party</span>` : manual ? `<span class="tag set">${escapeHtml(entry.name)}</span>` : "";
      return `
        <section class="combatant ${isOpen ? "open" : ""} ${entry ? "" : "party"}" data-id="${escapeHtml(c.itemId)}">
          <button type="button" class="head" aria-expanded="${isOpen}">
            <span class="init">${c.initiative}</span>
            <span class="who"><span class="name">${escapeHtml(c.realName || c.name)}</span>${alias}</span>
            ${tag}
            <span class="ac" title="Armour class"><small>AC</small>${c.ac ?? "–"}</span>
            <span class="chev" aria-hidden="true"></span>
          </button>
          ${isOpen ? `
            <div class="body">
              <label class="picker">Stat block
                <select class="pick">
                  <option value="">${auto ? `Auto: ${escapeHtml(auto.name)}` : "None (party member)"}</option>
                  ${options.map((o) => `<option value="${escapeHtml(o.id)}" ${manual && entry?.id === o.id ? "selected" : ""}>${escapeHtml(o.name)}</option>`).join("")}
                </select>
              </label>
              ${entry ? statBlock(entry, c) : `<p class="empty">No stat block. Party members are listed so you can see the turn order; pick an entry above if this token should have one.</p>`}
            </div>` : ""}
        </section>`;
    })
    .join("");
  freshKey = undefined;

  app.querySelectorAll<HTMLButtonElement>("button.roll").forEach((b) =>
    b.addEventListener("click", () => {
      const ctx = actions.get(b.dataset.act!);
      if (!ctx) return;
      const op = b.dataset.op;
      if (op === "hit") doAttack(ctx, (b.dataset.mode as "adv" | "dis") || undefined);
      else if (op === "use") doUse(ctx);
      else if (op === "dmg") doDamage(ctx);
      else if (op === "extra") doExtra(ctx, Number(b.dataset.i));
    }),
  );
  app.querySelectorAll<HTMLElement>(".combatant").forEach((row) => {
    const id = row.dataset.id!;
    row.querySelector<HTMLButtonElement>(".head")!.addEventListener("click", () => {
      if (open.has(id)) open.delete(id);
      else open.add(id);
      render();
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
    meta.textContent = "Choice kept for now, but not saved: add a GitHub token in Settings.";
    meta.className = "warn";
    return;
  }
  try {
    await saveAssignments(assignments, token);
    meta.textContent = "Stat block choice saved.";
    meta.className = "";
  } catch (err) {
    meta.textContent = `Couldn't save the stat block choice: ${err instanceof Error ? err.message : err}`;
    meta.className = "warn";
  }
}

async function update() {
  updateBtn.disabled = true;
  meta.textContent = "Loading…";
  meta.className = "";
  const token = getToken();
  try {
    [roster, bestiary, assignments, spells] = await Promise.all([
      loadRosterWith(token),
      loadBestiary(token),
      loadAssignments(token),
      loadSpells(token).catch(() => [] as Spell[]),
    ]);
    meta.textContent = roster.savedAt
      ? `Saved from Owlbear at ${new Date(roster.savedAt).toLocaleTimeString()} · ${bestiary.length} stat blocks · ${spells.length} spells`
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
