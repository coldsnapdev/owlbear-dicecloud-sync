// The combat strip across the top of everyone's screen: turn order, HP, AC, statuses.
// It rolls like a carousel: the active combatant sits in the middle, larger, with those who've
// just acted to the left and those coming up to the right (the extra one on the right when the
// count is even). Each move of the turn slides every shield one place left; the one falling
// off the left end fades back in at the far right.
// Players see public information only (NPC HP as a bar, never numbers or AC; hidden tokens
// left out). The GM also gets arrows either side to move the turn; clicking a shield selects
// its token. Initiative is rolled and entered in the DM panel.
import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { COMBAT_KEY, getState, partyIds, step, units, type CombatState, type Unit } from "./combat";
import { GM_STATUS_KEY } from "./stripKeys";

const strip = document.getElementById("strip")!;
let gm = false;
let items: Item[] = [];
let party = new Set<string>();
let state: CombatState = { round: 0 };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function gmStatuses(): Record<string, { t: string; c: string; dm?: boolean }[]> {
  try {
    return JSON.parse(localStorage.getItem(GM_STATUS_KEY) || "{}");
  } catch {
    return {};
  }
}

// Each combatant is a small heraldic shield: initiative in a pip at the top, the name, then
// HP and AC large. Players see only a bar for enemies. Statuses (and the GM's menu) hang
// beneath the shield.
function chip(u: Unit, roundLabel?: string): string {
  const turn = state.turn === u.id;
  const showNums = gm || u.party;
  const pct = u.maxHp ? Math.max(0, Math.min(100, ((u.hp ?? 0) / u.maxHp) * 100)) : undefined;
  const tone = pct === undefined ? "" : pct <= 25 ? "low" : pct <= 50 ? "mid" : "";
  const sts = gm ? gmStatuses()[u.id] ?? [] : state.statuses?.[u.id] ?? [];
  // the name the players know, for the GM too, so a real name can't slip out by accident
  const name = u.name;
  const init = `<span class="init ${u.init === undefined ? "none" : ""}">${u.init ?? "–"}</span>`;
  const bar = pct !== undefined ? `<div class="hp ${tone}"><i style="width:${pct.toFixed(0)}%"></i>${u.tempHp ? "<b></b>" : ""}</div>` : "";
  const stats = showNums
    ? `<div class="stats">
        <div class="stat hpv ${tone}"><small>HP</small><span>${u.hp ?? "–"}${u.tempHp ? `<em>+${u.tempHp}</em>` : ""}</span></div>
        <div class="stat acv"><small>AC</small><span>${u.ac ?? "–"}</span></div>
      </div>${bar}`
    : `<div class="stats npc-only">${bar || ""}</div>`;
  const below = sts.length
        ? `<div class="sts">${sts.map((st) => `<span class="${"dm" in st && st.dm ? "dm" : ""}" style="background:${esc(st.c)}">${esc(st.t)}</span>`).join("")}</div>`
        : "";
  const label = roundLabel ? `<div class="rnd ${turn ? "now" : ""}">${roundLabel}</div>` : "";
  return `<div class="shield"><div class="rim"></div><div class="face">
      ${init}
      <div class="name">${esc(fitName(name))}</div>
      ${stats}
    </div></div>
    ${label}${below}`;
}

// slot geometry: shields are 96 wide; the active one is scaled up
const W = 96;
const GAP = 8;
const ACTIVE = 1.22;
const NEAR = 0.97;
const FAR = 0.9;
const scaleFor = (k: number, live: boolean) => (!live ? 1 : k === 0 ? ACTIVE : Math.abs(k) === 1 ? NEAR : FAR);
function offsetFor(k: number, live: boolean): number {
  if (!live || k === 0) return k * (W + GAP);
  const sign = Math.sign(k);
  let x = (W * scaleFor(0, live)) / 2 + GAP + (W * scaleFor(sign, live)) / 2;
  for (let i = 2; i <= Math.abs(k); i++) x += (W * scaleFor(sign * (i - 1), live)) / 2 + GAP + (W * scaleFor(sign * i, live)) / 2;
  return sign * x;
}

const stage = document.createElement("div");
stage.className = "stage";
const els = new Map<string, HTMLElement>();
const lastSlot = new Map<string, number>();

function render() {
  const order = units(items, party);
  const list = order.filter((u) => gm || u.visible);
  document.body.classList.toggle("gm", gm);
  const n = list.length;
  const live = !!state.turn && n > 0;
  // who's in the middle: the active combatant (for players, if it's hidden from them, the
  // next one they can see, shown at normal size)
  let centre = 0;
  if (live) {
    const at = order.findIndex((u) => u.id === state.turn);
    for (let i = 0; i < order.length; i++) {
      const u = order[(Math.max(0, at) + i) % order.length];
      const j = list.findIndex((x) => x.id === u.id);
      if (j >= 0) {
        centre = j;
        break;
      }
    }
  }
  const left = Math.floor((n - 1) / 2);
  const slots = new Map<string, number>();
  list.forEach((u, i) => {
    let k = live ? (i - centre + n) % n : i - (n - 1) / 2;
    if (live && k > n - 1 - left) k -= n; // the just-been side
    slots.set(u.id, k);
  });
  const first = order.find((u) => gm || u.visible);
  const round = state.round || 1;

  if (!strip.contains(stage)) {
    strip.innerHTML = "";
    strip.appendChild(stage);
  }
  const seen = new Set<string>();
  for (const u of list) {
    seen.add(u.id);
    const k = slots.get(u.id)!;
    const isActive = live && u.id === state.turn;
    // Round X under the active shield; Round X+1 under the top of the order when it's still to come
    const label = isActive ? `Round ${round}` : live && first?.id === u.id && k > 0 ? `Round ${round + 1}` : undefined;
    let el = els.get(u.id);
    const fresh = !el;
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = u.id;
      stage.appendChild(el);
      els.set(u.id, el);
    }
    el.className = `chip ${u.party ? "party" : u.ally ? "ally" : "npc"} ${isActive ? "turn" : ""} ${u.visible ? "" : "hidden"} ${live && k !== 0 && Math.abs(k) > 1 ? "far" : ""}`;
    el.title = gm && u.realName && u.realName !== u.name ? `${u.name} (really ${u.realName})` : u.name;
    el.innerHTML = chip(u, label);
    const x = offsetFor(k, live);
    const sc = scaleFor(k, live);
    const prev = lastSlot.get(u.id);
    const wrapped = prev !== undefined && Math.abs(prev - k) > 1 && live;
    const place = () => (el!.style.transform = `translateX(calc(-50% + ${x.toFixed(1)}px)) scale(${sc})`);
    if (fresh || wrapped) {
      // appear (or re-appear at the other end) without sliding across everyone
      el.style.transition = "none";
      el.style.opacity = "0";
      place();
      void el.offsetWidth;
      // fade in once the others have slid along, so it doesn't land on top of them
      el.style.transition = fresh ? "opacity .4s ease" : "opacity .4s ease .45s";
      el.style.opacity = "";
      const target = el;
      setTimeout(() => (target.style.transition = ""), 900);
    } else place();
    lastSlot.set(u.id, k);
  }
  for (const [id, el] of els) {
    if (seen.has(id)) continue;
    el.remove();
    els.delete(id);
    lastSlot.delete(id);
  }
  // arrows sit just outside the outermost shields
  // a dotted line where the order wraps: between the last in initiative and the first
  let divider = stage.querySelector<HTMLElement>(".wrap-line");
  const kLast = n ? slots.get(list[n - 1].id)! : 0;
  const kFirst = n ? slots.get(list[0].id)! : 0;
  if (live && n > 1 && kFirst - kLast === 1) {
    if (!divider) {
      divider = document.createElement("div");
      divider.className = "wrap-line";
      stage.appendChild(divider);
    }
    const gapMid = (offsetFor(kLast, live) + (W * scaleFor(kLast, live)) / 2 + offsetFor(kFirst, live) - (W * scaleFor(kFirst, live)) / 2) / 2;
    divider.style.transform = `translateX(calc(-50% + ${gapMid.toFixed(1)}px))`;
  } else divider?.remove();

  // each arrow hugs its own end of the row (the sides aren't always the same length)
  const ks = [...slots.values()];
  const leftEdge = n ? Math.min(...ks.map((k) => offsetFor(k, live) - (W * scaleFor(k, live)) / 2)) : 0;
  const rightEdge = n ? Math.max(...ks.map((k) => offsetFor(k, live) + (W * scaleFor(k, live)) / 2)) : 0;
  let prevBtn = stage.querySelector<HTMLButtonElement>(".arrow.prev");
  let nextBtn = stage.querySelector<HTMLButtonElement>(".arrow.next");
  if (gm && n) {
    if (!prevBtn) {
      prevBtn = Object.assign(document.createElement("button"), { className: "arrow prev", title: "Back a turn", textContent: "‹" });
      prevBtn.dataset.c = "prev";
      nextBtn = Object.assign(document.createElement("button"), { className: "arrow next", textContent: "›" });
      nextBtn.dataset.c = "next";
      stage.append(prevBtn, nextBtn);
    }
    prevBtn.style.transform = `translateX(calc(-50% + ${(leftEdge - 20).toFixed(0)}px))`;
    nextBtn!.style.transform = `translateX(calc(-50% + ${(rightEdge + 20).toFixed(0)}px))`;
    nextBtn!.title = live ? "Next turn" : "Start combat";
  } else {
    prevBtn?.remove();
    nextBtn?.remove();
  }
  let hint = strip.querySelector<HTMLElement>(".round-box");
  const hintText = !live && gm && n ? "Press › to start" : "";
  if (hintText && !hint) {
    hint = document.createElement("div");
    hint.className = "round-box idle";
    strip.appendChild(hint);
  }
  if (hint) {
    if (hintText) hint.textContent = hintText;
    else hint.remove();
  }
  reportWidth(n);
}

// Names that fit the shield: the full name if it fits; otherwise a named character's first
// name, or for numbered creatures the leading words cut to initials one at a time, keeping
// the kind of creature to last ("Male Gnome 1" → "M Gnome 1" → "MG 1").
const measure = document.createElement("canvas").getContext("2d")!;
const NAME_FONT = '700 15px "Crimson Pro", Georgia, serif';
const NAME_W = 82;
function fitName(full: string): string {
  measure.font = NAME_FONT;
  const fits = (s: string) => measure.measureText(s).width <= NAME_W;
  if (fits(full)) return full;
  const numbered = full.match(/^(.*?)\s*(\d+)$/);
  if (numbered) {
    // keep the creature's kind as long as possible: "Male Gnome 1" → "M Gnome 1" → "MG 1"
    const words = numbered[1].split(/\s+/).filter(Boolean);
    const initial = (ws: string[]) => ws.map((w) => w[0].toUpperCase()).join("");
    for (let i = 1; i < words.length; i++) {
      const tryName = `${initial(words.slice(0, i))} ${words.slice(i).join(" ")} ${numbered[2]}`;
      if (fits(tryName)) return tryName;
    }
    return `${initial(words)} ${numbered[2]}`;
  }
  const first = full.split(/\s+/)[0];
  return fits(first) ? first : first;
}
document.fonts?.ready.then(() => render());

// the background sizes the popover to fit
let lastCount = -1;
function reportWidth(n: number) {
  if (n === lastCount) return;
  lastCount = n;
  OBR.broadcast.sendMessage("com.abelon.combat/strip-size", { count: n }, { destination: "LOCAL" });
}

strip.addEventListener("click", async (e) => {
  if (!gm) return;
  const t = e.target as HTMLElement;
  const c = t.closest<HTMLElement>("[data-c]")?.dataset.c;
  if (c === "next") return step(1);
  if (c === "prev") return step(-1);
  const id = t.closest<HTMLElement>(".chip")?.dataset.id;
  if (id) await OBR.player.select([id]);
});

OBR.onReady(async () => {
  gm = (await OBR.player.getRole()) === "GM";
  const refresh = async () => {
    items = await OBR.scene.items.getItems();
    party = await partyIds();
    state = await getState();
    render();
  };
  await refresh();
  OBR.scene.items.onChange((its) => {
    items = its;
    render();
  });
  OBR.scene.onMetadataChange(async (m) => {
    state = (m[COMBAT_KEY] as CombatState | undefined) ?? { round: 0 };
    party = await partyIds();
    render();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === GM_STATUS_KEY) render();
  });
});
