import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { diceCloudLogin, fetchCreatureStats, parseCreatureId } from "./dicecloud";
import { isForgeUnit, readForgeStats } from "./forge";
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

  <p class="hint" style="opacity:0.5;">build 4 — scene-ready guard + on-screen errors</p>
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

let itemChangeListenerAttached = false;

async function renderMappings() {
  // Scene APIs throw if called before a scene is actually open/ready (e.g.
  // the room has no scene loaded yet, or is mid-transition). That throw was
  // previously uncaught, which left the popover stuck on the static
  // "Loading tokens…" text forever with nothing logged, because our
  // diagnostics only ran *after* this point. Guard + try/catch fix both.
  const ready = await OBR.scene.isReady();
  if (!ready) {
    mappingList.innerHTML = `<p class="hint">Waiting for a scene to be open…</p>`;
    return;
  }

  if (!itemChangeListenerAttached) {
    itemChangeListenerAttached = true;
    OBR.scene.items.onChange(() => {
      renderMappings();
    });
  }

  let items: Item[];
  let mappings: Mapping[];
  try {
    [items, mappings] = await Promise.all([
      OBR.scene.items.getItems(),
      getMappings(),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dicecloud-sync] failed to load scene items/mappings:", err);
    mappingList.innerHTML = `<p class="hint" style="color:#c0392b;">Couldn't load scene data: ${escapeHtml(message)}</p>`;
    return;
  }

  // Diagnostic logging: filter the browser console to "dicecloud-sync" to
  // see exactly what Owlbear returned, whether or not the Forge-unit
  // filter below matches anything.
  console.log(`[dicecloud-sync] scene has ${items.length} item(s) total`);
  for (const item of items) {
    console.log(
      `[dicecloud-sync] item "${item.name}" (${item.id}) metadata keys:`,
      Object.keys(item.metadata)
    );
  }

  const forgeItems = items.filter((item: Item) => isForgeUnit(item.metadata));
  console.log(`[dicecloud-sync] ${forgeItems.length} item(s) matched isForgeUnit()`);

  if (forgeItems.length === 0) {
    const itemSummary = items
      .map((i) => `${escapeHtml(i.name)} [${Object.keys(i.metadata).join(", ") || "no metadata"}]`)
      .join("<br/>");
    mappingList.innerHTML = `
      <p class="hint">No Forge units found in this scene yet.</p>
      <p class="hint" style="opacity:0.7;">Saw ${items.length} scene item(s):<br/>${itemSummary || "(none)"}</p>
    `;
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
  // Covers both "no scene yet, one opens later" and "scene changes" — the
  // onChange listener itself only gets attached (once) inside
  // renderMappings, after we know a scene actually exists.
  OBR.scene.onReadyChange(() => {
    renderMappings();
  });
});
