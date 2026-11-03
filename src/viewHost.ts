// The default view: the GM draws a box with the "Default view" tool; whenever a scene loads,
// everyone's view fits that box (by its width or its height, whichever meets the edges of
// their window first). The tool's buttons also show it, send everyone there, or clear it.
import OBR, { buildShape, type BoundingBox, type Item } from "@owlbear-rodeo/sdk";

const VIEW_KEY = "com.abelon.view/default";
const GO_CHANNEL = "com.abelon.view/go";
const TOOL = "com.abelon.view/tool";
const MODE = "com.abelon.view/draw";
const BOX_KEY = "com.abelon.view/box";
interface Rect { x: number; y: number; w: number; h: number }

const bounds = (r: Rect): BoundingBox => ({
  min: { x: r.x, y: r.y },
  max: { x: r.x + r.w, y: r.y + r.h },
  width: r.w,
  height: r.h,
  center: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
});
async function saved(): Promise<Rect | undefined> {
  const r = (await OBR.scene.getMetadata())[VIEW_KEY] as Rect | undefined;
  return r && r.w > 0 && r.h > 0 ? r : undefined;
}
async function goToDefault() {
  const r = await saved();
  if (r) await OBR.viewport.animateToBounds(bounds(r));
}

// --- Drawing the box (GM) ----------------------------------------------------------------
let start: { x: number; y: number } | undefined;
const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});
async function showBox(r?: Rect) {
  const old = await OBR.scene.local.getItems((i) => !!i.metadata[BOX_KEY]);
  if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id));
  if (!r) return;
  const dpi = await OBR.scene.grid.getDpi();
  const box: Item = buildShape()
    .shapeType("RECTANGLE")
    .position({ x: r.x, y: r.y })
    .width(r.w)
    .height(r.h)
    .fillColor("#e2c27f")
    .fillOpacity(0.08)
    .strokeColor("#e2c27f")
    .strokeOpacity(0.95)
    .strokeWidth(Math.max(3, Math.round(dpi * 0.05)))
    .strokeDash([Math.round(dpi * 0.25), Math.round(dpi * 0.12)])
    .layer("POPOVER")
    .locked(true)
    .disableHit(true)
    .metadata({ [BOX_KEY]: true })
    .build();
  await OBR.scene.local.addItems([box]);
}
let drawing: Rect | undefined;
let moveTimer: number | undefined;

async function gmTool() {
  const icon = (n: string) => new URL(`icons/${n}.svg`, location.href).href;
  await OBR.tool.create({
    id: TOOL,
    icons: [{ icon: icon("view"), label: "Default view", filter: { roles: ["GM"] } }],
    defaultMode: MODE,
  });
  await OBR.tool.createMode({
    id: MODE,
    icons: [{ icon: icon("view"), label: "Draw the default view", filter: { activeTools: [TOOL] } }],
    cursors: [{ cursor: "crosshair" }],
    onActivate: async () => showBox(await saved()),
    onDeactivate: () => void showBox(undefined),
    onToolDragStart: (_c, e) => {
      start = e.pointerPosition;
    },
    onToolDragMove: (_c, e) => {
      if (!start) return;
      drawing = rectFrom(start, e.pointerPosition);
      // redraw at most every 50ms while dragging
      if (moveTimer === undefined) moveTimer = window.setTimeout(() => {
        moveTimer = undefined;
        void showBox(drawing);
      }, 50);
    },
    onToolDragEnd: async (_c, e) => {
      if (!start) return;
      const r = rectFrom(start, e.pointerPosition);
      start = undefined;
      drawing = undefined;
      if (r.w < 20 || r.h < 20) return showBox(await saved());
      await OBR.scene.setMetadata({ [VIEW_KEY]: r });
      await showBox(r);
      await OBR.notification.show("Default view saved: everyone starts here when this scene loads.", "SUCCESS");
    },
    onToolDragCancel: async () => {
      start = undefined;
      drawing = undefined;
      await showBox(await saved());
    },
  });
  await OBR.tool.createAction({
    id: "com.abelon.view/show",
    icons: [{ icon: icon("view-go"), label: "Go to the default view", filter: { activeTools: [TOOL] } }],
    onClick: () => void goToDefault(),
  });
  await OBR.tool.createAction({
    id: "com.abelon.view/send",
    icons: [{ icon: icon("view-all"), label: "Send everyone to the default view", filter: { activeTools: [TOOL] } }],
    onClick: async () => {
      if (!(await saved())) return void OBR.notification.show("No default view yet: draw a box first.", "WARNING");
      await OBR.broadcast.sendMessage(GO_CHANNEL, {}, { destination: "ALL" });
    },
  });
  await OBR.tool.createAction({
    id: "com.abelon.view/clear",
    icons: [{ icon: icon("view-clear"), label: "Clear the default view", filter: { activeTools: [TOOL] } }],
    onClick: async () => {
      await OBR.scene.setMetadata({ [VIEW_KEY]: undefined });
      await showBox(undefined);
      await OBR.notification.show("Default view cleared for this scene.", "INFO");
    },
  });
}

let started = false;
export async function startViewHost() {
  if (started) return;
  started = true;
  if ((await OBR.player.getRole()) === "GM") await gmTool();
  OBR.broadcast.onMessage(GO_CHANNEL, () => void goToDefault());
  // every time a scene opens (for every player), fit its default view
  OBR.scene.onReadyChange((ready) => {
    if (ready) setTimeout(() => void goToDefault(), 150);
  });
  // the scene already open when Owlbear loads counts too, but not when the extension merely
  // reloads itself (⟳ Update) mid-session: that would yank everyone's view
  let first = true;
  try {
    first = !sessionStorage.getItem("abelon.view.started");
    sessionStorage.setItem("abelon.view.started", "1");
  } catch { /* no storage: treat as first */ }
  if (first && (await OBR.scene.isReady())) void goToDefault();
}
