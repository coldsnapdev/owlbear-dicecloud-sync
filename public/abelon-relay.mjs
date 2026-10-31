// Abelon local relay — a live line between the DM panel and your Owlbear tab.
//
// Run it with:  node abelon-relay.mjs   (or double-click "Start Abelon relay.cmd")
// and leave the window open while you play. Close it when you're done.
//
// It only listens on this computer (127.0.0.1), only accepts the Abelon pages
// (https://coldsnapdev.github.io), stores nothing, and needs nothing installed beyond Node.
// If it isn't running, the panel and Owlbear just use the slower routes as before.

import http from "node:http";

const PORT = 47917;
const VERSION = 1;
const ALLOWED_ORIGINS = new Set(["https://coldsnapdev.github.io"]);
if (process.env.ABELON_RELAY_DEV) ALLOWED_ORIGINS.add(process.env.ABELON_RELAY_DEV);
const ROLES = new Set(["owlbear", "panel"]);
const MAX_BODY = 1024 * 1024;

/** @type {Set<{ role: string, res: http.ServerResponse }>} */
const clients = new Set();

const time = () => new Date().toLocaleTimeString("en-GB");
const say = (msg) => console.log(`${time()}  ${msg}`);
const count = (role) => [...clients].filter((c) => c.role === role).length;

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // lets an https page reach this computer (Chrome / Opera "local network access")
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function describe(text) {
  try {
    const m = JSON.parse(text);
    if (m.kind === "show-roll") return `roll: ${m.roll?.who ?? "?"} · ${m.roll?.action || "dice"}`;
    if (m.kind === "apply-statblock") return `stat block: ${m.entryName}`;
    if (m.kind === "statuses") return "statuses";
    return m.kind ?? "message";
  } catch {
    return "message";
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (!cors(req, res)) {
    // a request without the Abelon origin: not for us (another website, or a stray tab)
    res.writeHead(403).end();
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    return json(res, 200, { version: VERSION, owlbear: count("owlbear"), panel: count("panel") });
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const role = url.searchParams.get("role");
    if (!ROLES.has(role)) return json(res, 400, { error: "role must be owlbear or panel" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
    const client = { role, res };
    clients.add(client);
    say(`${role === "owlbear" ? "Owlbear" : "DM panel"} connected`);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(client);
      say(`${role === "owlbear" ? "Owlbear" : "DM panel"} disconnected`);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/send") {
    const to = url.searchParams.get("to");
    if (!ROLES.has(to)) return json(res, 400, { error: "to must be owlbear or panel" });
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      const line = body.replace(/\r?\n/g, " ");
      let delivered = 0;
      for (const c of clients) {
        if (c.role !== to) continue;
        c.res.write(`data: ${line}\n\n`);
        delivered++;
      }
      say(`${describe(body)} → ${to === "owlbear" ? "Owlbear" : "DM panel"}${delivered ? "" : " (nobody listening)"}`);
      json(res, 200, { delivered });
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.log(`The relay is already running (port ${PORT} is in use). You can close this window.`);
  else console.log("Relay error:", err.message);
  process.exitCode = 1;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Abelon relay running (v${VERSION}). Leave this window open while you play; close it to stop.`);
  console.log("Waiting for Owlbear and the DM panel to connect…");
});
