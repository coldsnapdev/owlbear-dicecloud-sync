// Standalone DM panel. A plain page opened as its own tab (any browser, any
// device) — not an Owlbear extension page, so it has no OBR SDK access. It
// reads the combat roster that the extension saves to the GitHub mailbox
// (see mailbox.ts) whenever "Update Roster" is clicked.
import { loadRoster, type RosterFile } from "./mailbox";

const app = document.getElementById("app")!;
const button = document.getElementById("update-roster") as HTMLButtonElement;
const meta = document.getElementById("roster-meta")!;

let roster: RosterFile | undefined;

function render() {
  if (!roster) {
    app.innerHTML = `<p class="hint">Click "Update Roster" to load the combat list saved from Owlbear.</p>`;
    return;
  }
  if (roster.combatants.length === 0) {
    app.innerHTML = `<p class="hint">Nobody is on Forge's combat list.</p>`;
    return;
  }
  app.innerHTML = `
    <div class="roster">
      ${roster.combatants
        .map(
          (c) => `
        <div class="combatant-row">
          <span class="init">${c.initiative}</span>
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="stats">AC ${c.ac ?? "–"}</span>
        </div>`
        )
        .join("")}
    </div>
  `;
}

async function update() {
  button.disabled = true;
  meta.textContent = "Loading…";
  meta.className = "hint";
  try {
    roster = await loadRoster();
    meta.textContent = roster.savedAt
      ? `Saved from Owlbear at ${new Date(roster.savedAt).toLocaleTimeString()}`
      : "Nothing saved from Owlbear yet.";
  } catch (err) {
    meta.textContent = `Couldn't load the roster: ${err instanceof Error ? err.message : err}`;
    meta.className = "hint warn";
  } finally {
    button.disabled = false;
    render();
  }
}

button.addEventListener("click", update);
render();
update();

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
