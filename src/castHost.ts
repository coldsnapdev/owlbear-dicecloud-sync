// The cast in Owlbear (GM only): the right-click menu for who a token is and whether the
// players see their name, and a gold real-name tag over every disguised token that only the
// GM's own screen shows.
import OBR, { buildLabel, type Item } from "@owlbear-rodeo/sdk";
import { BUILD } from "./build";
import { applyDisplayName, clearMatch, linkTokens, loadCast, mirrorExtras, NAMER_KEY, nextPlaceholder, setHidden, type NamerData } from "./cast";
import { getMappings } from "./config";
import { PICKER_ID } from "./castPicker.ids";

function openPicker(ids: string[]) {
  return OBR.modal.open({
    id: PICKER_ID,
    url: new URL(`cast-picker.html?v=${BUILD}&items=${encodeURIComponent(ids.join(","))}`, location.href).href,
    width: 460,
    height: 600,
  });
}

function menus() {
  const icon = new URL("icons/cast.svg", location.href).href;
  OBR.contextMenu.create({
    id: "com.abelon.cast/this-is",
    icons: [{ icon, label: "This is…", filter: { roles: ["GM"], every: [{ key: "layer", value: "CHARACTER" }] } }],
    onClick: (ctx) => openPicker(ctx.items.map((i) => i.id)),
  });
  OBR.contextMenu.create({
    id: "com.abelon.cast/hide",
    icons: [{ icon, label: "Hide name", filter: { roles: ["GM"], every: [{ key: "layer", value: "CHARACTER" }, { key: ["metadata", NAMER_KEY, "hidden"], value: true, operator: "!=" }] } }],
    onClick: async (ctx) => {
      // already linked (or set up by the old Namer): just hide. Otherwise the token's own name
      // decides who it is, if it clearly means one person; if not, ask.
      const known = ctx.items.filter((i) => i.metadata[NAMER_KEY]);
      if (known.length) await setHidden(known.map((i) => i.id), true);
      const rest = ctx.items.filter((i) => !i.metadata[NAMER_KEY]);
      if (!rest.length) return;
      const { people } = await loadCast();
      const unsure: Item[] = [];
      for (const it of rest) {
        const p = clearMatch(people, it.name);
        if (p) await linkTokens([it.id], p, true);
        else unsure.push(it);
      }
      if (unsure.length) await openPicker(unsure.map((i) => i.id));
    },
  });
  OBR.contextMenu.create({
    id: "com.abelon.cast/reveal",
    icons: [{ icon, label: "Reveal name", filter: { roles: ["GM"], every: [{ key: ["metadata", NAMER_KEY, "hidden"], value: true }] } }],
    onClick: (ctx) => setHidden(ctx.items.map((i) => i.id), false),
  });
}

// --- The GM's real-name tags ---------------------------------------------------------------
// Local items: drawn on this screen only, never in the scene the players load.
const TAG_KEY = "com.abelon.cast/tag";
let tagBusy = false;
let tagAgain = false;
async function drawTags() {
  if (tagBusy) {
    tagAgain = true;
    return;
  }
  tagBusy = true;
  try {
    if (!(await OBR.scene.isReady())) return;
    const [items, mine, dpi] = await Promise.all([OBR.scene.items.getItems((i) => i.layer === "CHARACTER"), OBR.scene.local.getItems((i) => !!i.metadata[TAG_KEY]), OBR.scene.grid.getDpi()]);
    const want = items.filter((i) => (i.metadata[NAMER_KEY] as NamerData | undefined)?.hidden && (i.metadata[NAMER_KEY] as NamerData).realName);
    const keep = new Set<string>();
    const add: Item[] = [];
    for (const t of want) {
      const real = (t.metadata[NAMER_KEY] as NamerData).realName;
      const b = await OBR.scene.items.getItemBounds([t.id]);
      const at = { x: Math.round(b.center.x), y: Math.round(b.min.y + dpi * 0.04) };
      const sig = JSON.stringify([real, at, Math.round(dpi)]);
      const have = mine.find((m) => (m.metadata[TAG_KEY] as { parent: string; sig: string }).parent === t.id && (m.metadata[TAG_KEY] as { sig: string }).sig === sig);
      if (have) {
        keep.add(have.id);
        continue;
      }
      add.push(
        buildLabel()
          .plainText(real)
          .position(at)
          .pointerDirection("DOWN")
          .pointerWidth(Math.round(dpi * 0.12))
          .pointerHeight(Math.round(dpi * 0.06))
          .fontFamily("Crimson Pro, Georgia, serif")
          .fontWeight(700)
          .fontSize(Math.max(14, Math.round(dpi * 0.2)))
          .padding(Math.round(dpi * 0.05))
          .cornerRadius(Math.round(dpi * 0.08))
          .fillColor("#1b140c")
          .backgroundColor("#e2c27f")
          .backgroundOpacity(0.92)
          .attachedTo(t.id)
          .disableAttachmentBehavior(["ROTATION", "SCALE", "COPY"])
          .layer("POPOVER")
          .locked(true)
          .disableHit(true)
          .metadata({ [TAG_KEY]: { parent: t.id, sig } })
          .build(),
      );
    }
    const stale = mine.filter((m) => !keep.has(m.id)).map((m) => m.id);
    if (stale.length) await OBR.scene.local.deleteItems(stale);
    if (add.length) await OBR.scene.local.addItems(add);
  } catch (err) {
    console.warn("[abelon] real-name tags:", err);
  } finally {
    tagBusy = false;
    if (tagAgain) {
      tagAgain = false;
      void drawTags();
    }
  }
}

// --- Linking as you go ------------------------------------------------------------------------
// A token dropped into the scene, or renamed, whose name clearly means one person in the cast
// (a full name, or a short name only one person has) is linked to them and its name hidden,
// straight away. Tokens already in the scene when it loads are left for "Set up all". The party
// (anyone linked to a DiceCloud sheet) is never touched. Undo: Reveal name, or This is….
const seenNames = new Map<string, string>();
let primed = false;
let autoBusy = false;
async function autoLink() {
  if (autoBusy) return;
  autoBusy = true;
  try {
    if (!(await OBR.scene.isReady())) return;
    const items = await OBR.scene.items.getItems((i) => i.layer === "CHARACTER");
    const changed: Item[] = [];
    const copies: Item[] = [];
    for (const it of items) {
      const before = seenNames.get(it.id);
      seenNames.set(it.id, it.name);
      if (!primed || before === it.name) continue;
      const d = it.metadata[NAMER_KEY] as NamerData | undefined;
      // a copy of a disguised token arrives with the same placeholder: give it the next number
      if (before === undefined && d && items.some((o) => o.id !== it.id && (o.metadata[NAMER_KEY] as NamerData | undefined)?.placeholder === d.placeholder)) {
        copies.push(it);
        continue;
      }
      // our own name changes (to the placeholder or back to the real name) aren't renames
      if (d && (it.name === d.placeholder || it.name === d.realName)) continue;
      changed.push(it);
    }
    for (const id of [...seenNames.keys()]) if (!items.some((i) => i.id === id)) seenNames.delete(id);
    primed = true;
    for (const it of copies) {
      const d = it.metadata[NAMER_KEY] as NamerData;
      const [gender, ...rest] = d.placeholder.replace(/\s*\d+$/, "").split(" ");
      const next = await nextPlaceholder({ gender, species: rest.join(" ") || null });
      await OBR.scene.items.updateItems([it.id], (its) => {
        for (const x of its) {
          x.metadata[NAMER_KEY] = { ...d, placeholder: next };
          if (d.hidden) applyDisplayName(x, next);
        }
      });
    }
    if (!changed.length) return;
    const party = new Set((await getMappings()).map((m) => m.itemId));
    const { people } = await loadCast();
    for (const it of changed) {
      if (party.has(it.id)) continue;
      const p = clearMatch(people, it.name);
      if (!p) continue;
      const d = it.metadata[NAMER_KEY] as NamerData | undefined;
      await linkTokens([it.id], p, true);
    }
  } catch (err) {
    console.warn("[abelon] linking tokens as you go:", err);
  } finally {
    autoBusy = false;
  }
}

let started = false;
export async function startCastHost() {
  if (started) return;
  started = true;
  if ((await OBR.player.getRole()) !== "GM") return;
  menus();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let linkTimer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void drawTags(), 200);
    clearTimeout(linkTimer);
    linkTimer = setTimeout(() => void autoLink(), 500); // after a drag or a rename settles
  };
  let listening = false;
  const hook = async () => {
    if (!(await OBR.scene.isReady())) return;
    if (!listening) {
      listening = true;
      OBR.scene.items.onChange(soon);
    }
    soon();
  };
  OBR.scene.onReadyChange((ready) => {
    // a new scene: what's already in it is a snapshot, not something just dropped in
    seenNames.clear();
    primed = false;
    if (ready) void hook();
  });
  void hook();
  // anyone carried over from the old Namer's room list shows up on the manual's Cast page
  mirrorExtras().catch(() => {});
}
