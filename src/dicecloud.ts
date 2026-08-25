// Minimal client for DiceCloud v2's REST API.
//
// This isn't a documented/supported public API — it was found by reading
// DiceCloud's own open-source server code (ThaumRystra/DiceCloud, develop
// branch) and confirmed by testing against a real character sheet. It could
// change without notice; see the project's README for details.

const DICECLOUD_BASE = "https://dicecloud.com";

export interface DiceCloudSession {
  userId: string;
  token: string;
  /** ISO date string. */
  tokenExpires: string;
}

export interface CreatureStats {
  name?: string;
  currentHP?: number;
  maxHP?: number;
  ac?: number;
}

/**
 * Logs in with a DiceCloud username/email + password and returns a bearer
 * token. Intended to be called once with a dedicated "reader" account that
 * has been added as a Reader on each party member's sheet — not with a
 * player's own account.
 */
export async function diceCloudLogin(
  usernameOrEmail: string,
  password: string
): Promise<DiceCloudSession> {
  const isEmail = usernameOrEmail.includes("@");
  const res = await fetch(`${DICECLOUD_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      isEmail
        ? { email: usernameOrEmail, password }
        : { username: usernameOrEmail, password }
    ),
  });

  if (!res.ok) {
    const body = await safeJson(res);
    throw new Error(
      `DiceCloud login failed (${res.status}): ${body?.reason ?? body?.error ?? res.statusText}`
    );
  }

  const body = await res.json();
  const data = body.data ?? body;
  return { userId: data.id, token: data.token, tokenExpires: data.tokenExpires };
}

/**
 * Fetches a creature's computed sheet and pulls out current HP, max HP,
 * and AC.
 *
 * HP comes from the first non-removed attribute with attributeType
 * "healthBar" (`.value` = current, `.total` = max) — the same property
 * DiceCloud's own tabletop/dashboard view uses to render party HP bars.
 * AC comes from the attribute named "armor", which is a fixed convention
 * baked into DiceCloud's own attack-resolution engine, not a per-sheet
 * choice.
 *
 * Pass `token` for a sheet that isn't flagged public (the normal case —
 * see README). Omit it only for a sheet explicitly marked Public.
 */
export async function fetchCreatureStats(
  creatureId: string,
  token?: string
): Promise<CreatureStats> {
  // Deliberately NOT sent as an `Authorization: Bearer <token>` header.
  // DiceCloud's REST framework (simple:rest) only attaches CORS headers to
  // a request when there's an explicit route registered for that exact
  // method + path — and DiceCloud registered a GET handler for
  // /api/creature/:id but never an OPTIONS one. Any header that isn't on
  // the CORS-safelist (Authorization included) forces the browser to send
  // a preflight OPTIONS request first, which then hits no route, gets no
  // CORS headers back, and gets blocked — confirmed against a live
  // request. The same framework also accepts the token as a URL query
  // parameter (?access_token=...), which is NOT a preflight trigger, so
  // this sidesteps the gap entirely without needing anything from
  // DiceCloud's side.
  const url = new URL(`${DICECLOUD_BASE}/api/creature/${creatureId}`);
  if (token) url.searchParams.set("access_token", token);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const body = await safeJson(res);
    throw new Error(
      `DiceCloud fetch failed for ${creatureId} (${res.status}): ${
        body?.reason ?? body?.error ?? res.statusText
      }`
    );
  }

  const body = await res.json();

  // Temporary diagnostic: the previous round showed `data.creatures[0]`
  // coming back undefined for every character tried, which means the
  // *shape* we're assuming (body.data.creatures[...]) is wrong somewhere,
  // not any one sheet's contents. Log the actual top-level shape of what
  // came back instead of guessing at another field path. Filter the
  // console to "dicecloud-raw" to find this.
  console.log(`[dicecloud-raw] creature ${creatureId}: top-level keys of response body:`, Object.keys(body ?? {}));
  console.log(`[dicecloud-raw] creature ${creatureId}: full response body:`, JSON.stringify(body).slice(0, 2000));

  const data = body.data ?? body;
  const creature = data?.creatures?.[0];
  const props: any[] = data?.creatureProperties ?? [];

  console.log(`[dicecloud-raw] creature ${creatureId}: keys of "data":`, Object.keys(data ?? {}));

  const hpBar = props.find(
    (p) => p?.type === "attribute" && p?.attributeType === "healthBar" && !p?.removed
  );
  const acStat = props.find(
    (p) => p?.type === "attribute" && p?.variableName === "armor" && !p?.removed
  );

  return {
    name: creature?.name,
    currentHP: numberOrUndefined(hpBar?.value),
    maxHP: numberOrUndefined(hpBar?.total),
    ac: numberOrUndefined(acStat?.value),
  };
}

/** Extracts a DiceCloud creature id from either a raw id or a full sheet URL. */
export function parseCreatureId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const match = trimmed.match(/dicecloud\.com\/character\/([^/]+)/i);
  return match ? match[1] : trimmed;
}

async function safeJson(res: Response): Promise<any | undefined> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
