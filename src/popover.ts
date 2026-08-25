import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { diceCloudLogin, fetchCreatureStats, parseCreatureId } from "./dicecloud";
import { FORGE_NAMESPACE, readForgeStats } from "./forge";
import {
  getMappings,
  getStoredCredentials,
  setStoredCredentials,
  upsertMapping,
  removeMapping,
  type Mapping,
} from "./config";

const app = document.getElementById("app")!;

app.innerHTML = `
  <section class="block">
    <h2>DiceCloud reader account</h2>
    <p class="hint">
      A DiceCloud account that's been added as a <strong>Reader</strong> on
      every party sheet. Kept only in this browser.
    </p>
    <input id="username" type="text" placeholder="Username or email" autocomplete="off" />
    <input id="password" type="password" placeholder="Password" autocomplete="off" />
    <div class="row">
      <button id="save-creds">Save &amp; test login</button>
      <span id="creds-status" class="status"></span>
    </div>
  </section>

  <section class="block">
    <h2>Party mapping</h2>
    <p class="hint">
      For each Forge unit, paste the DiceCloud character sheet URL to sync
      it from.
    </p>
    <div id="mapping-list">Loading tokens…</div>
  </section>
`;

const usernameInput = document.getElementById("username") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const credsStatus = document.getElementById("creds-status")!;
const mappingList = document.getElementById("mapping-list")!;

async function initCredentialsForm() {
  const stored = getStoredCredentials();
  if (stored) {
    usernameInput.value = stored.usernameOrEmail;
    passwordInput.placeholder = "•••••••• (saved)";
  }
}

document.getElementById("save-creds")!.addEventListener("click", async () => {
  const usernameOrEmail = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!usernameOrEmail || !password) {
    credsStatus.textContent = "Enter a username/email and password.";
    credsStatus.className = "status error";
    return;
  }

  credsStatus.textContent = "Testing…";
  credsStatus.className = "status";
  try {
    await diceCloudLogin(usernameOrEmail, password);
    setStoredCredentials({ usernameOrEmail, password });
    credsStatus.textContent = "✓ Logged in and saved.";
    credsStatus.className = "status ok";
  } catch (err) {
    credsStatus.textContent = err instanceof Error ? err.message : "Login failed.";
    credsStatus.className = "status error";
  }
});

async function renderMappings() {
  const [items, mappings] = await Promise.all([
    OBR.scene.items.getItems(),
    getMappings(),
  ]);

  const forgeItems = items.filter((item: Item) =>
    Boolean(item.metadata[FORGE_NAMESPACE])
  );

  if (forgeItems.length === 0) {
    mappingList.innerHTML = `<p class="hint">No Forge units found in this scene yet.</p>`;
    return;
  }

  const mappingByItem = new Map<string, Mapping>(mappings.map((m) => [m.itemId, m]));

  mappingList.innerHTML = "";
  for (const item of forgeItems) {
    const existing = mappingByItem.get(item.id);
    const forgeStats = readForgeStats(item.metadata);

    const row = document.createElement("div");
    row.className = "mapping-row";
    row.innerHTML = `
      <div class="mapping-header">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="hint">HP ${forgeStats.currentHP ?? "–"}/${forgeStats.maxHP ?? "–"} · AC ${forgeStats.ac ?? "–"}</span>
      </div>
      <input
        type="text"
        class="creature-url"
        placeholder="https://dicecloud.com/character/…"
        value="${escapeHtml(existing?.creatureId ?? "")}"
      />
      <div class="row">
        <button class="save-mapping">Save</button>
        <span class="status"></span>
      </div>
    `;

    const input = row.querySelector(".creature-url") as HTMLInputElement;
    const button = row.querySelector(".save-mapping") as HTMLButtonElement;
    const status = row.querySelector(".status") as HTMLSpanElement;

    button.addEventListener("click", async () => {
      const creatureId = parseCreatureId(input.value);
      if (!creatureId) {
        if (existing) await removeMapping(item.id);
        status.textContent = "Cleared.";
        status.className = "status";
        return;
      }

      status.textContent = "Checking…";
      status.className = "status";
      try {
        const creds = getStoredCredentials();
        const session = creds
          ? await diceCloudLogin(creds.usernameOrEmail, creds.password)
          : undefined;
        const stats = await fetchCreatureStats(creatureId, session?.token);
        await upsertMapping({ itemId: item.id, itemName: item.name, creatureId });
        status.textContent = `✓ Found ${stats.name ?? "character"} — HP ${stats.currentHP}/${stats.maxHP}, AC ${stats.ac}`;
        status.className = "status ok";
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : "Couldn't reach that sheet.";
        status.className = "status error";
      }
    });

    mappingList.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

OBR.onReady(async () => {
  await initCredentialsForm();
  await renderMappings();
  OBR.scene.items.onChange(() => {
    renderMappings();
  });
});
