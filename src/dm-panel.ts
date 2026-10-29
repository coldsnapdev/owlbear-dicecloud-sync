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

function chips(text: string, ctx: { itemId: string; who: string; action: string }): string {
  let i = 0;
  return escapeHtml(text).replace(/\[([^\]]+)\]/g, (whole, inner: string) => {
    const expr = inner.trim();
    const m = expr.replace(/\s+/g, "").match(DICE_RE);
    if (!m) return whole;
    const isHit = Number(m[2]) === 20 && Number(m[1] || 1) === 1;
    const key = `${ctx.itemId}|${ctx.action}|${i++}`;
    const data = `data-key="${escapeHtml(key)}" data-expr="${escapeHtml(expr)}" data-kind="${isHit ? "hit" : "dmg"}" data-item="${escapeHtml(ctx.itemId)}" data-who="${escapeHtml(ctx.who)}" data-action="${escapeHtml(ctx.action)}"`;
    const hitMod = Number((m[3] || "0").replace(/\s+/g, ""));
    const label = isHit ? `d20${hitMod >= 0 ? "+" : "−"}${Math.abs(hitMod)}` : escapeHtml(expr);
    const res = lastResult.get(key);
    return `<span class="chipwrap"><button type="button" class="chip ${isHit ? "hit" : "dmg"}" ${data}>${label}</button>${
      isHit ? `<button type="button" class="chip mini" ${data} data-mode="adv" title="Advantage">A</button><button type="button" class="chip mini" ${data} data-mode="dis" title="Disadvantage">D</button>` : ""
    }${res ? `<span class="res">${res}</span>` : ""}</span>`;
  });
}

function onChip(btn: HTMLButtonElement) {
  const { key, expr, kind, item, who, action, mode } = btn.dataset as Record<string, string>;
  const critKey = `${item}|${action}`;
  if (kind === "hit") {
    const r = rollExpr(expr, { mode: (mode as "adv" | "dis") || undefined });
    if (!r) return;
    const d20 = r.kept ?? r.dice[0];
    const nat = d20 === 20 ? "crit" : d20 === 1 ? "fumble" : undefined;
    if (nat === "crit") critPending.add(critKey);
    else critPending.delete(critKey);
    const how = r.kept !== undefined ? `d20 ${r.dice.join(" / ")} (${mode === "adv" ? "adv" : "dis"}) → ${d20}` : `d20 ${d20}`;
    const tag = nat === "crit" ? " — natural 20!" : nat === "fumble" ? " — natural 1" : "";
    lastResult.set(key, `<b>${r.total}</b>${tag}`);
    rollLog.unshift({ who, action, text: `to hit <b>${r.total}</b> (${how}${signed(r.mod)})${tag}`, tone: nat });
  } else {
    const crit = critPending.has(critKey);
    const r = rollExpr(expr, { double: crit });
    if (!r) return;
    // Stays set until the next to-hit roll, so every damage die in a critical
    // hit (e.g. Hairpin's piercing AND poison) is doubled.
    const after = btn.parentElement?.nextSibling?.textContent?.trim().split(/[\s.,]/)[0] ?? "";
    const type = /^[a-z]+$/i.test(after) && after.toLowerCase() !== "to" ? ` ${after}` : "";
    lastResult.set(key, `<b>${r.total}</b>${crit ? " (crit)" : ""}`);
    rollLog.unshift({
      who,
      action,
      text: `<b>${r.total}</b>${escapeHtml(type)} (${r.dice.join(" + ")}${signed(r.mod)})${crit ? " — critical, dice doubled" : ""}`,
      tone: crit ? "crit" : undefined,
    });
  }
  rollLog.splice(12);
  render();
}

function renderLog() {
  const el = document.getElementById("roll-log");
  if (!el) return;
  el.innerHTML = rollLog.length
    ? rollLog
        .map((l, i) => `<div class="logline ${l.tone ?? ""} ${i === 0 ? "latest" : ""}"><span class="who">${escapeHtml(l.who)} · ${escapeHtml(l.action)}</span> ${l.text}</div>`)
        .join("")
    : `<p class="hint small">Rolls appear here.</p>`;
}

function statBlock(e: BestiaryEntry, c: RosterEntry): string {
  const f = e.forge as Record<string, any>;
  const actions = (f[F + "Z035"] as { name: string; description: string }[] | undefined) ?? [];
  const who = c.realName || c.name;
  return `
    <div class="block">
      <div class="block-stats">CR ${crText(e.cr)} · AC ${f[F + "Z007"] ?? "–"} · HP ${f[F + "Z005"] ?? "–"} · Speed ${f[F + "Z008"] ?? "–"} ft</div>
      ${actions.map((a) => `<div class="act"><b>${escapeHtml(a.name)}.</b> ${chips(a.description, { itemId: c.itemId, who, action: a.name })}</div>`).join("")}
      <div class="hint small">From ${escapeHtml(e.source ?? "the bestiary")}${e.updated ? ` · updated ${escapeHtml(e.updated)}` : ""}</div>
    </div>`;
}

function render() {
  renderLog();
  if (!roster) {
    app.innerHTML = `<p class="hint">Click "Update Roster" to load the combat list saved from Owlbear.</p>`;
    return;
  }
  if (roster.combatants.length === 0) {
    app.innerHTML = `<p class="hint">Nobody is on Forge's combat list.</p>`;
    return;
  }
  const options = [...bestiary].sort((a, b) => a.name.localeCompare(b.name));
  app.innerHTML = `<div class="roster">${roster.combatants
    .map((c) => {
      const { entry, manual } = entryFor(c);
      const auto = autoMatch(c);
      const label = c.realName && c.realName !== c.name ? `${escapeHtml(c.realName)} <span class="alias">(${escapeHtml(c.name)})</span>` : escapeHtml(c.name);
      return `
        <div class="combatant" data-id="${escapeHtml(c.itemId)}">
          <div class="combatant-row">
            <span class="init">${c.initiative}</span>
            <span class="name">${label}</span>
            <span class="stats">AC ${c.ac ?? "–"}</span>
            <select class="pick" aria-label="Stat block">
              <option value="">${auto ? `Auto: ${escapeHtml(auto.name)}` : "No stat block (party member?)"}</option>
              ${options.map((o) => `<option value="${escapeHtml(o.id)}" ${manual && entry?.id === o.id ? "selected" : ""}>${escapeHtml(o.name)}</option>`).join("")}
            </select>
            ${entry ? `<button class="toggle secondary" type="button">${open.has(c.itemId) ? "Hide" : "Stat block"}</button>` : ""}
          </div>
          ${entry && open.has(c.itemId) ? statBlock(entry, c) : ""}
        </div>`;
    })
    .join("")}</div>`;

  app.querySelectorAll<HTMLButtonElement>(".chip").forEach((btn) => btn.addEventListener("click", () => onChip(btn)));
  app.querySelectorAll<HTMLElement>(".combatant").forEach((row) => {
    const id = row.dataset.id!;
    row.querySelector<HTMLSelectElement>(".pick")!.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v) assignments[id] = v;
      else delete assignments[id];
      render();
      persistAssignments();
    });
    row.querySelector<HTMLButtonElement>(".toggle")?.addEventListener("click", () => {
      if (open.has(id)) open.delete(id);
      else open.add(id);
      render();
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
