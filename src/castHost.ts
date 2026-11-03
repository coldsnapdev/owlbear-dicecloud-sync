// The cast in Owlbear (GM only): the right-click menu for who a token is and whether the
// players see their name, and a gold real-name tag over every disguised token that only the
// GM's own screen shows.
import OBR, { buildLabel, type Item } from "@owlbear-rodeo/sdk";
import { BUILD } from "./build";
import { clearMatch, linkTokens, loadCast, mirrorExtras, NAMER_KEY, setHidden, type NamerData } from "./cast";
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

let started = false;
export async function startCastHost() {
  if (started) return;
  started = true;
  if ((await OBR.player.getRole()) !== "GM") return;
  menus();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void drawTags(), 200);
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
    if (ready) void hook();
  });
  void hook();
  // anyone carried over from the old Namer's room list shows up on the manual's Cast page
  mirrorExtras().catch(() => {});
}
