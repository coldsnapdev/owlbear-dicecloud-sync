// The on-screen clock: a small plate at the top of everyone's screen whenever no fight is on
// (the combat strip takes that spot during one). It reads the room's in-game clock.
import OBR from "@owlbear-rodeo/sdk";
import { BUILD } from "./build";
import { CLOCK_HIDE_KEY, CLOCK_KEY, validClock } from "./clock";
import { inCombat } from "./combat";
import { onTopChange, topOffset } from "./toolOffset";

const CLOCK_ID = "com.abelon.time/clock";
let open = false;
let busy = false;
let again = false;

async function update() {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    const room = await OBR.room.getMetadata();
    const show = validClock(room[CLOCK_KEY]) && !room[CLOCK_HIDE_KEY] && (await OBR.scene.isReady()) && !(await OBR.scene.items.getItems(inCombat)).length;
    if (show && !open) {
      const vw = await OBR.viewport.getWidth();
      await OBR.popover.open({
        id: CLOCK_ID,
        url: new URL(`clock.html?v=${BUILD}`, location.href).href,
        width: 250,
        height: 58,
        anchorReference: "POSITION",
        anchorPosition: { left: Math.round(vw / 2), top: topOffset() },
        anchorOrigin: { horizontal: "CENTER", vertical: "TOP" },
        transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
        hidePaper: true,
        disableClickAway: true,
      });
      open = true;
    } else if (!show && open) {
      await OBR.popover.close(CLOCK_ID);
      open = false;
    }
  } catch {
    // no scene yet
  } finally {
    busy = false;
    if (again) {
      again = false;
      void update();
    }
  }
}

let started = false;
export async function startClockHost() {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void update(), 200);
  };
  OBR.room.onMetadataChange(soon);
  onTopChange(() => {
    if (!open) return;
    open = false;
    void OBR.popover.close(CLOCK_ID).then(soon);
  });
  let listening = false;
  const hook = async () => {
    if ((await OBR.scene.isReady()) && !listening) {
      listening = true;
      OBR.scene.items.onChange(soon);
    }
    soon();
  };
  OBR.scene.onReadyChange(() => void hook());
  void hook();
}
