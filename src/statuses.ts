// Status catalogue shared by the DM panel (picker, reminders) and the extension
// (token label colours). Reminders are one-line summaries of the 2024 rules,
// plus Abelon's Rot rules.
export interface StatusDef {
  key: string;
  label: string;
  colour: string; // label background on the token
  reminder: string;
  max?: number; // has a value 1..max (stacks / levels)
}

export const STATUS_DEFS: StatusDef[] = [
  { key: "blinded", label: "Blinded", colour: "#5b4a73", reminder: "Can't see. Attacks against it have advantage; its attacks have disadvantage." },
  { key: "charmed", label: "Charmed", colour: "#a0466e", reminder: "Can't attack the charmer. The charmer has advantage on social checks against it." },
  { key: "concentrating", label: "Concentrating", colour: "#3f6f9e", reminder: "On taking damage: Con save, DC 10 or half the damage (max 30), or the spell ends." },
  { key: "deafened", label: "Deafened", colour: "#5b4a73", reminder: "Can't hear." },
  { key: "exhaustion", label: "Exhaustion", colour: "#9a6324", max: 6, reminder: "Each level: −2 to D20 Tests and −5 ft speed. Level 6: dies." },
  { key: "frightened", label: "Frightened", colour: "#7a3b8a", reminder: "Disadvantage on checks and attacks while the source is in sight. Can't move closer to it." },
  { key: "grappled", label: "Grappled", colour: "#7c5a3a", reminder: "Speed 0. Disadvantage on attacks against anyone but the grappler." },
  { key: "incapacitated", label: "Incapacitated", colour: "#6e6e6e", reminder: "No actions, bonus actions or reactions. Concentration ends. Can't speak." },
  { key: "invisible", label: "Invisible", colour: "#4c7f86", reminder: "Attacks against it have disadvantage; its attacks have advantage (unless it can be seen)." },
  { key: "paralyzed", label: "Paralyzed", colour: "#a33b2e", reminder: "Incapacitated, can't move or speak. Fails Str and Dex saves. Attacks against it have advantage; hits within 5 ft are crits." },
  { key: "petrified", label: "Petrified", colour: "#6e6e6e", reminder: "Turned to stone: incapacitated, resistance to all damage, immune to poison." },
  { key: "poisoned", label: "Poisoned", colour: "#4f7d2f", reminder: "Disadvantage on attack rolls and ability checks." },
  { key: "prone", label: "Prone", colour: "#7c5a3a", reminder: "Crawls or stands (half speed). Disadvantage on attacks. Attacks within 5 ft have advantage, beyond have disadvantage." },
  { key: "restrained", label: "Restrained", colour: "#7c5a3a", reminder: "Speed 0. Attacks against it have advantage; its attacks have disadvantage. Disadvantage on Dex saves." },
  { key: "rotten", label: "Rotten", colour: "#4a3a5e", max: 6, reminder: "Each stack −2 to a score (Str, Dex, Con, Int, Wis, Cha in order); −10 ft speed from stack 1. +1 Rot DC per stack. Magical healing clears all." },
  { key: "slowed", label: "Slowed", colour: "#3f6f9e", reminder: "Speed halved." },
  { key: "stunned", label: "Stunned", colour: "#a33b2e", reminder: "Incapacitated. Fails Str and Dex saves. Attacks against it have advantage." },
  { key: "unconscious", label: "Unconscious", colour: "#a33b2e", reminder: "Incapacitated and prone, drops what it holds. Fails Str and Dex saves. Attacks against it have advantage; hits within 5 ft are crits." },
];

export const CUSTOM_COLOUR = "#5c5446";

export function statusDef(key: string): StatusDef | undefined {
  return STATUS_DEFS.find((d) => d.key === key);
}

export function tokenText(s: { label: string; value?: number }): string {
  return s.value ? `${s.label} ${s.value}` : s.label;
}
