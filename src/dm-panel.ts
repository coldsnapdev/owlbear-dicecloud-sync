// Standalone DM panel. A plain page opened as its own tab (any browser, any
// device) — not an Owlbear extension page, so it has no OBR SDK access. It
// reads the combat roster that the extension saves to the GitHub mailbox
// (see mailbox.ts), matches each combatant to a bestiary entry from the DM
// manual, and lets the DM override that match per token.
import {
  loadAssignments,
  loadBestiary,
  loadRosterWith,
  saveAssignments,
  type Assignments,
  type BestiaryEntry,
  type RosterEntry,
  type RosterFile,
} from "./mailbox";

const F = "com.battle-system.forge/";
const TOKEN_KEY = "dm-panel/github-token";

const app = document.getElementById("app")!;
const button = document.getElementById("update-roster") as HTMLButtonElement;
const meta = document.getElementById("roster-meta")!;
const tokenInput = document.getElementById("gh-token") as HTMLInputElement;
const tokenSave = document.getElementById("save-gh-token") as HTMLButtonElement;
const tokenStatus = document.getElementById("token-status")!;

let roster: RosterFile | undefined;
let bestiary: BestiaryEntry[] = [];
let assignments: Assignments = {};
const open = new Set<string>(); // itemIds whose stat block is expanded

// The DM manual (coldsnapdev.github.io/abelon-manual) lives on the same origin
// as this panel, so it shares localStorage. If the manual's sync is already
// connected in this browser, reuse its token rather than asking again (it
// works as long as that token's repository access includes this repo).
const MANUAL_TOKEN_KEY = "abelonSyncToken";

function getToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(MANUAL_TOKEN_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function renderTokenStatus() {
  const has = !!getToken();
  tokenInput.placeholder = has ? "•••••••• (saved)" : "GitHub token";
  tokenStatus.textContent = has
    ? "Token found: stat block choices are saved for every device. You won't be asked again in this browser."
    : "Without a token, stat block choices can't be saved. You only need to enter it once per browser.";
  tokenStatus.className = has ? "hint" : "hint warn";
}

tokenSave.addEventListener("click", () => {
  const t = tokenInput.value.trim();
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
  tokenInput.value = "";
  renderTokenStatus();
});

// --- Matching ------------------------------------------------------------------
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Real name first (the Namer's), then Forge's name; also tries without a trailing number ("Blighted Wolf 3"). */
function autoMatch(c: RosterEntry): BestiaryEntry | undefined {
  const byName = new Map(bestiary.map((e) => [norm(e.name), e]));
  for (const n of [c.realName, c.name]) {
    if (!n) continue;
    const exact = byName.get(norm(n));
    if (exact) return exact;
    const stripped = byName.get(norm(n.replace(/\s*\d+$/, "")));
    if (stripped) return stripped;
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

// --- Rendering -----------------------------------------------------------------
function crText(c?: number): string {
  if (c === undefined) return "–";
  return c === 0.125 ? "1/8" : c === 0.25 ? "1/4" : c === 0.5 ? "1/2" : String(c);
}

// --- Dice -------------------------------------------------------------------------
// Forge writes dice in square brackets: [1d20+7] is a to-hit roll, anything
// else ([1d4+4], [2d6]) is damage or other dice. Every bracketed roll in a stat
// block becomes a clickable chip. To-hit and damage are deliberately separate
// clicks: at the table the DM asks "does 15 beat your AC?" and the player
// answers, so the panel never compares against AC itself.
const DICE_RE = /^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i;

interface Roll {
  total: number;
  dice: number[];
  mod: number;
  kept?: number; // for adv/dis: the d20 that counted
}

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
  if (opts.double) count *= 2;
  if (sides === 20 && count === 1 && opts.mode) {
    const a = randInt(20), b = randInt(20);
    const kept = opts.mode === "adv" ? Math.max(a, b) : Math.min(a, b);
    return { total: kept + mod, dice: [a, b], mod, kept };
  }
  const dice = Array.from({ length: count }, () => randInt(sides));
  return { total: dice.reduce((x, y) => x + y, 0) + mod, dice, mod };
}

function signed(n: number): string {
  return n === 0 ? "" : n > 0 ? ` + ${n}` : ` − ${-n}`;
}

interface LogLine {
  who: string;
  action: string;
  text: string;
  tone?: "crit" | "fumble";
}
const rollLog: LogLine[] = [];
const lastResult = new Map<string, string>(); // chip key -> short result shown beside it
const critPending = new Set<string>(); // "itemId|action" after a natural 20
let freshKey: string | undefined; // the roll just made, so only it animates

// --- Parsing a Forge action into something clickable ---------------------------
const DAMAGE_TYPES = new Set(["acid","bludgeoning","cold","fire","force","lightning","necrotic","piercing","poison","psychic","radiant","slashing","thunder","healing"]);
const ABILITIES: Record<string, string> = { strength: "Str", dexterity: "Dex", constitution: "Con", intelligence: "Int", wisdom: "Wis", charisma: "Cha", str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };

type Category = "action" | "bonus" | "reaction" | "legendary" | "trait" | "tactics";
interface RollSpec { key: string; expr: string; kind: "hit" | "dmg"; mod: number; type: string }
interface ParsedAction { title: string; category: Category; rolls: RollSpec[]; dcs: string[]; text: string }

function categorise(name: string): { category: Category; title: string } {
  const strip = (re: RegExp) => name.replace(re, "").trim();
  if (/^tactics/i.test(name)) return { category: "tactics", title: "Tactics" };
  if (/^trait:|\(trait\)/i.test(name)) return { category: "trait", title: strip(/^trait:\s*|\s*\(trait\)/gi) };
  if (/^bonus action:|\(bonus action\)/i.test(name)) return { category: "bonus", title: strip(/^bonus action:\s*|\s*\(bonus action\)/gi) };
  if (/^reaction:|\(reaction\)/i.test(name)) return { category: "reaction", title: strip(/^reaction:\s*|\s*\(reaction\)/gi) };
  if (/legendary/i.test(name)) return { category: "legendary", title: strip(/^legendary( action)?:\s*|\s*\(legendary( action)?\)/gi) };
  return { category: "action", title: name };
}

function parseAction(a: { name: string; description: string }, itemId: string): ParsedAction {
  const { category, title } = categorise(a.name);
  const rolls: RollSpec[] = [];
  const re = /\[([^\]]+)\]\s*([A-Za-z]+)?/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(a.description))) {
    const expr = m[1].trim();
    const d = expr.replace(/\s+/g, "").match(DICE_RE);
    if (!d) continue;
    const isHit = Number(d[2]) === 20 && Number(d[1] || 1) === 1;
    const word = (m[2] || "").toLowerCase();
    rolls.push({
      key: `${itemId}|${a.name}|${i++}`,
      expr,
      kind: isHit ? "hit" : "dmg",
      mod: Number((d[3] || "0").replace(/\s+/g, "")),
      type: !isHit && DAMAGE_TYPES.has(word) ? word : "",
    });
  }
  const dcs = Array.from(a.description.matchAll(/DC\s*(\d+)\s+([A-Za-z]+)/g)).map((x) => `DC ${x[1]} ${ABILITIES[x[2].toLowerCase()] ?? x[2]}`);
  // Description text with dice shown as quiet inline marks (the buttons do the rolling)
  const text = escapeHtml(a.description).replace(/\[([^\]]+)\]/g, '<span class="dice">$1</span>');
  return { title, category, rolls, dcs, text };
}

function rollButtons(r: RollSpec, ctx: { itemId: string; who: string; action: string }): string {
  const data = `data-key="${escapeHtml(r.key)}" data-expr="${escapeHtml(r.expr)}" data-kind="${r.kind}" data-type="${r.type}" data-item="${escapeHtml(ctx.itemId)}" data-who="${escapeHtml(ctx.who)}" data-action="${escapeHtml(ctx.action)}"`;
  const res = lastResult.get(r.key);
  const out = res ? `<span class="result${freshKey === r.key ? " fresh" : ""}">${res}</span>` : "";
  if (r.kind === "hit") {
    const sign = r.mod >= 0 ? "+" : "−";
    return `<span class="rollgroup"><button type="button" class="roll hit" ${data} title="Roll to hit">Attack ${sign}${Math.abs(r.mod)}</button><span class="seg"><button type="button" class="roll mode" ${data} data-mode="adv" title="Roll with advantage">Adv</button><button type="button" class="roll mode" ${data} data-mode="dis" title="Roll with disadvantage">Dis</button></span>${out}</span>`;
  }
  return `<span class="rollgroup"><button type="button" class="roll dmg ${r.type || "plain"}" ${data} title="Roll ${escapeHtml(r.expr)}">${escapeHtml(r.expr)}${r.type ? ` <i>${r.type}</i>` : ""}</button>${out}</span>`;
}

function onRoll(btn: HTMLButtonElement) {
  const { key, expr, kind, type, item, who, action, mode } = btn.dataset as Record<string, string>;
  const critKey = `${item}|${action}`;
  if (kind === "hit") {
    const r = rollExpr(expr, { mode: (mode as "adv" | "dis") || undefined });
    if (!r) return;
    const d20 = r.kept ?? r.dice[0];
    const nat = d20 === 20 ? "crit" : d20 === 1 ? "fumble" : undefined;
    if (nat === "crit") critPending.add(critKey);
    else critPending.delete(critKey);
    const how = r.kept !== undefined ? `d20 ${r.dice.join(" / ")} ${mode === "adv" ? "adv" : "dis"} → ${d20}` : `d20 ${d20}`;
    const tag = nat === "crit" ? "Natural 20" : nat === "fumble" ? "Natural 1" : "";
    lastResult.set(key, `<b>${r.total}</b>${tag ? ` <em class="${nat}">${tag}</em>` : ""}`);
    rollLog.unshift({ who, action, text: `<span class="big">${r.total}</span> to hit <span class="how">${how}${signed(r.mod)}</span>${tag ? ` <em class="${nat}">${tag}</em>` : ""}`, tone: nat });
  } else {
    // A crit stays live until that action's next to-hit roll, so every damage
    // die in a critical hit (e.g. Hairpin's piercing AND poison) is doubled.
    const crit = critPending.has(critKey);
    const r = rollExpr(expr, { double: crit });
    if (!r) return;
    lastResult.set(key, `<b>${r.total}</b>${crit ? ` <em class="crit">crit</em>` : ""}`);
    rollLog.unshift({
      who,
      action,
      text: `<span class="big">${r.total}</span> ${escapeHtml(type || "")} <span class="how">${r.dice.join(" + ")}${signed(r.mod)}</span>${crit ? ` <em class="crit">Critical: dice doubled</em>` : ""}`,
      tone: crit ? "crit" : undefined,
    });
  }
  rollLog.splice(12);
  freshKey = key;
  render();
  freshKey = undefined;
}

function renderLog() {
  const el = document.getElementById("roll-log");
  if (!el) return;
  el.innerHTML = rollLog.length
    ? rollLog.map((l, i) => `<div class="logline ${l.tone ?? ""} ${i === 0 ? "latest" : ""} ${i === 0 && freshKey ? "fresh" : ""}"><span class="who">${escapeHtml(l.who)} · ${escapeHtml(l.action)}</span><span class="what">${l.text}</span></div>`).join("")
    : `<p class="empty">Rolls appear here.</p>`;
}

const SECTIONS: [Category, string][] = [["action", "Actions"], ["bonus", "Bonus actions"], ["reaction", "Reactions"], ["legendary", "Legendary actions"], ["trait", "Traits"]];

function statBlock(e: BestiaryEntry, c: RosterEntry): string {
  const f = e.forge as Record<string, any>;
  const raw = (f[F + "Z035"] as { name: string; description: string }[] | undefined) ?? [];
  const who = c.realName || c.name;
  const parsed = raw.map((a) => ({ a, p: parseAction(a, c.itemId) }));
  const card = ({ a, p }: { a: { name: string }; p: ParsedAction }) => `
    <div class="action ${p.category}">
      <div class="action-head"><span class="action-name">${escapeHtml(p.title)}</span>${p.dcs.map((d) => `<span class="dc">${escapeHtml(d)}</span>`).join("")}</div>
      ${p.rolls.length ? `<div class="rolls">${p.rolls.map((r) => rollButtons(r, { itemId: c.itemId, who, action: a.name })).join("")}</div>` : ""}
      <div class="action-text">${p.text}</div>
    </div>`;
  const tactics = parsed.filter((x) => x.p.category === "tactics");
  return `
    <div class="sheet">
      <div class="vitals">
        <span><small>CR</small>${crText(e.cr)}</span><span><small>AC</small>${f[F + "Z007"] ?? "–"}</span><span><small>HP</small>${f[F + "Z005"] ?? "–"}</span><span><small>Speed</small>${f[F + "Z008"] ?? "–"} ft</span>
      </div>
      ${SECTIONS.map(([cat, label]) => {
        const items = parsed.filter((x) => x.p.category === cat);
        return items.length ? `<h3>${label}</h3>${items.map(card).join("")}` : "";
      }).join("")}
      ${tactics.map((x) => `<div class="tactics"><b>Tactics.</b> ${x.p.text}</div>`).join("")}
      <div class="source">From ${escapeHtml(e.source ?? "the bestiary")}${e.updated ? ` · updated ${escapeHtml(e.updated)}` : ""}</div>
    </div>`;
}

function render() {
  renderLog();
  if (!roster) {
    app.innerHTML = `<p class="empty">Click "Update Roster" to load the combat list saved from Owlbear.</p>`;
    return;
  }
  if (roster.combatants.length === 0) {
    app.innerHTML = `<p class="empty">Nobody is on Forge's combat list.</p>`;
    return;
  }
  const options = [...bestiary].sort((a, b) => a.name.localeCompare(b.name));
  app.innerHTML = roster.combatants
    .map((c) => {
      const { entry, manual } = entryFor(c);
      const auto = autoMatch(c);
      const isOpen = open.has(c.itemId);
      const shownName = c.realName || c.name;
      const alias = c.realName && c.realName !== c.name ? `<span class="alias">shown as ${escapeHtml(c.name)}</span>` : "";
      const tag = !entry ? `<span class="tag">Party</span>` : manual ? `<span class="tag set">${escapeHtml(entry.name)}</span>` : "";
      return `
        <section class="combatant ${isOpen ? "open" : ""} ${entry ? "" : "party"}" data-id="${escapeHtml(c.itemId)}">
          <button type="button" class="head" aria-expanded="${isOpen}">
            <span class="init">${c.initiative}</span>
            <span class="who"><span class="name">${escapeHtml(shownName)}</span>${alias}</span>
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

  app.querySelectorAll<HTMLButtonElement>("button.roll").forEach((b) => b.addEventListener("click", () => onRoll(b)));
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
    meta.textContent = "Choice kept for now, but not saved: add a GitHub token below.";
    meta.className = "hint warn";
    return;
  }
  try {
    await saveAssignments(assignments, token);
    meta.textContent = "Stat block choice saved.";
    meta.className = "hint";
  } catch (err) {
    meta.textContent = `Couldn't save the stat block choice: ${err instanceof Error ? err.message : err}`;
    meta.className = "hint warn";
  }
}

async function update() {
  button.disabled = true;
  meta.textContent = "Loading…";
  meta.className = "hint";
  const token = getToken();
  try {
    [roster, bestiary, assignments] = await Promise.all([loadRosterWith(token), loadBestiary(token), loadAssignments(token)]);
    meta.textContent = roster.savedAt
      ? `Saved from Owlbear at ${new Date(roster.savedAt).toLocaleTimeString()} · ${bestiary.length} stat blocks in the bestiary`
      : "Nothing saved from Owlbear yet.";
  } catch (err) {
    meta.textContent = `Couldn't load: ${err instanceof Error ? err.message : err}`;
    meta.className = "hint warn";
  } finally {
    button.disabled = false;
    render();
  }
}

button.addEventListener("click", update);
renderTokenStatus();
render();
update();

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
