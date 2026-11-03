// Screen effects: each player's own screen feels their character's conditions (the Rot creeping
// in stack by stack, poison, charm, fear, exhaustion...). Runs on every client; only the
// player's own tokens count. The GM can feel the selected token's effects to try them out.
import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { BUILD } from "./build";
import { fallenOf, getState } from "./combat";
import { anyEffect, effectsFrom, FX_CHANNEL, FX_HELLO, FX_ID, FX_OFF_KEY, FX_PREVIEW_KEY, type Effects } from "./fxShared";

let open = false;
let last = "";
let current: Effects = {};
let closeTimer: ReturnType<typeof setTimeout> | undefined;

async function mine(items: Item[], gm: boolean): Promise<Item[]> {
  if (gm) {
    let preview = false;
    try {
      preview = localStorage.getItem(FX_PREVIEW_KEY) === "1";
    } catch { /* no storage */ }
    if (!preview) return [];
    const sel = new Set((await OBR.player.getSelection()) ?? []);
    return items.filter((i) => sel.has(i.id));
  }
  const me = await OBR.player.getId();
  return items.filter((i) => i.createdUserId === me);
}

async function update(gm: boolean) {
  if (!(await OBR.scene.isReady())) return apply({});
  const off = !!(await OBR.room.getMetadata())[FX_OFF_KEY];
  if (off) return apply({});
  const items = await OBR.scene.items.getItems((i) => i.layer === "CHARACTER");
  const st = await getState();
  const e: Effects = {};
  for (const it of await mine(items, gm)) effectsFrom((st.statuses?.[it.id] ?? []).map((s) => s.t), fallenOf(it), e);
  await apply(e);
}
async function apply(e: Effects) {
  const sig = JSON.stringify(e);
  if (sig === last) return;
  last = sig;
  current = e;
  if (anyEffect(e)) {
    clearTimeout(closeTimer);
    if (!open) {
      open = true;
      await OBR.modal.open({
        id: FX_ID,
        url: new URL(`fx.html?v=${BUILD}`, location.href).href,
        fullScreen: true,
        hideBackdrop: true,
        hidePaper: true,
        disablePointerEvents: true,
      });
    }
    await OBR.broadcast.sendMessage(FX_CHANNEL, e, { destination: "LOCAL" });
  } else if (open) {
    // let the effects fade before the overlay goes
    await OBR.broadcast.sendMessage(FX_CHANNEL, e, { destination: "LOCAL" });
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      open = false;
      void OBR.modal.close(FX_ID);
    }, 1800);
  }
}

let started = false;
export async function startFxHost() {
  if (started) return;
  started = true;
  const gm = (await OBR.player.getRole()) === "GM";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void update(gm).catch(() => {}), 120);
  };
  OBR.broadcast.onMessage(FX_HELLO, () => void OBR.broadcast.sendMessage(FX_CHANNEL, current, { destination: "LOCAL" }));
  OBR.room.onMetadataChange(soon);
  OBR.player.onChange(soon); // selection (GM preview)
  let listening = false;
  const hook = async () => {
    if (!(await OBR.scene.isReady())) return soon();
    if (!listening) {
      listening = true;
      OBR.scene.items.onChange(soon);
      OBR.scene.onMetadataChange(soon);
    }
    soon();
  };
  OBR.scene.onReadyChange(() => void hook());
  void hook();
}
