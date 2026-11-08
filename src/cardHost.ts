// A scene's title card plays when the GM reveals the scene (see veilHost), or as it loads for a
// scene that opens without the black screen. Someone joining a scene already revealed sees it
// once too. The GM can also play it again for everyone from the popover.
import OBR from "@owlbear-rodeo/sdk";
import { BUILD } from "./build";
import { CARD_CHANNEL, CARD_ID, CARD_KEY, subtitleFor, type CardMeta } from "./cardShared";
import { CLOCK_KEY, validClock } from "./clock";
import { isClear, VEIL_OFF_KEY, veilState } from "./veilShared";

export async function playCard(c?: CardMeta) {
  const card = c ?? ((await OBR.scene.getMetadata())[CARD_KEY] as CardMeta | undefined);
  if (!card?.title?.trim()) return;
  const clock = (await OBR.room.getMetadata())[CLOCK_KEY];
  const sub = await subtitleFor(card, validClock(clock) ? clock : undefined);
  await OBR.modal.open({
    id: CARD_ID,
    url: new URL(`card.html?v=${BUILD}&t=${encodeURIComponent(card.title.trim())}&s=${encodeURIComponent(sub)}`, location.href).href,
    fullScreen: true,
    hideBackdrop: true,
    hidePaper: true,
    disablePointerEvents: true,
  });
}

let started = false;
export async function startCardHost() {
  if (started) return;
  started = true;
  OBR.broadcast.onMessage(CARD_CHANNEL, (ev) => void playCard(ev.data as CardMeta | undefined));
  OBR.scene.onReadyChange(async (ready) => {
    if (ready && (await OBR.scene.getMetadata())[VEIL_OFF_KEY]) setTimeout(() => void playCard(), 400);
  });
  let first = true;
  try {
    first = !sessionStorage.getItem("abelon.card.started");
    sessionStorage.setItem("abelon.card.started", "1");
  } catch { /* treat as first */ }
  if (first && (await OBR.scene.isReady()) && isClear(await veilState())) setTimeout(() => void playCard(), 400);
}
