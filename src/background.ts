import OBR from "@owlbear-rodeo/sdk";
import { diceCloudLogin, fetchCreatureStats, fetchCompanionStats, type DiceCloudSession } from "./dicecloud";
import { writeForgeStats, getCombatRoster } from "./forge";
import { getStoredCredentials, reconcileMappings, type Mapping } from "./config";
import { getGitHubToken, rosterFingerprint, saveRoster, toRosterEntries } from "./mailbox";

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
  });
}

OBR.onReady(async () => {
  log("Extension background ready.");

  if (await OBR.scene.isReady()) {
    startPolling();
    attachItemChangeListener();
    checkRoster();
  }

  OBR.scene.onReadyChange((isReady) => {
    if (isReady) {
      startPolling();
      attachItemChangeListener();
      checkRoster();
    } else {
      stopPolling();
    }
  });
});
