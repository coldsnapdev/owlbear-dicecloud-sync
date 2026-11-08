// Runs on every client. When a scene opens, players see black until the GM reveals it; the
// reveal plays the scene's title card over the black, then the map fades in behind it.
// The GM never sees the veil: the DM Panel button carries a dot while players are held.
//
// Which scene is revealed lives in the room. A scene switch, or reopening a scene in a later
// session, always starts on black; a refresh or a late joiner mid-scene doesn't.
import OBR from "@owlbear-rodeo/sdk";
import { BUILD } from "./build";
import { CARD_KEY, subtitleFor, type CardMeta } from "./cardShared";
import { playCard } from "./cardHost";
import { CLOCK_KEY, validClock } from "./clock";
import { hideAgain, REVEALED_KEY, SCENE_ID_KEY, VEIL_HELLO, VEIL_ID, VEIL_LIFT, VEIL_OFF_KEY, type Revealed, type VeilMsg } from "./veilShared";

const STALE = 6 * 3600e3; // a reveal older than this belongs to an earlier session
const LAST = "abelon.veil.last";
const CARD_MS = 6200; // the overlay's card, then the black lifting under it
const FADE_MS = 1400;

let gm = false;
let modal = false; // the overlay exists (it may be fading)
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let lastMsg: VeilMsg = { show: true };
let needFresh = false; // this scene was switched to: only a reveal made after it loaded counts
let atLoad: number | undefined;
let wasClear: boolean | undefined;

const getLast = () => {
  try {
    return sessionStorage.getItem(LAST);
  } catch {
    return null;
  }
};
const setLast = (id: string) => {
  try {
    sessionStorage.setItem(LAST, id);
  } catch { /* no storage */ }
};

async function send(m: VeilMsg) {
  lastMsg = m;
  await OBR.broadcast.sendMessage(VEIL_LIFT, m, { destination: "LOCAL" });
}

async function cover() {
  if (gm) return;
  clearTimeout(closeTimer);
  if (modal) return send({ show: true });
  modal = true;
  lastMsg = { show: true };
  await OBR.modal.open({
    id: VEIL_ID,
    url: new URL(`veil.html?v=${BUILD}`, location.href).href,
    fullScreen: true,
    hideBackdrop: true,
    hidePaper: true,
    disablePointerEvents: false, // nothing to click on a black screen
  });
}

async function uncover(card?: { title: string; sub: string }) {
  if (!modal) return;
  await send({ show: false, title: card?.title, sub: card?.sub });
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    modal = false;
    void OBR.modal.close(VEIL_ID);
  }, card ? CARD_MS : FADE_MS);
}

async function badge(held: boolean) {
  if (!gm) return;
  try {
    if (held) {
      await OBR.action.setBadgeText("●");
      await OBR.action.setBadgeBackgroundColor("#c9a25e");
      await OBR.action.setTitle("DM Panel · players see black");
    } else {
      await OBR.action.setBadgeText(undefined);
      await OBR.action.setTitle("DM Panel");
    }
  } catch { /* older Owlbear */ }
}

async function cardFor(): Promise<{ title: string; sub: string } | undefined> {
  const c = (await OBR.scene.getMetadata())[CARD_KEY] as CardMeta | undefined;
  if (!c?.title?.trim()) return undefined;
  const clock = (await OBR.room.getMetadata())[CLOCK_KEY];
  return { title: c.title.trim(), sub: await subtitleFor(c, validClock(clock) ? clock : undefined) };
}

/** a scene has just loaded on this client */
async function loaded() {
  wasClear = undefined;
  let scene = await OBR.scene.getMetadata();
  let id = scene[SCENE_ID_KEY] as string | undefined;
  if (!id && gm) {
    id = crypto.randomUUID();
    await OBR.scene.setMetadata({ [SCENE_ID_KEY]: id });
    scene = await OBR.scene.getMetadata();
  }
  const r = (await OBR.room.getMetadata())[REVEALED_KEY] as Revealed | undefined;
  const prev = getLast();
  const switched = !!prev && !!id && prev !== id;
  const stale = !!r && Date.now() - r.at > STALE;
  needFresh = switched || (!prev && stale);
  atLoad = r?.at;
  if (id) setLast(id);
  if (gm && needFresh && id && r?.scene === id) await hideAgain();
  await evaluate();
}

async function evaluate() {
  if (!(await OBR.scene.isReady())) {
    wasClear = undefined;
    await badge(false);
    return cover();
  }
  const [scene, room] = await Promise.all([OBR.scene.getMetadata(), OBR.room.getMetadata()]);
  const id = scene[SCENE_ID_KEY] as string | undefined;
  if (id && !getLast()) setLast(id);
  const applies = !scene[VEIL_OFF_KEY];
  const r = room[REVEALED_KEY] as Revealed | undefined;
  let revealed = !!id && r?.scene === id;
  if (revealed && needFresh) {
    if (r!.at !== atLoad) needFresh = false;
    else revealed = false;
  }
  const clear = !applies || revealed;
  await badge(!clear);
  const justRevealed = wasClear === false && clear && applies;
  wasClear = clear;
  if (!clear) return cover();
  if (justRevealed) {
    if (gm) return playCard();
    return uncover(await cardFor());
  }
  return uncover();
}

let started = false;
export async function startVeilHost() {
  if (started) return;
  started = true;
  gm = (await OBR.player.getRole()) === "GM";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void evaluate().catch(() => {}), 60);
  };
  OBR.broadcast.onMessage(VEIL_HELLO, () => void OBR.broadcast.sendMessage(VEIL_LIFT, lastMsg, { destination: "LOCAL" }));
  OBR.room.onMetadataChange(soon);
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    OBR.scene.onMetadataChange(soon);
  };
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      listen();
      void loaded().catch(() => {});
    }
    else void evaluate().catch(() => {});
  });
  if (await OBR.scene.isReady()) {
    listen();
    await loaded();
  }
  else await evaluate();
}
