// The overlay page: a full-screen, click-through layer on one player's own screen.
import OBR from "@owlbear-rodeo/sdk";
import { FX_CHANNEL, FX_HELLO, type Effects } from "./fxShared";

function show(e: Effects) {
  const set = (id: string, on: boolean, vars: Record<string, string> = {}) => {
    const el = document.getElementById(id)!;
    el.classList.toggle("on", on);
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  };
  const rot = e.rot ?? 0;
  set("rot", rot > 0, { "--clear": `${Math.max(14, 62 - rot * 8)}%` });
  document.getElementById("rot")!.classList.toggle("six", rot >= 6);
  set("exhaustion", (e.exhaustion ?? 0) > 0, { "--lvl": String(e.exhaustion ?? 0) });
  set("poisoned", !!e.poisoned);
  set("charmed", !!e.charmed);
  set("frightened", !!e.frightened);
  set("paralyzed", !!e.paralyzed);
  set("stunned", !!e.stunned);
  set("blinded", !!e.blinded);
  set("down", !!e.down && !e.dead);
  set("dead", !!e.dead);
}

// ?demo=rot:3,poisoned for trying the looks outside Owlbear
const demo = new URLSearchParams(location.search).get("demo");
if (demo) {
  const e: Record<string, unknown> = {};
  for (const part of demo.split(",")) {
    const [k, v] = part.split(":");
    e[k] = v ? Number(v) : true;
  }
  requestAnimationFrame(() => show(e as Effects));
} else {
  OBR.onReady(() => {
    OBR.broadcast.onMessage(FX_CHANNEL, (ev) => show(ev.data as Effects));
    OBR.broadcast.sendMessage(FX_HELLO, {}, { destination: "LOCAL" });
  });
}
