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

function getToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function renderTokenStatus() {
  const has = !!getToken();
  tokenInput.placeholder = has ? "•••••••• (saved)" : "GitHub token";
  tokenStatus.textContent = has ? "Stat block choices are saved for every device." : "Without a token, stat block choices can't be saved.";
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

function statBlock(e: BestiaryEntry): string {
  const f = e.forge as Record<string, any>;
  const actions = (f[F + "Z035"] as { name: string; description: string }[] | undefined) ?? [];
  return `
    <div class="block">
      <div class="block-stats">CR ${crText(e.cr)} · AC ${f[F + "Z007"] ?? "–"} · HP ${f[F + "Z005"] ?? "–"} · Speed ${f[F + "Z008"] ?? "–"} ft</div>
      ${actions.map((a) => `<div class="act"><b>${escapeHtml(a.name)}.</b> ${escapeHtml(a.description)}</div>`).join("")}
      <div class="hint small">From ${escapeHtml(e.source ?? "the bestiary")}${e.updated ? ` · updated ${escapeHtml(e.updated)}` : ""}</div>
    </div>`;
}

function render() {
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
          ${entry && open.has(c.itemId) ? statBlock(entry) : ""}
        </div>`;
    })
    .join("")}</div>`;

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
