import { LINK_STATUS_KEY, LIVE_STATUS_KEY, RELAY_STATUS_KEY, listenLocal, type LinkEnvelope, type LiveCombatant, type LiveMessage, type OwlbearMessage, liveCode, liveTopic, subscribeLive, type LiveSubscription } from "./live";
import OBR from "@owlbear-rodeo/sdk";
import { diceCloudLogin, fetchCreatureStats, fetchCompanionStats, type DiceCloudSession } from "./dicecloud";
import { writeForgeStats, getCombatRoster } from "./forge";
import { getStoredCredentials, reconcileMappings, type Mapping } from "./config";
import { getGitHubToken, rosterFingerprint, saveRoster, toRosterEntries, pollStatuses, pollCommands, type StatusFile, type PanelCommand } from "./mailbox";
import { buildLabel, buildShape, type Item } from "@owlbear-rodeo/sdk";
import { statusDef, tokenText, CUSTOM_COLOUR } from "./statuses";
import { DICE_CHANNEL, DICE_SHOW_MS, type ShownRoll } from "./diceTypes";

// How often to re-check DiceCloud. A few seconds is plenty for HP/AC
// tracking and stays well clear of anything that could look like abuse of
// an unofficial endpoint.
const POLL_INTERVAL_MS = 8000;

let session: DiceCloudSession | undefined;
// itemId (NOT creatureId) -> last-seen values, so we only write to Owlbear
// when something actually changed. This must be keyed by the token, not the
// DiceCloud character: a character's stats can be "unchanged since last
// poll" while a *different, freshly-appeared token* for that same character
// (a new scene, auto-attached by name) has never had Forge metadata written
// to it at all — keying by creatureId caused exactly that case to be
// silently skipped forever, since the fingerprint looked identical.
const lastSeen = new Map<string, string>();

// --- Combat mailbox -----------------------------------------------------------
// Whenever Forge's combat list changes (someone joins/leaves, or an initiative
// is set), save the roster to the mailbox file on GitHub so the standalone DM
// panel can fetch it with "Update Roster". HP is deliberately not part of the
// fingerprint, so damage during a fight doesn't trigger saves. Only the GM's
// browser — the one holding a GitHub token — ever writes. See mailbox.ts.
const ROSTER_SAVE_DELAY_MS = 3000;
let lastSavedRoster: string | undefined;
let rosterTimer: ReturnType<typeof setTimeout> | undefined;
let isGM: boolean | undefined;

async function checkRoster() {
  try {
    if (isGM === undefined) isGM = (await OBR.player.getRole()) === "GM";
    if (!isGM || !getGitHubToken()) return;
    const entries = toRosterEntries(getCombatRoster(await OBR.scene.items.getItems()));
    const fingerprint = rosterFingerprint(entries);
    if (fingerprint === lastSavedRoster) return;
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(async () => {
      try {
        await saveRoster(entries);
        lastSavedRoster = fingerprint;
        log(`Combat roster saved to the mailbox (${entries.length} combatant(s)).`);
      } catch (err) {
        log("Couldn't save the combat roster:", err);
      }
    }, ROSTER_SAVE_DELAY_MS);
  } catch (err) {
    // Scene not ready yet, or items briefly unavailable mid-scene-change.
    log("Couldn't read the combat roster this cycle:", err);
  }
}

// --- Statuses ---------------------------------------------------------------------
// The DM panel writes statuses.json; the GM's Owlbear tab polls it and draws one
// label per status under each token, as an attachment (moves with the token, is
// deleted with it). DM-only statuses are hidden items, which only the GM sees.
// Our own markers carry MARKER_KEY so we never touch anyone else's items.
const STATUS_POLL_MS = 2000; // also how quickly panel rolls reach the table (unchanged polls cost nothing)
const MARKER_KEY = "com.abelon.status/marker";
// Bump when the label look changes, so labels already on tokens get redrawn.
const LABEL_STYLE = 6;
let statusEtag: string | undefined;
let statusFile: StatusFile | undefined;
let statusBusy = false;

interface MarkerMeta { parent: string; sig: string }

// one redraw at a time: the relay and the GitHub poll can both ask for one at once, and
// two overlapping redraws would each add the same labels
let statusDraw: Promise<void> = Promise.resolve();
function reconcileStatuses(): Promise<void> {
  statusDraw = statusDraw.catch(() => {}).then(drawStatuses);
  return statusDraw;
}

async function drawStatuses() {
  if (!statusFile) return;
  const items = await OBR.scene.items.getItems();
  const byId = new Map(items.map((i) => [i.id, i]));
  const existing = items.filter((i) => i.metadata[MARKER_KEY]);
  const dpi = await OBR.scene.grid.getDpi();
  const fontSize = Math.round(dpi * 0.08);
  const padding = Math.round(fontSize * 0.35);
  const row = fontSize * 1.25 + padding * 2 + Math.round(dpi * 0.02);

  const wanted: { parent: string; sig: string; build: () => Promise<Item> }[] = [];
  for (const [parentId, list] of Object.entries(statusFile.tokens)) {
    const parent = byId.get(parentId);
    if (!parent || !list?.length) continue;
    const scaleSig = `${parent.scale.x.toFixed(3)},${parent.scale.y.toFixed(3)}`;
    list.forEach((st, i) => {
      const text = tokenText(st);
      const colour = st.key.startsWith("custom:") ? CUSTOM_COLOUR : statusDef(st.key)?.colour ?? CUSTOM_COLOUR;
      const sig = JSON.stringify([LABEL_STYLE, text, colour, !!st.dmOnly, i, dpi, scaleSig]);
      wanted.push({
        parent: parentId,
        sig,
        build: async () => {
          const b = await OBR.scene.items.getItemBounds([parentId]);
          return buildLabel()
            .plainText(text)
            .fontSize(fontSize)
            .fontWeight(600)
            .padding(padding)
            .fillColor("#f4ead6")
            .backgroundColor(colour)
            .backgroundOpacity(0.9)
            .cornerRadius(Math.round(padding * 1.4))
            .pointerWidth(0)
            .pointerHeight(0)
            .pointerDirection("UP")
            .position({ x: b.center.x, y: b.max.y + Math.round(dpi * 0.1) + i * row }) // clears the name plate
            .attachedTo(parentId)
            .layer("ATTACHMENT")
            .locked(true)
            .disableHit(true)
            .visible(!st.dmOnly)
            .disableAttachmentBehavior(["SCALE", "ROTATION", "COPY"])
            .metadata({ [MARKER_KEY]: { parent: parentId, sig } satisfies MarkerMeta })
            .build();
        },
      });
    });
  }

  const keep = new Set<string>();
  const toAdd: typeof wanted = [];
  for (const w of wanted) {
    const match = existing.find((e) => {
      const m = e.metadata[MARKER_KEY] as MarkerMeta;
      return !keep.has(e.id) && m.parent === w.parent && m.sig === w.sig;
    });
    if (match) keep.add(match.id);
    else toAdd.push(w);
  }
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length) await OBR.scene.items.deleteItems(toDelete);
  if (toAdd.length) await OBR.scene.items.addItems(await Promise.all(toAdd.map((w) => w.build())));
  if (toDelete.length || toAdd.length) log(`Statuses: ${toAdd.length} added, ${toDelete.length} removed.`);
}

// --- Commands from the panel ----------------------------------------------------------
// "Apply stat block": writes the bestiary entry's Forge stats onto the token and resets
// HP to full. Forge's own combat keys (name, init, on-list) are left alone, so the token
// keeps its visible name and its place in the fight.
const DONE_KEY = "dicecloud-sync/commands-done";
const COMMAND_MAX_AGE_MS = 15 * 60 * 1000;
let commandEtag: string | undefined;
const doneCommands = new Set<string>(JSON.parse(localStorage.getItem(DONE_KEY) || "[]") as string[]);

async function runCommand(cmd: PanelCommand) {
  if (cmd.kind === "show-roll") {
    if (Date.now() - new Date(cmd.at).getTime() > 30_000) return; // a roll that's late is a roll nobody wants
    await OBR.broadcast.sendMessage(DICE_CHANNEL, cmd.roll, { destination: cmd.roll.private ? "LOCAL" : "ALL" });
    return;
  }
  if (cmd.kind !== "apply-statblock") return;
  const exists = (await OBR.scene.items.getItems([cmd.itemId])).length > 0;
  if (!exists) {
    log(`Apply stat block: token ${cmd.itemId} isn't in this scene.`);
    return;
  }
  const keep = new Set(["com.battle-system.forge/name", "com.battle-system.forge/init", "com.battle-system.forge/on-list"]);
  const stringy = new Set(["Z005", "Z006", "Z007", "Z042"]);
  await OBR.scene.items.updateItems([cmd.itemId], (items) => {
    for (const item of items) {
      for (const [k, v] of Object.entries(cmd.forge)) {
        if (!k.startsWith("com.battle-system.forge/") || keep.has(k)) continue;
        const short = k.split("/")[1];
        item.metadata[k] = stringy.has(short) && v !== "" && v != null ? String(v) : v;
      }
      const max = cmd.forge["com.battle-system.forge/Z006"];
      if (max !== undefined) item.metadata["com.battle-system.forge/Z005"] = String(max); // full HP
      item.metadata["com.battle-system.forge/Z042"] = "0"; // no temp HP
    }
  });
  log(`Applied ${cmd.entryName} to token ${cmd.itemId}.`);
}

// the live channel (see live.ts): rolls arrive here within a fraction of a second; the
// GitHub copy of the same command turns up a few seconds later and is skipped as done
let live: LiveSubscription | undefined;
function liveStatus(state: string, topic?: string) {
  localStorage.setItem(LIVE_STATUS_KEY, JSON.stringify({ state, code: topic ? liveCode(topic) : "", at: Date.now() }));
}
async function ensureLive(token: string | undefined) {
  const topic = token ? await liveTopic(token) : undefined;
  if (live?.topic === topic) return;
  live?.close();
  live = undefined;
  if (!topic) return liveStatus("off");
  live = subscribeLive(
    topic,
    (cmd) => {
      if (cmd.kind !== "show-roll" || doneCommands.has(cmd.id)) return; // stat blocks stay on GitHub
      doneCommands.add(cmd.id);
      runCommand(cmd).catch((err) => log("Live roll failed:", err));
    },
    (state) => liveStatus(state, topic),
  );
}

// the local relay (abelon-relay.js on the GM's computer): the fastest route, for rolls,
// stat blocks and statuses alike. Runs whether or not the relay is up; it just retries.
let relay: { close(): void } | undefined;
function relayState(state: string) {
  localStorage.setItem(RELAY_STATUS_KEY, JSON.stringify({ state, at: Date.now() }));
}
function startRelay() {
  if (relay) return;
  relay = listenLocal("owlbear", handleLiveMessage, relayState);
}

// messages from the panel, by whichever fast route they came (relay or direct link)
function handleLiveMessage(msg: LiveMessage) {
  if (msg.kind === "statuses") {
    if (!statusFile?.savedAt || !msg.file.savedAt || msg.file.savedAt >= statusFile.savedAt) {
      statusFile = msg.file;
      reconcileStatuses().catch((err) => log("Couldn't draw statuses:", err));
    }
    return;
  }
  if (msg.kind === "targets") {
    targetIds = msg.ids;
    reconcileTargets().catch((err) => log("Couldn't draw targets:", err));
    return;
  }
  if (doneCommands.has(msg.id)) return;
  doneCommands.add(msg.id);
  runCommand(msg).catch((err) => log("Panel command failed:", err));
}

// --- Targets: a dashed ring round each token the DM is aiming at, seen by everyone --------
const TARGET_KEY = "com.abelon.target/ring";
let targetIds: string[] = [];
let targetDraw: Promise<void> = Promise.resolve();
function reconcileTargets(): Promise<void> {
  targetDraw = targetDraw.catch(() => {}).then(drawTargets);
  return targetDraw;
}
async function drawTargets() {
  if (!(await OBR.scene.isReady())) return;
  const items = await OBR.scene.items.getItems();
  const present = new Set(items.map((i) => i.id));
  const rings = items.filter((i) => i.metadata[TARGET_KEY]);
  const want = new Set(targetIds.filter((id) => present.has(id)));
  const stale = rings.filter((r) => !want.has((r.metadata[TARGET_KEY] as { parent: string }).parent)).map((r) => r.id);
  const have = new Set(rings.map((r) => (r.metadata[TARGET_KEY] as { parent: string }).parent));
  const dpi = await OBR.scene.grid.getDpi();
  const add: Item[] = [];
  for (const id of want) {
    if (have.has(id)) continue;
    const b = await OBR.scene.items.getItemBounds([id]);
    const size = Math.max(b.width, b.height) * 1.18;
    add.push(
      buildShape()
        .shapeType("CIRCLE")
        .width(size)
        .height(size)
        .position(b.center)
        .fillOpacity(0)
        .strokeColor("#e0533d")
        .strokeOpacity(0.95)
        .strokeWidth(Math.max(3, Math.round(dpi * 0.045)))
        .strokeDash([Math.round(dpi * 0.14), Math.round(dpi * 0.07)])
        .attachedTo(id)
        .layer("ATTACHMENT")
        .locked(true)
        .disableHit(true)
        .disableAttachmentBehavior(["ROTATION", "COPY"])
        .metadata({ [TARGET_KEY]: { parent: id } })
        .build(),
    );
  }
  if (stale.length) await OBR.scene.items.deleteItems(stale);
  if (add.length) await OBR.scene.items.addItems(add);
}

// --- Owlbear → panel: the live roster (with HP) and the GM's selection -----------------
function sendToPanel(m: OwlbearMessage) {
  try {
    if (panelWindow && !panelWindow.closed) panelWindow.postMessage({ abelon: "owlbear-msg", ref: "", fromOwlbear: m } satisfies LinkEnvelope, location.origin);
  } catch {
    panelWindow = undefined;
  }
}
let lastRosterSent = "";
async function pushRoster(force = false) {
  if (!panelWindow || !(await OBR.scene.isReady())) return;
  const items = await OBR.scene.items.getItems();
  const combatants: LiveCombatant[] = getCombatRoster(items).map((c) => ({
    itemId: c.itemId, name: c.name, realName: c.realName, initiative: c.initiative,
    ac: c.ac, hp: c.currentHP, maxHp: c.maxHP, tempHp: c.tempHP,
  }));
  const forgeInfo = await forgeDiagnostics(items);
  const fp = JSON.stringify([combatants, forgeInfo]);
  if (!force && fp === lastRosterSent) return;
  lastRosterSent = fp;
  sendToPanel({ kind: "roster", combatants, forgeInfo });
}
// What Forge stores beyond the stat keys (looking for where it keeps whose turn it is)
async function forgeDiagnostics(items: Item[]): Promise<string> {
  const short = (v: unknown) => JSON.stringify(v)?.slice(0, 80);
  const scene = Object.entries(await OBR.scene.getMetadata()).filter(([k]) => /forge|battle/i.test(k)).map(([k, v]) => `scene ${k} = ${short(v)}`);
  const room = Object.entries(await OBR.room.getMetadata()).filter(([k]) => /forge|battle/i.test(k)).map(([k, v]) => `room ${k} = ${short(v)}`);
  const itemKeys = new Set<string>();
  for (const i of items) for (const k of Object.keys(i.metadata)) if (/forge|battle/i.test(k) && !/\/Z0\d\d$/.test(k)) itemKeys.add(`${k} = ${short(i.metadata[k])}`);
  return [...scene, ...room, ...[...itemKeys].slice(0, 25)].join("\n");
}
let selectionListening = false;
function listenSelection() {
  if (selectionListening) return;
  selectionListening = true;
  let last = "";
  OBR.player.onChange((p) => {
    const ids = p.selection ?? [];
    const key = ids.join(",");
    if (key === last) return;
    last = key;
    sendToPanel({ kind: "selection", ids });
  });
}

// the direct link: a panel opened from this extension's link posts straight to this page
let linkListening = false;
let panelWindow: Window | undefined;
function startDirectLink() {
  if (linkListening) return;
  linkListening = true;
  // keep saying hello to the panel we've heard from: a panel that reloads has lost its
  // handle on this tab, and this hands it back
  setInterval(() => {
    try {
      if (panelWindow && !panelWindow.closed) panelWindow.postMessage({ abelon: "hello", ref: "" } satisfies LinkEnvelope, location.origin);
    } catch {
      panelWindow = undefined;
    }
  }, 2000);
  window.addEventListener("message", (e) => {
    const d = e.data as LinkEnvelope;
    if (e.origin !== location.origin || d?.abelon !== "panel-msg" || !d.msg) return;
    const fresh = e.source !== panelWindow;
    panelWindow = (e.source as Window | null) ?? panelWindow;
    if (fresh) {
      listenSelection();
      pushRoster(true).catch(() => {});
      reconcileTargets().catch(() => {});
    }
    panelWindow?.postMessage({ abelon: "ack", ref: d.ref } satisfies LinkEnvelope, location.origin);
    localStorage.setItem(LINK_STATUS_KEY, JSON.stringify({ state: "linked", at: Date.now() }));
    if (d.msg.kind === "ping") return;
    handleLiveMessage(d.msg);
  });
}

async function pollCommandFile(token: string) {
  const res = await pollCommands(token, commandEtag);
  if (!res) return;
  commandEtag = res.etag;
  for (const cmd of res.file.commands ?? []) {
    if (doneCommands.has(cmd.id)) continue;
    doneCommands.add(cmd.id);
    if (Date.now() - new Date(cmd.at).getTime() > COMMAND_MAX_AGE_MS) continue; // stale, never replay
    try {
      await runCommand(cmd);
    } catch (err) {
      log("Command failed:", err);
    }
  }
  localStorage.setItem(DONE_KEY, JSON.stringify([...doneCommands].slice(-100)));
}

async function pollStatusFile() {
  if (statusBusy) return;
  statusBusy = true;
  try {
    if (isGM === undefined) isGM = (await OBR.player.getRole()) === "GM";
    if (isGM) {
      startRelay();
      startDirectLink();
    }
    const token = getGitHubToken();
    await ensureLive(isGM ? token : undefined);
    if (!isGM || !token) return;
    await pollCommandFile(token).catch((err) => log("Couldn't read panel commands:", err));
    const res = await pollStatuses(token, statusEtag);
    if (res) {
      // a live copy from the relay may already be newer than what GitHub has caught up to
      if (!statusFile?.savedAt || !res.file.savedAt || res.file.savedAt >= statusFile.savedAt) statusFile = res.file;
      statusEtag = res.etag;
    }
    await reconcileStatuses();
  } catch (err) {
    log("Couldn't update statuses this cycle:", err);
  } finally {
    statusBusy = false;
  }
}

let statusHandle: ReturnType<typeof setInterval> | undefined;
function startStatusPolling() {
  if (statusHandle) return;
  pollStatusFile();
  statusHandle = setInterval(pollStatusFile, STATUS_POLL_MS);
}
function stopStatusPolling() {
  ensureLive(undefined);
  if (statusHandle) clearInterval(statusHandle);
  statusHandle = undefined;
}

// --- Dice tray (runs for every player) ------------------------------------------------
// Each client shows rolls it's sent as a transparent popover over the map, one at a time.
const DICE_POPOVER = "com.abelon.dice/tray";
const diceQueue: ShownRoll[] = [];
let diceBusy = false;
async function showNextRoll() {
  if (diceBusy) return;
  const roll = diceQueue.shift();
  if (!roll) return;
  diceBusy = true;
  try {
    const [w, h] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
    const width = Math.min(640, Math.round(w * 0.9));
    const height = Math.round(width * 0.62);
    await OBR.popover.open({
      id: DICE_POPOVER,
      url: `${new URL("dice.html", location.href).href}#${encodeURIComponent(JSON.stringify(roll))}`,
      width,
      height,
      anchorReference: "POSITION",
      anchorPosition: { left: Math.round(w / 2), top: Math.round(h * 0.58) },
      anchorOrigin: { horizontal: "CENTER", vertical: "CENTER" },
      transformOrigin: { horizontal: "CENTER", vertical: "CENTER" },
      hidePaper: true,
      marginThreshold: 0,
    });
    await new Promise((r) => setTimeout(r, DICE_SHOW_MS));
    await OBR.popover.close(DICE_POPOVER);
  } catch (err) {
    log("Couldn't show dice:", err);
  } finally {
    diceBusy = false;
    if (diceQueue.length) setTimeout(showNextRoll, 150);
  }
}
function listenForDice() {
  OBR.broadcast.onMessage(DICE_CHANNEL, (event) => {
    diceQueue.push(event.data as ShownRoll);
    diceQueue.splice(0, Math.max(0, diceQueue.length - 3)); // never fall far behind the fight
    showNextRoll();
  });
}

function log(...args: unknown[]) {
  console.log("[dicecloud-sync]", ...args);
}

async function ensureSession(): Promise<DiceCloudSession | undefined> {
  if (session && new Date(session.tokenExpires).getTime() > Date.now() + 60_000) {
    return session;
  }
  const creds = getStoredCredentials();
  if (!creds) {
    log("No DiceCloud credentials configured yet — open the extension popover to set them up.");
    return undefined;
  }
  try {
    session = await diceCloudLogin(creds.usernameOrEmail, creds.password);
    log("Logged in to DiceCloud as", session.userId);
    return session;
  } catch (err) {
    log("DiceCloud login failed:", err);
    session = undefined;
    return undefined;
  }
}

async function syncOnce() {
  let mappings: Mapping[];
  try {
    // Auto-attach any token in this scene whose name matches a character we
    // already know from another scene, before syncing — this is what makes
    // the party's tokens "just work" after a scene change.
    const items = await OBR.scene.items.getItems();
    mappings = await reconcileMappings(items);
  } catch (err) {
    log("Couldn't reconcile mappings this cycle (scene not ready?):", err);
    return;
  }
  if (mappings.length === 0) return;

  const activeSession = await ensureSession();

  for (const mapping of mappings) {
    try {
      const stats = mapping.companion
        ? await fetchCompanionStats(mapping.creatureId, activeSession?.token)
        : await fetchCreatureStats(mapping.creatureId, activeSession?.token);
      const fingerprint = `${stats.currentHP}|${stats.maxHP}|${stats.ac}|${stats.tempHP}`;

      if (lastSeen.get(mapping.itemId) === fingerprint) {
        continue; // nothing changed since last poll for this specific token
      }

      await writeForgeStats(mapping.itemId, stats);
      lastSeen.set(mapping.itemId, fingerprint);
      log(
        `Updated ${mapping.itemName}: HP ${stats.currentHP}/${stats.maxHP}, AC ${stats.ac}` +
          (stats.tempHP ? `, temp HP ${stats.tempHP}` : "")
      );
    } catch (err) {
      // One character failing (deleted token, sheet temporarily
      // unreachable, etc.) shouldn't stop the rest of the party from
      // syncing.
      log(`Failed to sync ${mapping.itemName ?? mapping.itemId}:`, err);
    }
  }
}

let pollHandle: ReturnType<typeof setInterval> | undefined;

function startPolling() {
  if (pollHandle) return;
  log(`Starting sync loop (every ${POLL_INTERVAL_MS / 1000}s).`);
  syncOnce();
  pollHandle = setInterval(syncOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!pollHandle) return;
  clearInterval(pollHandle);
  pollHandle = undefined;
  log("Scene closed — sync loop paused.");
}

let itemChangeListenerAttached = false;

function attachItemChangeListener() {
  // Scene APIs (including registering this listener) throw if called
  // before a scene is actually open — only ever call this once isReady()
  // is confirmed true, same guard popover.ts uses for the same reason.
  if (itemChangeListenerAttached) return;
  itemChangeListenerAttached = true;
  OBR.scene.items.onChange(() => {
    checkRoster();
    pushRoster().catch(() => {});
  });
}

OBR.onReady(async () => {
  log("Extension background ready.");
  listenForDice();

  if (await OBR.scene.isReady()) {
    startPolling();
    startStatusPolling();
    attachItemChangeListener();
    checkRoster();
  }

  OBR.scene.onReadyChange((isReady) => {
    if (isReady) {
      startPolling();
      startStatusPolling();
      attachItemChangeListener();
      checkRoster();
    } else {
      stopPolling();
      stopStatusPolling();
    }
  });
});
