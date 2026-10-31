// The roll the DM panel asks every player's Owlbear to show. The panel has already
// rolled it: the animation only ever lands on these exact values.
export interface ShownDie {
  sides: number; // 4, 6, 8, 10, 12, 20 or 100
  value: number;
  kept?: boolean; // false = the dropped die of an advantage/disadvantage pair
  tint?: string; // palette key: "brass", "verdigris", a damage type, "healing"
}
export interface ShownResult {
  value: number;
  label: string; // "to hit", "piercing", "Deception check"
  tint?: string;
}
export interface ShownRoll {
  id: string;
  who: string; // the visible (player-facing) name
  action: string; // public ability name, or "" for the dice box
  dice: ShownDie[];
  results: ShownResult[];
  detail?: string; // "d20 14 + 7"
  tag?: string; // "Natural 20", "Critical hit"
  tone?: "crit" | "fumble";
  private?: boolean; // show to the GM only
}

export const DICE_CHANNEL = "com.abelon.dice/show";
export const DICE_SHOW_MS = 9000; // covers page load + throw + read time + fade
