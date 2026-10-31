// Live channel for panel rolls: ntfy.sh, a free publish/subscribe relay. The panel
// POSTs the roll, and the GM's Owlbear holds an open EventSource on the same topic,
// so a roll reaches the table in a fraction of a second instead of the 2–4 s the
// GitHub mailbox takes. GitHub stays as the backup: every roll is still written
// there too, and the extension skips any roll it has already shown.
//
// The topic is derived from the GitHub token, so the panel and the GM's Owlbear find
// the same channel with no setup, and nothing secret goes in this public repo. Both
// sides show a four-character code so a token mismatch is easy to spot.
import type { PanelCommand } from "./mailbox";

const LIVE_BASE = "https://ntfy.sh";
const MAX_BODY = 3800; // ntfy turns anything over 4 KB into an attachment

export async function liveTopic(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`abelon-dice-live:${token.trim()}`));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `abelon-${hex.slice(0, 40)}`;
}

/** Short code shown in the panel and the extension: if they match, they're on the same channel. */
export const liveCode = (topic: string) => topic.slice(7, 11).toUpperCase();

/** Send a command down the live channel. False if it couldn't (offline, rate limit, too big). */
export async function publishLive(token: string, cmd: PanelCommand): Promise<boolean> {
  const body = JSON.stringify(cmd);
  if (body.length > MAX_BODY) return false;
  try {
    // query parameters rather than headers keep this a "simple" request (no CORS preflight);
    // cache=no: not stored on the relay; firebase=no: not forwarded to phone notifications
    const r = await fetch(`${LIVE_BASE}/${await liveTopic(token)}?cache=no&firebase=no`, { method: "POST", body });
    return r.ok;
  } catch {
    return false;
  }
}

export interface LiveSubscription {
  topic: string;
  close(): void;
}

/** Listen for commands on the live channel. EventSource reconnects by itself after a drop. */
export function subscribeLive(
  topic: string,
  onCommand: (cmd: PanelCommand) => void,
  onState: (state: "connecting" | "connected" | "reconnecting") => void,
): LiveSubscription {
  const es = new EventSource(`${LIVE_BASE}/${topic}/sse`);
  onState("connecting");
  es.addEventListener("open", () => onState("connected"));
  es.onerror = () => onState("reconnecting");
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as { event?: string; message?: string };
      if (msg.event !== "message" || !msg.message) return;
      const cmd = JSON.parse(msg.message) as PanelCommand;
      if (cmd && typeof cmd.id === "string" && typeof cmd.kind === "string") onCommand(cmd);
    } catch {
      // not one of ours
    }
  };
  return { topic, close: () => es.close() };
}

export const LIVE_STATUS_KEY = "dicecloud-sync/live-status";

// --- Local relay (abelon-relay.mjs on this computer) --------------------------------------
// The fastest route, and private: nothing leaves the machine. Used first whenever it's
// running; if it isn't, everything falls back to ntfy / GitHub as above.
export const RELAY = "http://127.0.0.1:47917";
export const RELAY_STATUS_KEY = "dicecloud-sync/relay-status";

export interface StatusesMessage {
  kind: "statuses";
  id: string;
  at: string;
  file: import("./mailbox").StatusFile;
}
/** Who the DM is aiming at: drawn as a ring on each target's token, for everyone to see. */
export interface TargetsMessage {
  kind: "targets";
  id: string;
  at: string;
  ids: string[];
}
/** Panel asks Owlbear to resend the live roster now (Update Roster while linked). */
export interface RosterRequest {
  kind: "roster-request";
  id: string;
  at: string;
}
export type LiveMessage = PanelCommand | StatusesMessage | TargetsMessage | RosterRequest;

/** One combatant as Owlbear sees it right now (live link only: HP never goes to GitHub). */
export interface LiveCombatant {
  itemId: string;
  name: string;
  realName?: string;
  initiative: number;
  ac?: number;
  hp?: number;
  maxHp?: number;
  tempHp?: number;
}
/** Owlbear → panel, over the direct link. */
export type OwlbearMessage =
  | { kind: "roster"; combatants: LiveCombatant[]; forgeInfo?: string }
  | { kind: "selection"; ids: string[] };

// "loopback" tells Chrome/Opera up front that this goes to this computer (local network access)
const loopback = { targetAddressSpace: "loopback" } as RequestInit;

/** Sends to the relay. Returns how many listeners got it, or -1 if the relay isn't reachable. */
export async function sendLocal(to: "owlbear" | "panel", msg: LiveMessage, timeoutMs = 600): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${RELAY}/send?to=${to}`, { ...loopback, method: "POST", body: JSON.stringify(msg), signal: ctl.signal });
    if (!r.ok) return -1;
    return ((await r.json()) as { delivered?: number }).delivered ?? 0;
  } catch {
    return -1;
  } finally {
    clearTimeout(timer);
  }
}

/** Who's on the relay right now, or undefined if it isn't running. */
export async function relayStatus(): Promise<{ owlbear: number; panel: number } | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 600);
  try {
    const r = await fetch(`${RELAY}/status`, { ...loopback, signal: ctl.signal, cache: "no-store" });
    return r.ok ? ((await r.json()) as { owlbear: number; panel: number }) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Listens on the relay. Reconnects on its own (gently: the relay is often simply not
 * running, and every failed attempt shows up in the browser console).
 */
export function listenLocal(
  role: "owlbear" | "panel",
  onMessage: (msg: LiveMessage) => void,
  onState: (state: "connected" | "not running") => void,
): { close(): void } {
  let es: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 3000;
  let closed = false;
  const connect = () => {
    if (closed) return;
    es = new EventSource(`${RELAY}/events?role=${role}`);
    es.addEventListener("hello", () => {
      delay = 3000;
      onState("connected");
    });
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as LiveMessage;
        if (msg && typeof msg.id === "string" && typeof msg.kind === "string") onMessage(msg);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      es?.close();
      onState("not running");
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    };
  };
  connect();
  return {
    close() {
      closed = true;
      clearTimeout(retry);
      es?.close();
    },
  };
}

// --- Direct link (panel opened from inside Owlbear) ---------------------------------------
// Opera/Chrome won't let a page embedded in Owlbear reach this computer, so the relay
// can't hear Owlbear's side. But when the panel is opened from the extension's own link,
// the browser hands it a reference to the Owlbear tab, and the two can message each other
// directly: no server, no relay, instant. The panel posts to every frame of the Owlbear tab;
// only our own extension's page (same origin) can receive it, and it answers each message.
export const LINK_STATUS_KEY = "dicecloud-sync/link-status";
export interface LinkEnvelope {
  abelon: "panel-msg" | "ack" | "hello" | "owlbear-msg";
  ref: string;
  msg?: LiveMessage | { kind: "ping"; id: string; at: string };
  fromOwlbear?: OwlbearMessage;
}

// The Owlbear tab. Captured the moment the panel opens (the extension window that opened it
// closes with its popover), then refreshed from Owlbear's own "hello" messages, which is
// what re-links the panel after either side reloads.
let owlbearTop: Window | undefined;
const owlbearListeners: ((m: OwlbearMessage) => void)[] = [];
/** Panel side: hear what Owlbear sends back (the live roster, the GM's selection). */
export function onOwlbear(fn: (m: OwlbearMessage) => void) {
  owlbearListeners.push(fn);
}
try {
  owlbearTop = (window.opener?.top as Window | undefined) ?? undefined;
} catch {
  owlbearTop = undefined;
}
if (typeof window !== "undefined") {
  window.addEventListener("message", (e) => {
    const d = e.data as LinkEnvelope;
    if (e.origin !== location.origin || !e.source) return;
    if (d?.abelon !== "hello" && d?.abelon !== "owlbear-msg") return;
    try {
      owlbearTop = (e.source as Window).top ?? undefined;
    } catch {
      // ignore
    }
    if (d.abelon === "owlbear-msg" && d.fromOwlbear) owlbearListeners.forEach((fn) => fn(d.fromOwlbear!));
  });
}

/** The Owlbear tab this panel is linked to, if any. */
export function owlbearWindow(): Window | undefined {
  try {
    return owlbearTop && !owlbearTop.closed ? owlbearTop : undefined;
  } catch {
    return undefined;
  }
}

function framesOf(w: Window, depth = 0, out: Window[] = []): Window[] {
  try {
    for (let i = 0; i < w.frames.length; i++) {
      const f = w.frames[i] as Window;
      out.push(f);
      if (depth < 3) framesOf(f, depth + 1, out);
    }
  } catch {
    // a frame went away mid-walk
  }
  return out;
}

/** Sends straight to the Owlbear tab. True once our extension has acknowledged it. */
export function sendDirect(msg: LinkEnvelope["msg"], timeoutMs = 400): Promise<boolean> {
  const top = owlbearWindow();
  if (!top) return Promise.resolve(false);
  const ref = crypto.randomUUID();
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      window.removeEventListener("message", onAck);
      clearTimeout(timer);
      resolve(ok);
    };
    const onAck = (e: MessageEvent) => {
      const d = e.data as LinkEnvelope;
      if (e.origin === location.origin && d?.abelon === "ack" && d.ref === ref) done(true);
    };
    window.addEventListener("message", onAck);
    const timer = setTimeout(() => done(false), timeoutMs);
    const envelope: LinkEnvelope = { abelon: "panel-msg", ref, msg };
    for (const f of framesOf(top)) {
      try {
        f.postMessage(envelope, location.origin); // only frames on our origin receive it
      } catch {
        // ignore
      }
    }
  });
}
