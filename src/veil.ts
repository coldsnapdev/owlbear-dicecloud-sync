// The players' black screen while a scene is being set. On the reveal, the title card plays over
// the black and the map fades in behind it; the background closes this page afterwards.
import OBR from "@owlbear-rodeo/sdk";
import { VEIL_HELLO, VEIL_LIFT, type VeilMsg } from "./veilShared";

const black = document.getElementById("black")!;
const card = document.getElementById("card")!;
const t = document.getElementById("t")!;
const s = document.getElementById("s")!;
const demo = new URLSearchParams(location.search).get("demo");

function apply(m: VeilMsg) {
  if (m.show) {
    document.body.classList.remove("lifting");
    black.classList.remove("gone", "slow");
    card.classList.remove("play");
    return;
  }
  document.body.classList.add("lifting");
  if (m.title) {
    t.textContent = m.title;
    s.textContent = m.sub ?? "";
    s.style.display = m.sub ? "" : "none";
    card.classList.remove("play");
    void card.offsetWidth; // restart the animation
    card.classList.add("play");
    black.classList.add("slow");
  }
  black.classList.add("gone");
}

if (demo) {
  // ?demo=1&t=Title&s=Sub: lift after a moment, for previewing outside Owlbear
  const q = new URLSearchParams(location.search);
  setTimeout(() => apply({ show: false, title: q.get("t") ?? undefined, sub: q.get("s") ?? undefined }), 1200);
} else {
  OBR.onReady(() => {
    OBR.broadcast.onMessage(VEIL_LIFT, (ev) => {
      const m = ev.data as VeilMsg;
      if (m.show || !m.title) return apply(m);
      // wait for the fonts so the title doesn't jump mid-fade
      void (document.fonts?.ready ?? Promise.resolve()).then(() => apply(m));
    });
    void OBR.broadcast.sendMessage(VEIL_HELLO, {}, { destination: "LOCAL" });
  });
}
