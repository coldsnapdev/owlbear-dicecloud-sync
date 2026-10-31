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
