// The Owlbear side of Abelon combat, run from the background page:
//  - the combat strip popover (every client opens its own while anyone is in combat)
//  - right-click "Add to combat" / "Remove from combat" (GM)
//  - HP bars under tokens (drawn by the GM's client, seen by everyone)
//  - mirroring statuses into the combat state so players' strips can show them
import OBR, { buildShape, type Item } from "@owlbear-rodeo/sdk";
import { addToCombat, COMBAT_KEY, getState, inCombat, removeFromCombat, type CombatState, type PublicStatus } from "./combat";
import { FORGE_KEYS } from "./forge";
import { GM_STATUS_KEY } from "./stripKeys";

const STRIP_ID = "com.abelon.combat/strip";
const CHIP_W = 130; // chip 124 + gap 6
const STRIP_H = 118;

// --- The strip popover --------------------------------------------------------------------
let gm = false;
let stripOpen = false;
let stripWidth = 0;
let openedAtVw = 0;

function widthFor(n: number, vw: number) {
  return Math.max(160, Math.min(vw - 140, n * CHIP_W + 20 + (gm ? 150 : 90)));
}
async function updateStrip() {
  if (!(await OBR.scene.isReady())) return closeStrip();
  const its = await OBR.scene.items.getItems(inCombat);
  const n = gm ? its.length : its.filter((i) => i.visible).length;
  if (!n) return closeStrip();
  const vw = await OBR.viewport.getWidth();
  const w = widthFor(n, vw);
  if (!stripOpen || Math.abs(vw - openedAtVw) > 4) {
    await OBR.popover.open({
      id: STRIP_ID,
      url: new URL("strip.html", location.href).href,
      width: w,
      height: STRIP_H,
      anchorReference: "POSITION",
      anchorPosition: { left: Math.round(vw / 2), top: 6 },
      anchorOrigin: { horizontal: "CENTER", vertical: "TOP" },
      transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
      hidePaper: true,
      disableClickAway: true,
    });
    stripOpen = true;
    stripWidth = w;
    openedAtVw = vw;
  } else if (w !== stripWidth) {
    await OBR.popover.setWidth(STRIP_ID, w);
    stripWidth = w;
  }
}
async function closeStrip() {
  if (!stripOpen) return;
  stripOpen = false;
  await OBR.popover.close(STRIP_ID);
}

// --- Right-click menu ---------------------------------------------------------------------
function contextMenus() {
  const icon = new URL("icons/swords.svg", location.href).href;
  OBR.contextMenu.create({
    id: "com.abelon.combat/add",
    icons: [{ icon, label: "Add to combat", filter: { roles: ["GM"], every: [{ key: ["metadata", FORGE_KEYS.onList], value: undefined }] } }],
    onClick: (ctx) => addToCombat(ctx.items.map((i) => i.id)),
  });
  OBR.contextMenu.create({
    id: "com.abelon.combat/remove",
    icons: [{ icon, label: "Remove from combat", filter: { roles: ["GM"], every: [{ key: ["metadata", FORGE_KEYS.onList], value: undefined, operator: "!=" }] } }],
    onClick: (ctx) => removeFromCombat(ctx.items.map((i) => i.id)),
  });
}

// --- HP bars ------------------------------------------------------------------------------
// Two (or three) flat bars attached inside the bottom edge of each token in combat with HP:
// a dark track, the HP fill, and temp HP in blue after it. Everyone sees them (bars only,
// no numbers); a hidden token's bar is hidden with it.
const BAR_KEY = "com.abelon.hp/bar";
const BAR_STYLE = 2;
interface BarMeta { parent: string; part: string; sig: string }
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? undefined : n;
};
let barDraw: Promise<void> = Promise.resolve();
let barTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleBars() {
  if (!gm) return;
  clearTimeout(barTimer);
  barTimer = setTimeout(() => {
    barDraw = barDraw.catch(() => {}).then(drawBars);
  }, 150);
}
async function drawBars() {
  if (!(await OBR.scene.isReady())) return;
  const items = await OBR.scene.items.getItems();
  const dpi = await OBR.scene.grid.getDpi();
  const bars = items.filter((i) => i.metadata[BAR_KEY]);
  // only during combat: the bars appearing is part of the signal that a fight is on
  const tokens = items.filter((i) => !i.metadata[BAR_KEY] && inCombat(i) && (num(i.metadata[FORGE_KEYS.maxHP]) ?? 0) > 0);
  const keep = new Set<string>();
  const add: Item[] = [];
  for (const t of tokens) {
    const max = num(t.metadata[FORGE_KEYS.maxHP])!;
    const hp = Math.max(0, Math.min(max, num(t.metadata[FORGE_KEYS.currentHP]) ?? max));
    const temp = Math.max(0, num(t.metadata[FORGE_KEYS.tempHP]) ?? 0);
    const b = await OBR.scene.items.getItemBounds([t.id]);
    const w = Math.round(b.width * 0.72);
    const h = Math.max(4, Math.round(dpi * 0.065));
    const x = Math.round(b.center.x - w / 2);
    const y = Math.round(b.max.y - h - dpi * 0.15); // inside the token's bottom edge, clear of the name plate
    const pct = hp / max;
    const fill = pct > 0.5 ? "#4fae5f" : pct > 0.25 ? "#d9a441" : "#d05a43";
    const parts: { part: string; px: number; pw: number; colour: string; opacity: number; z: number }[] = [
      { part: "track", px: x, pw: w, colour: "#15110c", opacity: 0.78, z: 1 },
    ];
    if (hp > 0) parts.push({ part: "fill", px: x, pw: Math.max(2, Math.round(w * pct)), colour: fill, opacity: 1, z: 2 });
    if (temp > 0) {
      const tw = Math.min(w - Math.round(w * pct), Math.max(3, Math.round((w * temp) / max)));
      if (tw > 0) parts.push({ part: "temp", px: x + Math.round(w * pct), pw: tw, colour: "#8fb6e8", opacity: 1, z: 3 });
    }
    for (const p of parts) {
      const sig = JSON.stringify([BAR_STYLE, p.px, y, p.pw, h, p.colour, t.visible]);
      const match = bars.find((e) => {
        const m = e.metadata[BAR_KEY] as BarMeta;
        return !keep.has(e.id) && m.parent === t.id && m.part === p.part && m.sig === sig;
      });
      if (match) {
        keep.add(match.id);
        continue;
      }
      add.push(
        buildShape()
          .shapeType("RECTANGLE")
          .width(p.pw)
          .height(h)
          .position({ x: p.px, y })
          .fillColor(p.colour)
          .fillOpacity(p.opacity)
          .strokeWidth(0)
          .strokeOpacity(0)
          .attachedTo(t.id)
          .layer("ATTACHMENT")
          .zIndex(p.z)
          .locked(true)
          .disableHit(true)
          .visible(t.visible)
          .disableAttachmentBehavior(["ROTATION", "COPY", "SCALE"])
          .metadata({ [BAR_KEY]: { parent: t.id, part: p.part, sig } satisfies BarMeta })
          .build(),
      );
    }
  }
  const stale = bars.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (stale.length) await OBR.scene.items.deleteItems(stale);
  if (add.length) await OBR.scene.items.addItems(add);
}

// --- Statuses for the strip ---------------------------------------------------------------
/** Called after statuses are drawn: public ones go into the combat state (players read it), all of them to the GM's strip. */
export async function mirrorStatuses(all: Record<string, { t: string; c: string; dm?: boolean }[]>) {
  localStorage.setItem(GM_STATUS_KEY, JSON.stringify(all));
  const pub: Record<string, PublicStatus[]> = {};
  for (const [id, list] of Object.entries(all)) {
    const shown = list.filter((s) => !s.dm).map(({ t, c }) => ({ t, c }));
    if (shown.length) pub[id] = shown;
  }
  const now = await getState();
  if (JSON.stringify(now.statuses ?? {}) === JSON.stringify(pub)) return;
  await OBR.scene.setMetadata({ [COMBAT_KEY]: { ...now, statuses: pub } satisfies CombatState });
}

// --- Start-up -----------------------------------------------------------------------------
let started = false;
export async function startCombatHost() {
  if (started) return;
  started = true;
  gm = (await OBR.player.getRole()) === "GM";
  if (gm) contextMenus();
  const onItems = () => {
    updateStrip().catch(() => {});
    scheduleBars();
  };
  let listening = false;
  const hook = async () => {
    if (!(await OBR.scene.isReady())) return closeStrip();
    if (!listening) {
      listening = true;
      OBR.scene.items.onChange(onItems);
    }
    onItems();
  };
  await hook();
  OBR.scene.onReadyChange((ready) => (ready ? hook() : closeStrip()));
  // the viewport can change size; recentre the strip when it does
  setInterval(() => {
    if (stripOpen) updateStrip().catch(() => {});
  }, 3000);
  OBR.broadcast.onMessage("com.abelon.combat/strip-size", () => updateStrip().catch(() => {}));
}
