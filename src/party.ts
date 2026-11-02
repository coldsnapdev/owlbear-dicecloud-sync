// The party list: Forge used to keep one so the party could be dropped into any scene.
// Ours lives in room metadata (so it follows the room into every scene): each member's
// token image, size and name plate, captured from a scene where they're already set up.
// Their DiceCloud link follows by name (the character links are room-wide already).
import OBR, { buildImage, isImage, type Image, type Item } from "@owlbear-rodeo/sdk";
import { FORGE_KEYS } from "./forge";

const PARTY_KEY = "com.abelon.party/list";

export interface PartyMember {
  name: string;
  image: Image["image"];
  grid: Image["grid"];
  scale: Item["scale"];
  text: Image["text"];
  textItemType: Image["textItemType"];
}

export async function getParty(): Promise<PartyMember[]> {
  const v = (await OBR.room.getMetadata())[PARTY_KEY];
  return Array.isArray(v) ? (v as PartyMember[]) : [];
}

/** Capture these tokens as the party (replacing members with the same name). */
export async function saveParty(items: Item[]): Promise<number> {
  const now = await getParty();
  const fresh = items.filter(isImage).map(
    (i): PartyMember => ({ name: i.name, image: i.image, grid: i.grid, scale: i.scale, text: i.text, textItemType: i.textItemType }),
  );
  const names = new Set(fresh.map((m) => m.name));
  await OBR.room.setMetadata({ [PARTY_KEY]: [...now.filter((m) => !names.has(m.name)), ...fresh] });
  return fresh.length;
}

export async function removeFromParty(name: string) {
  await OBR.room.setMetadata({ [PARTY_KEY]: (await getParty()).filter((m) => m.name !== name) });
}

/** Drop every member who isn't already in this scene, in a row at the centre of the view. */
export async function addPartyToScene(): Promise<number> {
  const party = await getParty();
  const present = new Set((await OBR.scene.items.getItems()).map((i) => i.name));
  const todo = party.filter((m) => !present.has(m.name));
  if (!todo.length) return 0;
  const [vw, vh, dpi] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight(), OBR.scene.grid.getDpi()]);
  const centre = await OBR.viewport.inverseTransformPoint({ x: vw / 2, y: vh / 2 });
  const step = dpi * 1.1;
  const left = centre.x - ((todo.length - 1) * step) / 2;
  const tokens = todo.map((m, i) =>
    buildImage(m.image, m.grid)
      .name(m.name)
      .text(m.text)
      .textItemType(m.textItemType)
      .scale(m.scale)
      .position({ x: Math.round(left + i * step), y: Math.round(centre.y) })
      .layer("CHARACTER")
      .metadata({ [FORGE_KEYS.name]: m.name })
      .build(),
  );
  await OBR.scene.items.addItems(tokens);
  return tokens.length;
}
