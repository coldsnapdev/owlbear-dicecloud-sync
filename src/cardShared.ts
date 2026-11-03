import { dateText, partOfDay, type Clock } from "./clock";

export const CARD_ID = "com.abelon.scene/card";
export const CARD_KEY = "com.abelon.scene/card"; // scene metadata: { title, time, date }
export const CARD_CHANNEL = "com.abelon.scene/card-show";
export interface CardMeta {
  title: string;
  /** free text: "evening", "just before dawn" */
  time?: string;
  /** add the in-game date from the Almanac */
  date?: boolean;
}

const MONTHS = ["Saelwyn", "Saelmora", "Saeleth", "Vanewyn", "Vanemora", "Vaneeth", "Thalwyn", "Thalmora", "Thaleth"];
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
/** "27th Saeleth", from the player site's almanac.json */
export async function almanacDate(): Promise<string | undefined> {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/coldsnapdev/abelon-site/main/almanac.json?t=${Date.now()}`, { cache: "no-store" });
    const j = await r.json();
    const d = j.currentDate as { day: number; month: number; year: number };
    return `${ord(d.day)} ${MONTHS[d.month - 1] ?? ""}`.trim();
  } catch {
    return undefined;
  }
}
/** "27th Saeleth · evening": the live clock's date and part of the day (the Almanac's date if the
 * clock hasn't been started); a typed time of day overrides the clock's. */
export async function subtitleFor(c: CardMeta, clock?: Clock): Promise<string> {
  if (!c.date) return c.time?.trim() ?? "";
  const date = clock ? dateText(clock) : await almanacDate();
  const time = c.time?.trim() || (clock ? partOfDay(clock.min).toLowerCase() : "");
  return [date, time].filter(Boolean).join(" · ");
}
