// Owlbear puts a tool's options bar at the top centre of the screen, where the combat strip and
// the clock sit. With the plain move tool (no options bar) they sit at the very top; with any
// other tool they drop just below the bar, and come back up when the move tool is picked again.
import OBR from "@owlbear-rodeo/sdk";

const MOVE_TOOL = "rodeo.owlbear.tool/move";
export const TOP_CLEAR = 6;
export const TOP_BELOW_BAR = 66;
let top = TOP_CLEAR;
const listeners = new Set<() => void>();
let started = false;

export function topOffset() {
  return top;
}
export function onTopChange(cb: () => void) {
  listeners.add(cb);
  void start();
}
async function start() {
  if (started) return;
  started = true;
  const set = (tool: string) => {
    const next = !tool || tool === MOVE_TOOL ? TOP_CLEAR : TOP_BELOW_BAR;
    if (next === top) return;
    top = next;
    listeners.forEach((cb) => cb());
  };
  try {
    set(await OBR.tool.getActiveTool());
    OBR.tool.onToolChange(set);
  } catch (err) {
    console.warn("[abelon] can't follow the active tool:", err);
  }
}
