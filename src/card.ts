// The scene's title card: fades in over the map, holds, fades out, then closes itself.
import OBR from "@owlbear-rodeo/sdk";
import { CARD_ID } from "./cardShared";

const q = new URLSearchParams(location.search);
const title = q.get("t") ?? "";
const sub = q.get("s") ?? "";
document.getElementById("t")!.textContent = title;
const s = document.getElementById("s")!;
s.textContent = sub;
if (!sub) s.remove();
const card = document.getElementById("card")!;
const run = () => {
  card.classList.add("play");
  setTimeout(() => {
    if (q.get("demo")) return;
    OBR.onReady(() => void OBR.modal.close(CARD_ID));
  }, 5400);
};
// wait for the fonts so the title doesn't jump mid-fade
(document.fonts?.ready ?? Promise.resolve()).then(() => setTimeout(run, 60));
