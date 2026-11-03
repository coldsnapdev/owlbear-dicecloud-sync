// The Owlbear side of Abelon combat, run from the background page:
//  - the combat strip popover (every client opens its own while anyone is in combat)
//  - right-click "Add to combat" / "Remove from combat" (GM)
//  - HP bars under tokens (drawn by the GM's client, seen by everyone)
//  - mirroring statuses into the combat state so players' strips can show them
import OBR, { buildPath, buildShape, Command, type Item, type PathCommand } from "@owlbear-rodeo/sdk";
import { addToCombat, addToStandby, removeFromStandby, STANDBY_KEY, FALLEN_KEY, fallenOf, setFallen, applyStatBlock, COMBAT_KEY, partyIds, getState, inCombat, removeFromCombat, type CombatState, type PublicStatus } from "./combat";
import { FORGE_KEYS } from "./forge";
import { GM_STATUS_KEY } from "./stripKeys";
import { BUILD } from "./build";
import { onTopChange, topOffset } from "./toolOffset";
import { linkedPerson, loadCast } from "./cast";
import { getGitHubToken, loadAssignments, loadBestiary, type Assignments, type BestiaryEntry } from "./mailbox";

const STRIP_ID = "com.abelon.combat/strip";
const CHIP_W = 104; // shield 96 + gap 8
const STRIP_H = 190; // starting height; the strip then reports what its contents actually need
let stripHeight = STRIP_H;
let wantHeight = STRIP_H;

// --- The strip popover --------------------------------------------------------------------
let gm = false;
let stripOpen = false;
let stripWidth = 0;
let openedAtVw = 0;

function widthFor(n: number, vw: number) {
  return Math.max(220, Math.min(vw - 100, (n + 1) * CHIP_W + 30 + (gm ? 70 : 0)));
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
      url: new URL(`strip.html?v=${BUILD}`, location.href).href,
      width: w,
      height: wantHeight,
      anchorReference: "POSITION",
      anchorPosition: { left: Math.round(vw / 2), top: topOffset() },
      anchorOrigin: { horizontal: "CENTER", vertical: "TOP" },
      transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
      hidePaper: true,
      disableClickAway: true,
    });
    stripOpen = true;
    stripWidth = w;
    stripHeight = wantHeight;
    openedAtVw = vw;
  } else {
    if (w !== stripWidth) {
      await OBR.popover.setWidth(STRIP_ID, w);
      stripWidth = w;
    }
    if (wantHeight !== stripHeight) {
      await OBR.popover.setHeight(STRIP_ID, wantHeight);
      stripHeight = wantHeight;
    }
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
    onClick: async (ctx) => {
      await addToCombat(ctx.items.map((i) => i.id));
      await fillFromBestiary(ctx.items).catch((err) => console.warn("[abelon] couldn't fill stats from the bestiary", err));
    },
  });
  OBR.contextMenu.create({
    id: "com.abelon.combat/remove",
    icons: [{ icon, label: "Remove from combat", filter: { roles: ["GM"], every: [{ key: ["metadata", FORGE_KEYS.onList], value: undefined, operator: "!=" }] } }],
    onClick: (ctx) => removeFromCombat(ctx.items.map((i) => i.id)),
  });
  // on the DM panel only: statuses and stat block ready, but no initiative and no HP bar
  const panelIcon = new URL("icons/panel.svg", location.href).href;
  OBR.contextMenu.create({
    id: "com.abelon.combat/standby-add",
    icons: [{ icon: panelIcon, label: "Add to panel", filter: { roles: ["GM"], every: [{ key: ["metadata", FORGE_KEYS.onList], value: undefined }, { key: ["metadata", STANDBY_KEY], value: undefined }] } }],
    onClick: async (ctx) => {
      await addToStandby(ctx.items.map((i) => i.id));
      await fillFromBestiary(ctx.items).catch((err) => console.warn("[abelon] couldn't fill stats from the bestiary", err));
    },
  });
  OBR.contextMenu.create({
    id: "com.abelon.combat/standby-remove",
    icons: [{ icon: panelIcon, label: "Remove from panel", filter: { roles: ["GM"], every: [{ key: ["metadata", STANDBY_KEY], value: undefined, operator: "!=" }, { key: ["metadata", FORGE_KEYS.onList], value: undefined }] } }],
    onClick: (ctx) => removeFromStandby(ctx.items.map((i) => i.id)),
  });
  const skull = new URL("icons/fallen-dead.svg", location.href).href;
  OBR.contextMenu.create({
    id: "com.abelon.combat/dead",
    icons: [{ icon: skull, label: "Mark dead", filter: { roles: ["GM"], every: [{ key: "layer", value: "CHARACTER" }, { key: ["metadata", FALLEN_KEY], value: undefined }] } }],
    onClick: (ctx) => setFallen(ctx.items.map((i) => i.id), "dead"),
  });
  OBR.contextMenu.create({
    id: "com.abelon.combat/revive",
    icons: [{ icon: skull, label: "Revive", filter: { roles: ["GM"], every: [{ key: ["metadata", FALLEN_KEY], value: undefined, operator: "!=" }] } }],
    onClick: (ctx) => setFallen(ctx.items.map((i) => i.id), null),
  });
}

// Without Forge nothing gives a freshly placed NPC its stats, so joining combat does: any
// token with no max HP that matches a bestiary entry (the panel's chosen entry, else by its
// real or shown name, with or without a trailing number) gets that stat block at full HP.
const norm = (s: string) => s.trim().toLowerCase();
async function fillFromBestiary(items: Item[]) {
  const bare = items.filter((i) => !((num(i.metadata[FORGE_KEYS.maxHP]) ?? 0) > 0));
  if (!bare.length) return;
  const token = getGitHubToken();
  const [bestiary, assignments, linked, cast] = await Promise.all([loadBestiary(token), loadAssignments(token).catch(() => ({}) as Assignments), partyIds(), loadCast().catch(() => ({ people: [] }))]);
  const byName = new Map(bestiary.map((e) => [norm(e.name), e]));
  for (const it of bare) {
    if (linked.has(it.id)) continue; // party: their sheet fills these
    const chosen = assignments[it.id] && bestiary.find((e) => e.id === assignments[it.id]);
    const real = (it.metadata["com.abelon.namer/data"] as { realName?: string } | undefined)?.realName;
    // the panel's choice, then the stat block of the person the token is, then by name
    const person = linkedPerson(cast.people, it);
    let entry: BestiaryEntry | undefined = chosen || (person?.statBlock ? bestiary.find((e) => e.id === person.statBlock) : undefined);
    for (const n of [real, it.name]) {
      if (entry || !n) continue;
      entry = byName.get(norm(n)) ?? byName.get(norm(n.replace(/\s*\d+$/, "")));
    }
    if (entry) await applyStatBlock(it.id, entry.forge as Record<string, unknown>);
  }
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
  const tokens = items.filter((i) => !i.metadata[BAR_KEY] && !i.metadata[FALL_KEY] && inCombat(i) && fallenOf(i) !== "dead" && (num(i.metadata[FORGE_KEYS.maxHP]) ?? 0) > 0);
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
  await drawFallen(items, dpi);
}

// --- The fallen ---------------------------------------------------------------------------
// A dead token: tipped over (its rotation, set by setFallen), a dark wash and a skull. A party
// member who's down: a lighter wash and a cracked heart, standing, and it clears itself once
// they're healed above 0 HP. Everyone sees these; they follow the token's own visibility.
const FALL_KEY = "com.abelon.combat/fallen-mark";
const FALL_STYLE = 2; // 1 used image items, which Owlbear drew as black squares

// The icons as paths (drawn in a 256-unit box centred on 128,128), so they need no image
// loading and scale exactly. The skull's eyes and nose are holes (even-odd fill).
type Pt = [number, number];
const ellipse = (cx: number, cy: number, rx: number, ry: number): (Pt | Pt[])[] => {
  const k = 0.5523;
  return [
    [cx + rx, cy],
    [[cx + rx, cy + ry * k], [cx + rx * k, cy + ry], [cx, cy + ry]],
    [[cx - rx * k, cy + ry], [cx - rx, cy + ry * k], [cx - rx, cy]],
    [[cx - rx, cy - ry * k], [cx - rx * k, cy - ry], [cx, cy - ry]],
    [[cx + rx * k, cy - ry], [cx + rx, cy - ry * k], [cx + rx, cy]],
  ];
};
// each shape: first point is a move, then [x,y] = line or [[c1],[c2],[end]] = cubic; all closed
const SKULL: (Pt | Pt[])[][] = [
  [
    [128, 34],
    [[82, 34], [48, 65], [48, 108]], [[48, 133], [59, 151], [75, 162]], [75, 186],
    [[75, 194], [81, 200], [89, 200]], [99, 200], [99, 182], [112, 182], [112, 200], [144, 200], [144, 182], [157, 182], [157, 200], [167, 200],
    [[175, 200], [181, 194], [181, 186]], [181, 162], [[197, 151], [208, 133], [208, 108]], [[208, 65], [174, 34], [128, 34]],
  ],
  ellipse(96, 114, 20, 23),
  ellipse(160, 114, 20, 23),
  [[128, 140], [116, 162], [140, 162]],
];
const HEART: (Pt | Pt[])[][] = [
  [
    [128, 214],
    [[128, 214], [46, 168], [46, 102]], [[46, 74], [67, 54], [92, 54]], [[109, 54], [122, 63], [128, 76]],
    [[134, 63], [147, 54], [164, 54]], [[189, 54], [210, 74], [210, 102]], [[210, 168], [128, 214], [128, 214]],
  ],
];
const CRACK: Pt[] = [[130, 70], [114, 110], [140, 124], [122, 168]];
function toCommands(shapes: (Pt | Pt[])[][], k: number, close = true): PathCommand[] {
  const p = (q: Pt): [number, number] => [(q[0] - 128) * k, (q[1] - 128) * k];
  const out: PathCommand[] = [];
  for (const shape of shapes) {
    shape.forEach((step, i) => {
      if (i === 0) out.push([Command.MOVE, ...p(step as Pt)]);
      else if (Array.isArray(step[0])) {
        const [a, b, c] = step as Pt[];
        out.push([Command.CUBIC, ...p(a), ...p(b), ...p(c)]);
      } else out.push([Command.LINE, ...p(step as Pt)]);
    });
    if (close) out.push([Command.CLOSE]);
  }
  return out;
}
interface FallMeta { parent: string; part: string; sig: string }
async function drawFallen(items: Item[], dpi: number) {
  const marks = items.filter((i) => i.metadata[FALL_KEY]);
  const fallen = items.filter((i) => !i.metadata[FALL_KEY] && !i.metadata[BAR_KEY] && fallenOf(i));
  // a party member healed above 0 stands back up by themselves
  const healed = fallen.filter((t) => fallenOf(t) === "down" && (num(t.metadata[FORGE_KEYS.currentHP]) ?? 0) > 0);
  if (healed.length) {
    await setFallen(healed.map((t) => t.id), null);
    return; // the change brings us back here
  }
  const keep = new Set<string>();
  const add: Item[] = [];
  for (const t of fallen) {
    const dead = fallenOf(t) === "dead";
    const b = await OBR.scene.items.getItemBounds([t.id]);
    const size = Math.min(b.width, b.height);
    const centre = { x: Math.round(b.center.x), y: Math.round(b.center.y) };
    const parts = dead ? ["wash", "icon"] : ["wash", "icon", "crack"];
    const want = parts.map((part) => ({ part, sig: JSON.stringify([FALL_STYLE, part, dead, centre, size, t.visible]) }));
    for (const w of want) {
      const match = marks.find((e) => {
        const m = e.metadata[FALL_KEY] as FallMeta;
        return !keep.has(e.id) && m.parent === t.id && m.part === w.part && m.sig === w.sig;
      });
      if (match) {
        keep.add(match.id);
        continue;
      }
      const meta = { [FALL_KEY]: { parent: t.id, part: w.part, sig: w.sig } satisfies FallMeta };
      if (w.part === "wash") {
        add.push(
          buildShape()
            .shapeType("CIRCLE")
            .width(size * 0.94)
            .height(size * 0.94)
            .position(centre)
            .fillColor(dead ? "#0d0a07" : "#2a0d0a")
            .fillOpacity(dead ? 0.6 : 0.35)
            .strokeWidth(0)
            .strokeOpacity(0)
            .attachedTo(t.id)
            .layer("ATTACHMENT")
            .zIndex(5)
            .locked(true)
            .disableHit(true)
            .visible(t.visible)
            .disableAttachmentBehavior(["ROTATION", "COPY", "SCALE"])
            .metadata(meta)
            .build(),
        );
      } else {
        const k = (size * (dead ? 0.5 : 0.36)) / 256;
        const crack = w.part === "crack";
        add.push(
          buildPath()
            .commands(crack ? toCommands([CRACK], k, false) : toCommands(dead ? SKULL : HEART, k))
            .fillRule("evenodd")
            .fillColor(dead ? "#d9cdb4" : "#c9574a")
            .fillOpacity(crack ? 0 : 0.92)
            .strokeColor("#1a140e")
            .strokeOpacity(1)
            .strokeWidth(Math.max(2, Math.round(7 * k * (crack ? 1.3 : 1))))
            .position(centre)
            .attachedTo(t.id)
            .layer("ATTACHMENT")
            .zIndex(crack ? 7 : 6)
            .locked(true)
            .disableHit(true)
            .visible(t.visible)
            .disableAttachmentBehavior(["ROTATION", "COPY", "SCALE"])
            .metadata(meta)
            .build(),
        );
      }
    }
  }
  const stale = marks.filter((e) => !keep.has(e.id)).map((e) => e.id);
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

// --- Turn and target markers ---------------------------------------------------------------
// The active token gets a gold halo, gently breathing, with a dashed ring slowly turning round
// it; each target gets the same in red, turning the other way. Drawn as local items on every
// client (nothing synced), so each screen animates them smoothly; players only get markers on
// tokens they can see.
const TURN_KEY = "com.abelon.combat/turn-marker";
type Kind = "turn" | "target";
const LOOK: Record<Kind, { halo: string; ring: string; spin: number }> = {
  turn: { halo: "#f0c869", ring: "#f6d98e", spin: 12 },
  target: { halo: "#e0533d", ring: "#f0745e", spin: -12 },
};
interface Marker { key: string; kind: Kind; halo: string; ring: string; sig: string }
let markers: Marker[] = [];
let markerTick: ReturnType<typeof setInterval> | undefined;
let markerBusy = false;
let markerAgain = false;
const t0 = performance.now();
async function clearMarker() {
  markers = [];
  try {
    const mine = (await OBR.scene.local.getItems()).filter((i) => i.metadata[TURN_KEY]).map((i) => i.id);
    if (mine.length) await OBR.scene.local.deleteItems(mine);
  } catch {
    // no scene
  }
}
function markerItems(kind: Kind, centre: { x: number; y: number }, size: number, dpi: number, parent: string, grow: number) {
  const look = LOOK[kind];
  const halo = buildShape()
    .shapeType("CIRCLE")
    .width(size * (1.06 + grow))
    .height(size * (1.06 + grow))
    .position(centre)
    .fillColor(look.halo)
    .fillOpacity(0.22)
    .strokeWidth(0)
    .strokeOpacity(0)
    .layer("PROP")
    .attachedTo(parent)
    .disableAttachmentBehavior(["ROTATION", "SCALE", "COPY"])
    .locked(true)
    .disableHit(true)
    .metadata({ [TURN_KEY]: kind })
    .build();
  const ring = buildShape()
    .shapeType("CIRCLE")
    .width(size * (1.01 + grow))
    .height(size * (1.01 + grow))
    .position(centre)
    .fillOpacity(0)
    .strokeColor(look.ring)
    .strokeOpacity(0.95)
    .strokeWidth(Math.max(4, Math.round(dpi * 0.065)))
    .strokeDash([Math.round(dpi * 0.22), Math.round(dpi * 0.11)])
    .layer("PROP")
    .attachedTo(parent)
    .disableAttachmentBehavior(["ROTATION", "SCALE", "COPY"])
    .locked(true)
    .disableHit(true)
    .metadata({ [TURN_KEY]: kind })
    .build();
  return { halo, ring };
}
async function updateMarker() {
  if (markerBusy) {
    markerAgain = true;
    return;
  }
  markerBusy = true;
  try {
    if (!(await OBR.scene.isReady())) return clearMarker();
    const st = await getState();
    const want: { id: string; kind: Kind }[] = [];
    if (st.turn) want.push({ id: st.turn, kind: "turn" });
    for (const id of st.targets ?? []) want.push({ id, kind: "target" });
    const tokens = want.length ? await OBR.scene.items.getItems(want.map((w) => w.id)) : [];
    const byId = new Map(tokens.map((t) => [t.id, t]));
    const dpi = await OBR.scene.grid.getDpi();
    const next: { key: string; kind: Kind; id: string; sig: string; centre: { x: number; y: number }; size: number; grow: number }[] = [];
    for (const w of want) {
      const t = byId.get(w.id);
      if (!t || (!gm && !t.visible)) continue;
      if (w.kind === "turn" && !inCombat(t)) continue;
      const b = await OBR.scene.items.getItemBounds([t.id]);
      const size = Math.max(b.width, b.height);
      // a target that's also the active token gets its red marker just outside the gold one
      const grow = w.kind === "target" && st.turn === t.id ? 0.12 : 0;
      next.push({ key: `${w.kind}:${t.id}`, kind: w.kind, id: t.id, centre: b.center, size, grow, sig: JSON.stringify([Math.round(b.center.x), Math.round(b.center.y), Math.round(size), grow]) });
    }
    const keep = new Set<string>();
    const gone: string[] = [];
    for (const m of markers) {
      const n = next.find((x) => x.key === m.key);
      if (n && n.sig === m.sig) keep.add(m.key);
      else gone.push(m.halo, m.ring);
    }
    markers = markers.filter((m) => keep.has(m.key));
    if (gone.length) await OBR.scene.local.deleteItems(gone);
    const add = next.filter((n) => !keep.has(n.key));
    const items: Item[] = [];
    for (const n of add) {
      const { halo, ring } = markerItems(n.kind, n.centre, n.size, dpi, n.id, n.grow);
      items.push(halo, ring);
      markers.push({ key: n.key, kind: n.kind, halo: halo.id, ring: ring.id, sig: n.sig });
    }
    if (items.length) await OBR.scene.local.addItems(items);
    if (markers.length && !markerTick) {
      markerTick = setInterval(() => {
        if (!markers.length) return;
        const t = (performance.now() - t0) / 1000;
        const kindOf = new Map<string, { kind: Kind; ring: boolean }>();
        for (const m of markers) {
          kindOf.set(m.ring, { kind: m.kind, ring: true });
          kindOf.set(m.halo, { kind: m.kind, ring: false });
        }
        OBR.scene.local
          .updateItems([...kindOf.keys()], (its) => {
            for (const it of its) {
              const k = kindOf.get(it.id);
              if (!k) continue;
              if (k.ring) it.rotation = (((t * LOOK[k.kind].spin) % 360) + 360) % 360; // one turn every 30 s
              else (it as Item & { style: { fillOpacity: number } }).style.fillOpacity = 0.14 + 0.1 * (0.5 + 0.5 * Math.sin(t * 1.3));
            }
          })
          .catch(() => {});
      }, 70);
    } else if (!markers.length && markerTick) {
      clearInterval(markerTick);
      markerTick = undefined;
    }
  } finally {
    markerBusy = false;
    if (markerAgain) {
      markerAgain = false;
      updateMarker().catch(() => {});
    }
  }
}

// --- Start-up -----------------------------------------------------------------------------
let started = false;
export async function startCombatHost() {
  if (started) return;
  started = true;
  gm = (await OBR.player.getRole()) === "GM";
  if (gm) contextMenus();
  // a tool with an options bar was picked (or put down): reopen the strip above or below it
  onTopChange(() => {
    if (!stripOpen) return;
    stripOpen = false;
    void OBR.popover.close(STRIP_ID).then(() => updateStrip()).catch(() => {});
  });
  const onItems = () => {
    updateStrip().catch(() => {});
    scheduleBars();
    updateMarker().catch(() => {});
  };
  let listening = false;
  const hook = async () => {
    if (!(await OBR.scene.isReady())) return closeStrip();
    if (!listening) {
      listening = true;
      OBR.scene.items.onChange(onItems);
      OBR.scene.onMetadataChange(() => updateMarker().catch(() => {}));
    }
    onItems();
  };
  await hook();
  OBR.scene.onReadyChange((ready) => (ready ? hook() : (closeStrip(), clearMarker())));
  // the viewport can change size; recentre the strip when it does
  setInterval(() => {
    if (stripOpen) updateStrip().catch(() => {});
  }, 3000);
  // the strip reports how tall its contents are (statuses under the big active shield, etc.)
  OBR.broadcast.onMessage("com.abelon.combat/strip-size", (ev) => {
    const h = Number((ev.data as { height?: number } | undefined)?.height);
    if (Number.isFinite(h) && h > 0) wantHeight = Math.max(120, Math.min(400, Math.ceil(h)));
    updateStrip().catch(() => {});
  });
}
