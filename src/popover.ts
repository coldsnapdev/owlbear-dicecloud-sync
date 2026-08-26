import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { diceCloudLogin, fetchCreatureStats, parseCreatureId, type DiceCloudSession } from "./dicecloud";
import { isForgeUnit, readForgeStats } from "./forge";
import {
  getCharacterLinks,
  getStoredCredentials,
  ignoreItemName,
  isNameIgnored,
  reconcileMappings,
  removeMapping,
  setStoredCredentials,
  unignoreItemName,
  upsertMapping,
  type CharacterLink,
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
      it from. A saved link is remembered by token name, so it reattaches
      automatically next time that name shows up in any scene.
    </p>
    <div id="mapping-list">Loading tokens…</div>
    <div id="ignored-list"></div>
    <div id="debug-list"></div>
  </section>

  <p class="hint" style="opacity:0.5;">build 10 — always-on scene item debug list</p>
`;

const usernameInput = document.getElementById("username") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const credsStatus = document.getElementById("creds-status")!;
const mappingList = document.getElementById("mapping-list")!;
const ignoredList = document.getElementById("ignored-list")!;
const debugList = document.getElementById("debug-list")!;

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
    cachedSession = await diceCloudLogin(usernameOrEmail, password);
    setStoredCredentials({ usernameOrEmail, password });
    credsStatus.textContent = "✓ Logged in and saved.";
    credsStatus.className = "status ok";
  } catch (err) {
    console.error("[dicecloud-sync] credentials test failed:", err);
    credsStatus.textContent = err instanceof Error
      ? `Login request failed: ${err.message}`
      : "Login failed.";
    credsStatus.className = "status error";
  }
});

// Cache the DiceCloud session instead of re-hitting POST /api/login on every
// Save click / row render — besides being wasteful, doing that repeatedly in
// quick succession is a plausible way to trip a rate-limit or bot-protection
// layer in front of dicecloud.com.
let cachedSession: DiceCloudSession | undefined;

async function getSession(): Promise<DiceCloudSession | undefined> {
  const creds = getStoredCredentials();
  if (!creds) return undefined;
  if (cachedSession && new Date(cachedSession.tokenExpires).getTime() > Date.now() + 60_000) {
    return cachedSession;
  }
  cachedSession = await diceCloudLogin(creds.usernameOrEmail, creds.password);
  return cachedSession;
}

let itemChangeListenerAttached = false;

async function renderMappings() {
  // Scene APIs throw if called before a scene is actually open/ready.
  const ready = await OBR.scene.isReady();
  if (!ready) {
    mappingList.innerHTML = `<p class="hint">Waiting for a scene to be open…</p>`;
    ignoredList.innerHTML = "";
    debugList.innerHTML = "";
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
  let links: CharacterLink[];
  try {
    items = await OBR.scene.items.getItems();
    // Auto-attach any token whose name we already have a DiceCloud link
    // for (from another scene), then load that reconciled list.
    [mappings, links] = await Promise.all([reconcileMappings(items), getCharacterLinks()]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dicecloud-sync] failed to load scene items/mappings:", err);
    mappingList.innerHTML = `<p class="hint" style="color:#c0392b;">Couldn't load scene data: ${escapeHtml(message)}</p>`;
    ignoredList.innerHTML = "";
    debugList.innerHTML = "";
    return;
  }

  const allForgeItems = items.filter((item: Item) => isForgeUnit(item.metadata));
  const visibleForgeItems = allForgeItems.filter((item) => !isNameIgnored(links, item.name));
  const ignoredLinks = links.filter((l) => l.ignored);

  renderIgnoredList(ignoredLinks);
  renderDebugList(items, allForgeItems);

  if (allForgeItems.length === 0) {
    mappingList.innerHTML = `<p class="hint">No Forge units found in this scene yet — see "Scene items" below to check why.</p>`;
    return;
  }

  if (visibleForgeItems.length === 0) {
    mappingList.innerHTML = `<p class="hint">All ${allForgeItems.length} Forge unit(s) in this scene are hidden — see below.</p>`;
    return;
  }

  const mappingByItem = new Map<string, Mapping>(mappings.map((m) => [m.itemId, m]));

  mappingList.innerHTML = "";
  for (const item of visibleForgeItems) {
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
        <button class="ignore-item secondary" type="button">Not connecting this</button>
        <span class="status"></span>
      </div>
    `;

    const input = row.querySelector(".creature-url") as HTMLInputElement;
    const saveButton = row.querySelector(".save-mapping") as HTMLButtonElement;
    const ignoreButton = row.querySelector(".ignore-item") as HTMLButtonElement;
    const status = row.querySelector(".status") as HTMLSpanElement;

    saveButton.addEventListener("click", async () => {
      const creatureId = parseCreatureId(input.value);
      if (!creatureId) {
        if (existing) await removeMapping(item.id, item.name);
        status.textContent = "Cleared.";
        status.className = "status";
        return;
      }

      status.textContent = "Checking…";
      status.className = "status";

      let session: DiceCloudSession | undefined;
      try {
        session = await getSession();
      } catch (err) {
        console.error("[dicecloud-sync] login (from mapping save) failed:", err);
        status.textContent = err instanceof Error
          ? `Login request failed: ${err.message}`
          : "Login request failed.";
        status.className = "status error";
        return;
      }

      try {
        const stats = await fetchCreatureStats(creatureId, session?.token);
        await upsertMapping({ itemId: item.id, itemName: item.name, creatureId });
        status.textContent = `✓ Found ${stats.name ?? "character"} — HP ${stats.currentHP}/${stats.maxHP}, AC ${stats.ac}`;
        status.className = "status ok";
      } catch (err) {
        console.error("[dicecloud-sync] fetch creature stats failed:", err);
        status.textContent = err instanceof Error
          ? `Sheet request failed: ${err.message}`
          : "Couldn't reach that sheet.";
        status.className = "status error";
      }
    });

    ignoreButton.addEventListener("click", async () => {
      await ignoreItemName(item.name);
      renderMappings();
    });

    mappingList.appendChild(row);
  }
}

function renderIgnoredList(ignoredLinks: CharacterLink[]) {
  if (ignoredLinks.length === 0) {
    ignoredList.innerHTML = "";
    return;
  }

  const rows = ignoredLinks
    .map(
      (link) => `
        <div class="hidden-row" data-name="${escapeHtml(link.itemName)}">
          <span>${escapeHtml(link.itemName)}</span>
          <button class="unignore-item secondary" type="button">Show again</button>
        </div>
      `
    )
    .join("");

  ignoredList.innerHTML = `
    <details class="hidden-tokens">
      <summary>${ignoredLinks.length} hidden token name(s) (e.g. NPCs)</summary>
      ${rows}
    </details>
  `;

  ignoredList.querySelectorAll(".unignore-item").forEach((button) => {
    button.addEventListener("click", async (e) => {
      const row = (e.currentTarget as HTMLElement).closest(".hidden-row") as HTMLElement;
      const name = row.dataset.name!;
      await unignoreItemName(name);
      renderMappings();
    });
  });
}

// Always-on (not just on error) view of exactly what's in the scene right
// now and whether Forge has put its tracking metadata on each item yet.
// Forge only writes that metadata once IT starts tracking a token in a
// given scene — a token can look completely normal on the map and still be
// invisible to us until Forge has touched it there, which is the usual
// reason "the same" token isn't found after a scene change.
function renderDebugList(items: Item[], forgeItems: Item[]) {
  const forgeIds = new Set(forgeItems.map((i) => i.id));
  const rows = items
    .map((item) => {
      const tracked = forgeIds.has(item.id);
      const stats = tracked ? readForgeStats(item.metadata) : undefined;
      const detail = tracked
        ? `Forge-tracked — HP ${stats?.currentHP ?? "–"}/${stats?.maxHP ?? "–"} · AC ${stats?.ac ?? "–"}`
        : "not Forge-tracked yet";
      return `<div class="hidden-row"><span>${escapeHtml(item.name) || "(unnamed)"}</span><span class="hint">${detail}</span></div>`;
    })
    .join("");

  debugList.innerHTML = `
    <details class="hidden-tokens">
      <summary>Scene items (${items.length}) — debug</summary>
      ${rows || `<p class="hint">No items in this scene.</p>`}
    </details>
  `;
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
