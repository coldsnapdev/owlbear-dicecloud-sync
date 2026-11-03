// "This is…": link the selected token(s) to someone in the cast, or make someone new.
import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { addExtra, CAST_LINK_KEY, linkedPerson, linkTokens, loadCast, NAMER_KEY, search, slug, suggestSurname, type NamerData, type Person } from "./cast";
import { applyStatBlock } from "./combat";
import { FORGE_KEYS } from "./forge";
import { getGitHubToken, loadBestiary, type BestiaryEntry } from "./mailbox";

import { PICKER_ID } from "./castPicker.ids";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const ids = (new URLSearchParams(location.search).get("items") ?? "").split(",").filter(Boolean);

let people: Person[] = [];
let blocks: BestiaryEntry[] = [];
let chosen: Person | undefined;

OBR.onReady(async () => {
  const items: Item[] = ids.length ? await OBR.scene.items.getItems(ids) : [];
  const first = items[0];
  const real = (first?.metadata[NAMER_KEY] as NamerData | undefined)?.realName;
  $("sub").textContent = items.length > 1 ? `${items.length} tokens` : first ? `Token: ${first.name}${real && real !== first.name ? ` (really ${real})` : ""}` : "";
  const d = first?.metadata[NAMER_KEY] as NamerData | undefined;
  if (d) ($("hide") as HTMLInputElement).checked = d.hidden;
  const token = getGitHubToken();
  const [cast, best] = await Promise.all([loadCast(true), loadBestiary(token).catch(() => [])]);
  people = cast.people;
  blocks = [...best].sort((a, b) => a.name.localeCompare(b.name));
  ($("n-block") as HTMLSelectElement).innerHTML =
    `<option value="">No stat block</option>` + blocks.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.cr !== undefined && !/\bCR\b/.test(b.name) ? ` (CR ${b.cr})` : ""}</option>`).join("");
  const q = $("q") as HTMLInputElement;
  chosen = first ? linkedPerson(people, first) : undefined;
  q.value = chosen ? chosen.name : (real || first?.name || "").replace(/\s*\d+$/, "");
  render();
  q.focus();
  q.select();
});

function blockName(id?: string | null) {
  return id ? blocks.find((b) => b.id === id)?.name ?? id : "";
}
function render() {
  const q = ($("q") as HTMLInputElement).value;
  const hits = search(people, q).slice(0, 60);
  $("list").innerHTML = hits.length
    ? hits
        .map(
          (p) => `<div class="p ${chosen?.id === p.id ? "sel" : ""}" data-id="${esc(p.id)}">
            <span><b>${esc(p.name)}</b>${p.extra ? `<span class="new">NEW</span>` : ""}${p.aka?.length ? `<span class="aka">${esc(p.aka.join(", "))}</span>` : ""}</span>
            <span class="blk">${esc(blockName(p.statBlock))}</span>
            <span class="who">${esc([p.gender, p.species].filter(Boolean).join(" "))}${p.role ? ` · ${esc(p.role)}` : ""}</span>
          </div>`,
        )
        .join("")
    : `<div class="empty">Nobody in the cast matches. Add them under "Someone new".</div>`;
  if (!hits.length) {
    ($("new") as HTMLDetailsElement).open = true;
    const n = $("n-name") as HTMLInputElement;
    if (!n.value) n.value = q.trim();
  }
  syncGo();
}
function syncGo() {
  const fresh = ($("new") as HTMLDetailsElement).open && ($("n-name") as HTMLInputElement).value.trim();
  const go = $("go") as HTMLButtonElement;
  go.disabled = !chosen && !fresh;
  go.textContent = chosen ? `Choose ${chosen.name}` : fresh ? "Add & choose" : "Choose";
}

$("q").addEventListener("input", () => {
  chosen = undefined;
  render();
});
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const top = search(people, ($("q") as HTMLInputElement).value)[0];
    if (!chosen && top) chosen = top;
    if (chosen) void finish();
  }
  if (e.key === "Escape") void OBR.modal.close(PICKER_ID);
});
$("list").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".p");
  if (!row) return;
  chosen = people.find((p) => p.id === row.dataset.id);
  ($("new") as HTMLDetailsElement).open = false;
  render();
});
$("list").addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest(".p") && chosen) void finish();
});
$("new").addEventListener("toggle", () => {
  if (($("new") as HTMLDetailsElement).open) chosen = undefined;
  render();
});
$("n-name").addEventListener("input", syncGo);
$("n-surname").addEventListener("click", () => {
  const n = $("n-name") as HTMLInputElement;
  const first = n.value.trim().split(/\s+/)[0] || "";
  if (!first) return;
  n.value = `${first} ${suggestSurname(people, first)}`;
  syncGo();
});
$("cancel").addEventListener("click", () => void OBR.modal.close(PICKER_ID));
$("go").addEventListener("click", () => void finish());

async function finish() {
  const msg = $("msg");
  try {
    let person = chosen;
    if (!person) {
      const name = ($("n-name") as HTMLInputElement).value.trim().replace(/\s+/g, " ");
      if (!name) return;
      if (people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        msg.textContent = `${name} is already in the cast: pick them from the list.`;
        msg.className = "msg warn";
        return;
      }
      const parts = name.split(" ");
      person = {
        id: slug(name),
        name,
        aka: parts.length > 1 ? [parts[0]] : [],
        gender: ($("n-gender") as HTMLSelectElement).value,
        species: ($("n-species") as HTMLInputElement).value.trim() || null,
        statBlock: ($("n-block") as HTMLSelectElement).value || null,
      };
      await addExtra(person);
    }
    const hide = ($("hide") as HTMLInputElement).checked;
    await linkTokens(ids, person, hide);
    // a token with no stats yet gets the person's stat block (at full HP); one that already
    // has stats keeps them: the panel shows the person's block and can apply it
    const entry = person.statBlock ? blocks.find((b) => b.id === person!.statBlock) : undefined;
    if (entry) {
      const bare = (await OBR.scene.items.getItems(ids)).filter((i) => !(Number(i.metadata[FORGE_KEYS.maxHP]) > 0));
      for (const it of bare) await applyStatBlock(it.id, entry.forge as Record<string, unknown>);
    }
    void CAST_LINK_KEY;
    await OBR.modal.close(PICKER_ID);
  } catch (err) {
    msg.textContent = `Couldn't do that: ${err instanceof Error ? err.message : String(err)}`;
    msg.className = "msg warn";
  }
}
