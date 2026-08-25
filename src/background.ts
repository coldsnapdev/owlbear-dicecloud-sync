import OBR from "@owlbear-rodeo/sdk";
import { diceCloudLogin, fetchCreatureStats, type DiceCloudSession } from "./dicecloud";
import { writeForgeStats } from "./forge";
import { getStoredCredentials, reconcileMappings, type Mapping } from "./config";

// How often to re-check DiceCloud. A few seconds is plenty for HP/AC
// tracking and stays well clear of anything that could look like abuse of
// an unofficial endpoint.
const POLL_INTERVAL_MS = 8000;

let session: DiceCloudSession | undefined;
// creatureId -> last-seen values, so we only write to Owlbear (and only
// generate a websocket frame) when something actually changed.
const lastSeen = new Map<string, string>();

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
      const stats = await fetchCreatureStats(mapping.creatureId, activeSession?.token);
      const fingerprint = `${stats.currentHP}|${stats.maxHP}|${stats.ac}`;

      if (lastSeen.get(mapping.creatureId) === fingerprint) {
        continue; // nothing changed since last poll
      }

      await writeForgeStats(mapping.itemId, stats);
      lastSeen.set(mapping.creatureId, fingerprint);
      log(
        `Updated ${mapping.itemName}: HP ${stats.currentHP}/${stats.maxHP}, AC ${stats.ac}`
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

OBR.onReady(async () => {
  log("Extension background ready.");

  if (await OBR.scene.isReady()) {
    startPolling();
  }

  OBR.scene.onReadyChange((isReady) => {
    if (isReady) {
      startPolling();
    } else {
      stopPolling();
    }
  });
});
