// Abelon's in-game clock: one date and time for the whole room, kept live from the DM panel.
// Calendar (locked): 9 months of 40 days (5 weeks of 8), 24-hour days, a 360-day year.
export const CLOCK_KEY = "com.abelon.time/now"; // room metadata
export const CLOCK_HIDE_KEY = "com.abelon.time/hide"; // room: don't show the on-screen clock
export interface Clock { year: number; month: number; day: number; min: number }

export const MONTHS = ["Saelwyn", "Saelmora", "Saeleth", "Vanewyn", "Vanemora", "Vaneeth", "Thalwyn", "Thalmora", "Thaleth"];
const DAYS_IN_MONTH = 40;
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

export function addMinutes(c: Clock, minutes: number): Clock {
  let total = c.min + minutes;
  let days = Math.floor(total / 1440);
  total -= days * 1440;
  let { year, month, day } = c;
  day += days;
  while (day > DAYS_IN_MONTH) { day -= DAYS_IN_MONTH; month++; if (month > 9) { month = 1; year++; } }
  while (day < 1) { day += DAYS_IN_MONTH; month--; if (month < 1) { month = 9; year--; } }
  days = 0;
  return { year, month, day, min: total };
}
export const dateText = (c: Clock) => `${ord(c.day)} ${MONTHS[c.month - 1] ?? "?"}`;
export const timeText = (c: Clock) => `${String(Math.floor(c.min / 60)).padStart(2, "0")}:${String(c.min % 60).padStart(2, "0")}`;
export function partOfDay(min: number): string {
  const h = min / 60;
  if (h < 4) return "Deep night";
  if (h < 6) return "Before dawn";
  if (h < 7.5) return "Dawn";
  if (h < 11.5) return "Morning";
  if (h < 13.5) return "Midday";
  if (h < 17) return "Afternoon";
  if (h < 19) return "Evening";
  if (h < 21) return "Dusk";
  return "Night";
}
/** Daylight 0..1, for the sun/moon on the clock: 0 at midnight, 1 at noon. */
export const daylight = (min: number) => (1 - Math.cos((min / 1440) * Math.PI * 2)) / 2;

/** A starting point: the Almanac's current date at 08:00. */
export async function clockFromAlmanac(): Promise<Clock> {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/coldsnapdev/abelon-site/main/almanac.json?t=${Date.now()}`, { cache: "no-store" });
    const d = (await r.json()).currentDate as { day: number; month: number; year: number };
    return { year: d.year, month: d.month, day: d.day, min: 8 * 60 };
  } catch {
    return { year: 21942, month: 3, day: 27, min: 8 * 60 };
  }
}
export function validClock(c: unknown): c is Clock {
  const x = c as Clock;
  return !!x && [x.year, x.month, x.day, x.min].every((n) => Number.isFinite(n)) && x.month >= 1 && x.month <= 9 && x.day >= 1 && x.day <= DAYS_IN_MONTH;
}
