// The combat strip across the top of everyone's screen: turn order, HP, AC, statuses.
// Players see public information only (NPC HP as a bar, never numbers or AC; hidden tokens
// left out). The GM also gets the controls: click an NPC to roll its initiative (or select
// it once rolled), click a party member to type theirs, right-click for more, and
// Start/Next/Back/End plus "Roll NPCs".
import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { COMBAT_KEY, endCombat, getState, partyIds, removeFromCombat, setInit, step, units, type CombatState, type Unit } from "./combat";
import { DICE_CHANNEL, type ShownRoll } from "./diceTypes";
import { GM_STATUS_KEY } from "./stripKeys";
import { getGitHubToken, loadAssignments, loadBestiary, type Assignments, type BestiaryEntry } from "./mailbox";

const strip = document.getElementById("strip")!;
let gm = false;
let items: Item[] = [];
let party = new Set<string>();
let state: CombatState = { round: 0 };
let editing: string | undefined;
let menuFor: string | undefined;
let endArmed = false;

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
  const init =
    editing === u.id
      ? `<span class="init editing"><input type="number" class="init-in" value="${u.init ?? ""}" /></span>`
      : `<span class="init ${u.init === undefined ? "none" : ""}">${u.init ?? "–"}</span>`;
  const bar = pct !== undefined ? `<div class="hp ${tone}"><i style="width:${pct.toFixed(0)}%"></i>${u.tempHp ? "<b></b>" : ""}</div>` : "";
  const stats = showNums
    ? `<div class="stats">
        <div class="stat hpv ${tone}"><small>HP</small><span>${u.hp ?? "–"}${u.tempHp ? `<em>+${u.tempHp}</em>` : ""}</span></div>
        <div class="stat acv"><small>AC</small><span>${u.ac ?? "–"}</span></div>
      </div>${bar}`
    : `<div class="stats npc-only">${bar || ""}</div>`;
  const below =
    menuFor === u.id
      ? `<div class="menu">${u.party ? "" : `<button data-m="roll">Roll</button>`}<button data-m="set">Set</button><button data-m="select">Select</button><button data-m="remove">Remove</button><button data-m="close">×</button></div>`
      : sts.length
        ? `<div class="sts">${sts.map((st) => `<span class="${"dm" in st && st.dm ? "dm" : ""}" style="background:${esc(st.c)}">${esc(st.t)}</span>`).join("")}</div>`
        : "";
  return `<div class="chip ${u.party ? "party" : "npc"} ${turn ? "turn" : ""} ${u.visible ? "" : "hidden"}" data-id="${esc(u.id)}" title="${esc(name)}${showNums && u.maxHp ? ` · ${u.hp}/${u.maxHp} HP` : ""}">
    <div class="shield"><div class="rim"></div><div class="face">
      ${init}
      <div class="name">${esc(name)}</div>
      ${stats}
    </div></div>
    ${below}
  </div>`;
}

function render() {
  const list = units(items, party).filter((u) => gm || u.visible);
  document.body.classList.toggle("gm", gm);
  const ctl = gm
    ? `<div class="ctl">
        <div class="round">${state.turn ? `Round ${state.round || 1}` : "Combat"}</div>
        <div class="row"><button data-c="prev" title="Back a turn">◀</button><button class="next" data-c="next">${state.turn ? "Next ▶" : "Start ▶"}</button></div>
        <div class="row"><button data-c="roll-npcs" title="Roll initiative for every NPC without one">Roll NPCs</button><button class="${endArmed ? "armed" : ""}" data-c="end">${endArmed ? "Sure?" : "End"}</button></div>
      </div>`
    : state.turn
      ? `<div class="round-pill">Round ${state.round || 1}</div>`
      : "";
  strip.innerHTML = `<div class="chips">${list.map(chip).join("")}</div>${ctl}`;
  const input = strip.querySelector<HTMLInputElement>(".init-in");
  if (input) {
    input.focus();
    input.select();
    const save = () => {
      const v = input.value.trim();
      const id = editing!;
      editing = undefined;
      if (v !== "" && Number.isFinite(Number(v))) setInit(id, Math.round(Number(v)));
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") {
        editing = undefined;
        render();
      }
    });
    input.addEventListener("blur", save);
  }
  // the turn chip always in view
  strip.querySelector(".chip.turn")?.scrollIntoView({ block: "nearest", inline: "center" });
  reportWidth(list.length);
}

// the background sizes the popover to fit
let lastCount = -1;
function reportWidth(n: number) {
  if (n === lastCount) return;
  lastCount = n;
  OBR.broadcast.sendMessage("com.abelon.combat/strip-size", { count: n }, { destination: "LOCAL" });
}

// --- GM: initiative --------------------------------------------------------------------
let bestiary: BestiaryEntry[] | undefined;
let assignments: Assignments = {};
async function loadBooks() {
  if (bestiary) return;
  const token = getGitHubToken();
  [bestiary, assignments] = await Promise.all([loadBestiary(token).catch(() => []), loadAssignments(token).catch(() => ({}))]);
}
const norm = (s: string) => s.trim().toLowerCase();
function entryFor(u: Unit): BestiaryEntry | undefined {
  const chosen = assignments[u.id];
  if (chosen) {
    const e = bestiary?.find((b) => b.id === chosen);
    if (e) return e;
  }
  const byName = new Map((bestiary ?? []).map((e) => [norm(e.name), e]));
  for (const n of [u.realName, u.name]) {
    if (!n) continue;
    const hit = byName.get(norm(n)) ?? byName.get(norm(n.replace(/\s*\d+$/, "")));
    if (hit) return hit;
  }
  return undefined;
}
async function initBonus(u: Unit): Promise<number> {
  const item = items.find((i) => i.id === u.id);
  const own = Number(item?.metadata["com.battle-system.forge/Z018"]);
  if (Number.isFinite(own) && own > 0) return Math.floor((own - 10) / 2);
  await loadBooks();
  const dex = Number((entryFor(u)?.forge as Record<string, unknown> | undefined)?.["com.battle-system.forge/Z018"]);
  return Number.isFinite(dex) && dex > 0 ? Math.floor((dex - 10) / 2) : 0;
}
const d20 = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return (b[0] % 20) + 1;
};
const signed = (n: number) => (n === 0 ? "" : n > 0 ? ` + ${n}` : ` − ${-n}`);

async function rollInit(list: Unit[]) {
  if (!list.length) return;
  const rolls = await Promise.all(list.map(async (u) => ({ u, d: d20(), mod: await initBonus(u) })));
  await OBR.scene.items.updateItems(
    rolls.map((r) => r.u.id),
    (its) => {
      for (const it of its) {
        const r = rolls.find((x) => x.u.id === it.id)!;
        it.metadata["com.battle-system.forge/init"] = String(r.d + r.mod);
      }
    },
  );
  // visible dice: tokens the players can see roll for the table, hidden ones for the GM only
  for (const [group, destination] of [
    [rolls.filter((r) => r.u.visible), "ALL"],
    [rolls.filter((r) => !r.u.visible), "LOCAL"],
  ] as const) {
    if (!group.length) continue;
    const one = group.length === 1 ? group[0] : undefined;
    const roll: ShownRoll = {
      id: crypto.randomUUID(),
      who: one ? one.u.name : "Initiative",
      action: one ? "Initiative" : "",
      dice: group.slice(0, 12).map((r) => ({ sides: 20, value: r.d, tint: "brass" })),
      mod: one?.mod,
      results: group.map((r) => ({ value: r.d + r.mod, label: one ? "initiative" : r.u.name })),
      detail: group.map((r) => `${group.length > 1 ? `${r.u.name}: ` : ""}d20 ${r.d}${signed(r.mod)}`).join(" · "),
      private: destination === "LOCAL",
    };
    await OBR.broadcast.sendMessage(DICE_CHANNEL, roll, { destination });
  }
}

strip.addEventListener("click", async (e) => {
  if (!gm) return;
  const t = e.target as HTMLElement;
  const c = t.closest<HTMLElement>("[data-c]")?.dataset.c;
  if (c === "next") return step(1);
  if (c === "prev") return step(-1);
  if (c === "roll-npcs") return rollInit(units(items, party).filter((u) => !u.party && u.init === undefined));
  if (c === "end") {
    if (!endArmed) {
      endArmed = true;
      render();
      setTimeout(() => {
        endArmed = false;
        render();
      }, 3000);
      return;
    }
    endArmed = false;
    return endCombat();
  }
  const id = t.closest<HTMLElement>(".chip")?.dataset.id;
  if (!id || t.closest(".init-in")) return;
  const u = units(items, party).find((x) => x.id === id);
  if (!u) return;
  const m = t.closest<HTMLElement>("[data-m]")?.dataset.m;
  if (m) {
    menuFor = undefined;
    if (m === "roll") await rollInit([u]);
    if (m === "set") editing = u.id;
    if (m === "select") await OBR.player.select([u.id]);
    if (m === "remove") await removeFromCombat([u.id]);
    return render();
  }
  if (menuFor === id) return;
  if (u.party) editing = u.id;
  else if (u.init === undefined) await rollInit([u]);
  else await OBR.player.select([u.id]);
  render();
});
strip.addEventListener("contextmenu", (e) => {
  if (!gm) return;
  const id = (e.target as HTMLElement).closest<HTMLElement>(".chip")?.dataset.id;
  if (!id) return;
  e.preventDefault();
  menuFor = menuFor === id ? undefined : id;
  editing = undefined;
  render();
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
    if (!editing) render();
  });
  OBR.scene.onMetadataChange(async (m) => {
    state = (m[COMBAT_KEY] as CombatState | undefined) ?? { round: 0 };
    party = await partyIds();
    if (!editing) render();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === GM_STATUS_KEY && !editing) render();
  });
});
