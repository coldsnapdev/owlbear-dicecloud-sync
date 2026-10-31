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
export type LiveMessage = PanelCommand | StatusesMessage;

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
