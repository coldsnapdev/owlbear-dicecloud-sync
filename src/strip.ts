// The combat strip across the top of everyone's screen: turn order, HP, AC, statuses.
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
function chip(u: Unit): string {
  const turn = state.turn === u.id;
  const showNums = gm || u.party;
  const pct = u.maxHp ? Math.max(0, Math.min(100, ((u.hp ?? 0) / u.maxHp) * 100)) : undefined;
  const tone = pct === undefined ? "" : pct <= 25 ? "low" : pct <= 50 ? "mid" : "";
  const sts = gm ? gmStatuses()[u.id] ?? [] : state.statuses?.[u.id] ?? [];
  const name = gm && u.realName && u.realName !== u.name ? u.realName : u.name;
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
  return `<div class="chip ${u.party ? "party" : "npc"} ${turn ? "turn" : ""} ${u.visible ? "" : "hidden"}" data-id="${esc(u.id)}" title="${esc(name)}${showNums && u.maxHp ? ` · ${u.hp}/${u.maxHp} HP` : ""}">
    <div class="shield"><div class="rim"></div><div class="face">
      ${init}
      <div class="name">${esc(fitName(name))}</div>
      ${stats}
    </div></div>
    ${below}
  </div>`;
}

function render() {
  const list = units(items, party).filter((u) => gm || u.visible);
  document.body.classList.toggle("gm", gm);
  const arrows = gm && list.length;
  const round = state.turn ? `<div class="round-box">Round ${state.round || 1}</div>` : gm && list.length ? `<div class="round-box idle">Press ▶ to start</div>` : "";
  strip.innerHTML = `<div class="line">
      ${arrows ? `<button class="arrow" data-c="prev" title="Back a turn">‹</button>` : ""}
      <div class="chips">${list.map(chip).join("")}</div>
      ${arrows ? `<button class="arrow next" data-c="next" title="${state.turn ? "Next turn" : "Start combat"}">›</button>` : ""}
    </div>${round}`;
  strip.querySelector(".chip.turn")?.scrollIntoView({ block: "nearest", inline: "center" });
  reportWidth(list.length);
}

// Names that fit the shield: the full name if it fits; otherwise a named character's first
// name, or for numbered creatures ("Rot Skulker 4") their initials and number ("RS 4").
const measure = document.createElement("canvas").getContext("2d")!;
const NAME_FONT = '700 15px "Crimson Pro", Georgia, serif';
const NAME_W = 82;
function fitName(full: string): string {
  measure.font = NAME_FONT;
  const fits = (s: string) => measure.measureText(s).width <= NAME_W;
  if (fits(full)) return full;
  const numbered = full.match(/^(.*?)\s*(\d+)$/);
  if (numbered) {
    const initials = numbered[1].split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("");
    return `${initials} ${numbered[2]}`;
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
