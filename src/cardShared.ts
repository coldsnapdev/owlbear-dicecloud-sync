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
export async function subtitleFor(c: CardMeta): Promise<string> {
  const date = c.date ? await almanacDate() : undefined;
  return [date, c.time?.trim()].filter(Boolean).join(" · ");
}
