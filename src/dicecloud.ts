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
  /** Current temporary HP, if any (0 when none is up). Undefined only if the sheet has no tempHP attribute at all. */
  tempHP?: number;
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
 * Fetches a creature's raw computed sheet (creature record + the full
 * creatureProperties array). Shared by fetchCreatureStats and
 * fetchCompanionStats so both pay for exactly one request/parse.
 *
 * Pass `token` for a sheet that isn't flagged public (the normal case —
 * see README). Omit it only for a sheet explicitly marked Public.
 */
async function fetchCreatureSheet(
  creatureId: string,
  token?: string
): Promise<{ creature: any; props: any[] }> {
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
  // DiceCloud's live response isn't always wrapped in a `data` envelope the
  // way the develop-branch source implies — tolerate both shapes.
  const data = body.data ?? body;
  return {
    creature: data?.creatures?.[0],
    props: data?.creatureProperties ?? [],
  };
}

function findAttribute(props: any[], variableName: string): any | undefined {
  return props.find(
    (p) => p?.type === "attribute" && p?.variableName === variableName && !p?.removed
  );
}

/**
 * Fetches a creature's computed sheet and pulls out current HP, max HP, AC,
 * and current temporary HP — the character's own stats, not a companion's
 * (see fetchCompanionStats for that).
 *
 * HP comes from the non-removed attribute with attributeType "healthBar"
 * AND variableName "hitPoints" (`.value` = current, `.total` = max) — a
 * sheet can have more than one healthBar attribute (Temporary Hit Points is
 * its own healthBar with variableName "tempHP", and e.g. a Ranger's animal
 * companion can add a custom one like "Companion HP"), and those can appear
 * earlier in the response's creatureProperties array than the character's
 * real HP bar. Matching by variableName targets the actual main HP bar
 * regardless of array order or how many other healthBar attributes the
 * sheet has. AC comes from the attribute named "armor", which is a fixed
 * convention baked into DiceCloud's own attack-resolution engine, not a
 * per-sheet choice. Temp HP comes from the "tempHP" healthBar's `.value` —
 * DiceCloud doesn't give temp HP a meaningful "max", so `.total` is ignored.
 */
export async function fetchCreatureStats(
  creatureId: string,
  token?: string
): Promise<CreatureStats> {
  const { creature, props } = await fetchCreatureSheet(creatureId, token);

  const hpBar = findAttribute(props, "hitPoints");
  const acStat = findAttribute(props, "armor");
  const tempHPBar = findAttribute(props, "tempHP");

  return {
    name: creature?.name,
    currentHP: numberOrUndefined(hpBar?.value),
    maxHP: numberOrUndefined(hpBar?.total),
    ac: numberOrUndefined(acStat?.value),
    tempHP: numberOrUndefined(tempHPBar?.value),
  };
}

/**
 * Fetches the stats for a character's summoned companion (currently: a
 * Ranger's Primal Companion) rather than the character themself.
 *
 * HP comes from the "companionHP" healthBar attribute, same shape as the
 * character's own HP. AC is NOT a stored attribute on the sheet — DiceCloud
 * only has it as stat-block description text ("AC 13 + wisdom.modifier"),
 * not a real value — so it's computed here from the Beast of the Land
 * formula (13 + the character's own Wisdom modifier). This is specific to
 * that one companion stat block; a different companion type (Beast of the
 * Sea/Sky, a different class's companion/familiar, etc.) would need its own
 * formula added here if/when it comes up — there's no generic way to read
 * companion AC straight off the sheet.
 */
export async function fetchCompanionStats(
  creatureId: string,
  token?: string
): Promise<CreatureStats> {
  const { props } = await fetchCreatureSheet(creatureId, token);

  const hpBar = findAttribute(props, "companionHP");
  const wisdom = findAttribute(props, "wisdom");
  const wisdomModifier = numberOrUndefined(wisdom?.modifier);

  return {
    name: hpBar?.name, // e.g. "Companion HP" — better than nothing for logging
    currentHP: numberOrUndefined(hpBar?.value),
    maxHP: numberOrUndefined(hpBar?.total),
    ac: wisdomModifier !== undefined ? 13 + wisdomModifier : undefined,
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
