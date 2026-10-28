// Standalone DM panel. Deliberately NOT an Owlbear extension page — this is
// just a plain page you open directly as its own browser tab (e.g. on a
// second monitor), with no OBR SDK access of its own. It gets everything it
// knows from background.ts, which runs inside Owlbear and has real access,
// via the BroadcastChannel bridge in dm-bridge.ts. See that file for why
// this only works in the same browser/profile as the Owlbear tab itself.
import { DM_PANEL_CHANNEL, type BridgeMessage } from "./dm-bridge";
import type { Combatant } from "./forge";

const app = document.getElementById("app")!;
const channel = new BroadcastChannel(DM_PANEL_CHANNEL);

let connected = false;
let combatants: Combatant[] = [];

function render() {
  if (!connected) {
    app.innerHTML = `
      <p class="hint warn">
        Not connected yet. Make sure Owlbear is open with a scene loaded, in
        this same browser — this panel can only talk to an Owlbear tab on
        the same machine/profile, not a different device.
      </p>
    `;
    return;
  }

  if (combatants.length === 0) {
    app.innerHTML = `<p class="hint">Nobody is currently on Forge's combat list.</p>`;
    return;
  }

  app.innerHTML = `
    <div class="roster">
      ${combatants
        .map(
          (c) => `
        <div class="combatant-row">
          <span class="init">${c.initiative}</span>
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="stats">HP ${c.currentHP ?? "–"}/${c.maxHP ?? "–"}${
            c.tempHP ? ` (+${c.tempHP} temp)` : ""
          } · AC ${c.ac ?? "–"}</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

channel.onmessage = (event: MessageEvent<BridgeMessage>) => {
  if (event.data?.type === "roster") {
    connected = true;
    combatants = event.data.combatants;
    render();
  }
};

function requestSnapshot() {
  const message: BridgeMessage = { type: "requestSnapshot" };
  channel.postMessage(message);
}

// background.ts might not have loaded yet (Owlbear opened after this panel,
// or the scene wasn't ready when this first fired) — keep asking every 2s
// until we actually hear back, then stop.
requestSnapshot();
const retry = setInterval(() => {
  if (connected) {
    clearInterval(retry);
    return;
  }
  requestSnapshot();
}, 2000);

render();

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
