import OBR from "@owlbear-rodeo/sdk";
import { CLOCK_KEY, dateText, daylight, partOfDay, timeText, validClock, type Clock } from "./clock";

function draw(c: Clock) {
  const light = daylight(c.min);
  const day = c.min >= 6 * 60 && c.min < 19.5 * 60;
  // the sky: deep night blue through dawn rose to day blue; the sun or moon rides the arc
  const sky = day
    ? `linear-gradient(180deg, hsl(205,${40 + light * 25}%,${28 + light * 34}%), hsl(${light > 0.7 ? 200 : 25},${45 + light * 10}%,${36 + light * 30}%))`
    : "linear-gradient(180deg, #0d1426, #1d2540)";
  document.getElementById("sky")!.style.background = sky;
  const orb = document.getElementById("orb")!;
  // the sun climbs with the daylight; the moon climbs with the dark
  orb.style.top = `${Math.round(24 - (day ? light : 1 - light) * 18)}px`;
  orb.style.background = day ? "#ffd979" : "#e8eef8";
  orb.style.boxShadow = day ? "0 0 8px 2px rgba(255,210,110,.75)" : "inset -3px -1px 0 0 #9aa6bd, 0 0 6px rgba(220,230,255,.5)";
  document.getElementById("part")!.innerHTML = `${partOfDay(c.min)}<b>${timeText(c)}</b>`;
  document.getElementById("date")!.textContent = dateText(c);
  document.getElementById("plate")!.classList.add("on");
}

const demo = new URLSearchParams(location.search).get("demo");
if (demo) {
  const [d, m, hh, mm] = demo.split(/[^0-9]+/).map(Number);
  draw({ year: 21942, month: m, day: d, min: hh * 60 + mm });
} else {
  OBR.onReady(async () => {
    const show = (meta: Record<string, unknown>) => {
      const c = meta[CLOCK_KEY];
      if (validClock(c)) draw(c);
    };
    show(await OBR.room.getMetadata());
    OBR.room.onMetadataChange(show);
  });
}
