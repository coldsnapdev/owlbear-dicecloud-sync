// The veil: when a scene opens, the players see black until the GM reveals it (with its title
// card). Which scene is revealed lives in the room, keyed by an id each scene is given.
import OBR from "@owlbear-rodeo/sdk";

export const VEIL_ID = "com.abelon.scene/veil";
export const VEIL_LIFT = "com.abelon.scene/veil-lift"; // local: show the black, or lift it (with the card)
export const VEIL_HELLO = "com.abelon.scene/veil-hello"; // local: the overlay asking what to show
export const SCENE_ID_KEY = "com.abelon.scene/id"; // scene: a stable id we give each scene
export const VEIL_OFF_KEY = "com.abelon.scene/no-veil"; // scene: this scene opens without the veil
export const REVEALED_KEY = "com.abelon.scene/revealed"; // room: { scene, at } shown to players

export interface Revealed {
  scene: string;
  at: number;
}

export interface VeilMsg {
  show: boolean;
  /** lifting with the scene's title card */
  title?: string;
  sub?: string;
}

export interface VeilState {
  /** the scene holds players on black until revealed */
  applies: boolean;
  /** the GM has revealed this scene */
  revealed: boolean;
  sceneId?: string;
}

export async function veilState(): Promise<VeilState> {
  if (!(await OBR.scene.isReady())) return { applies: true, revealed: false };
  const [scene, room] = await Promise.all([OBR.scene.getMetadata(), OBR.room.getMetadata()]);
  const sceneId = scene[SCENE_ID_KEY] as string | undefined;
  const r = room[REVEALED_KEY] as Revealed | undefined;
  return { applies: !scene[VEIL_OFF_KEY], revealed: !!sceneId && r?.scene === sceneId, sceneId };
}

/** players can see the map */
export const isClear = (v: VeilState) => !v.applies || v.revealed;

export async function reveal() {
  const id = (await OBR.scene.getMetadata())[SCENE_ID_KEY] as string | undefined;
  if (!id) return;
  await OBR.room.setMetadata({ [REVEALED_KEY]: { scene: id, at: Date.now() } satisfies Revealed });
}
export async function hideAgain() {
  await OBR.room.setMetadata({ [REVEALED_KEY]: undefined });
}
