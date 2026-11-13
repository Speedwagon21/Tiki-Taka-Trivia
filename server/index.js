/* HTTP server for the static front end plus a WebSocket endpoint at /ws for rooms. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { RoomManager } = require("./game");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json"
};
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000"
};
/* Only our own script, our own socket and the Solana devnet RPC. Matters on a page that talks to a wallet. */
const headersFor = req => ({
  ...BASE_HEADERS,
  "Content-Security-Policy": [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    `connect-src 'self' wss://${req.headers.host} ws://${req.headers.host} https://api.devnet.solana.com`,
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"
  ].join("; ")
});
const LIMITS = { perIp: 20, total: 5000, lookupsPerMin: 30, msgsPerSec: 20 };

/* ----- input cleaning: everything from a client is untrusted ----- */
const cleanName = v => {
  if (typeof v !== "string") return "Player";
  // \p{C} covers control, zero-width and text-direction characters used to fake a name
  const s = v.slice(0, 200).normalize("NFKC").replace(/[\p{C}<>]/gu, "").replace(/\s+/g, " ").trim().slice(0, 20);
  return s || "Player";
};
const cleanWallet = v => (typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null);
const cleanKey = v => (typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null);
const cleanRecent = v => (Array.isArray(v) ? v.filter(x => typeof x === "string" && x.length < 20).slice(0, 60) : []);
function cleanStake(v) {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0.01 || n > 1000) return null;
  return Math.round(n * 100) / 100;
}

function serveStatic(req, res) {
  const SECURITY_HEADERS = headersFor(req);
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
    return res.end("ok");
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = "/"; }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY_HEADERS }); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=300",
      ...SECURITY_HEADERS
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

/* The player's address. Behind a host's proxy the socket address is the proxy, so only a header
   the proxy overwrites can be trusted; with none, there is no per-address limit (the total cap still applies).
   shortcut: trusts cf-connecting-ip when TRUST_PROXY is set, change it if the host uses another header */
const clientIp = req => (process.env.TRUST_PROXY ? req.headers["cf-connecting-ip"] || null : req.socket.remoteAddress);

function createServer(gameOpts = {}, limits = {}) {
  const lim = { ...LIMITS, ...limits };
  const manager = new RoomManager(gameOpts);
  const server = http.createServer(serveStatic);
  const perIp = new Map();              // address -> open sockets
  const lookups = new Map();            // address (or socket) -> { start, count }
  const wss = new WebSocketServer({
    server, path: "/ws", maxPayload: 4096,
    verifyClient: ({ req, origin }) => {
      // A browser on another site must not be able to drive our socket; non-browser clients send no Origin
      if (origin) { try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; } }
      const ip = clientIp(req);
      return wss.clients.size < lim.total && (!ip || (perIp.get(ip) || 0) < lim.perIp);
    }
  });
  const liveByKey = new Map();          // client key -> the socket currently using it

  wss.on("connection", (ws, req) => {
    const ip = clientIp(req);
    if (ip) perIp.set(ip, (perIp.get(ip) || 0) + 1);
    ws.on("close", () => {
      lookups.delete(ws);
      if (ip) perIp.get(ip) > 1 ? perIp.set(ip, perIp.get(ip) - 1) : (perIp.delete(ip), lookups.delete(ip));
    });
    let key = null;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
    const fail = message => send({ type: "error", message });

    // Flood guard: a real client never comes close, so anything over the limit is cut off
    let windowStart = Date.now(), count = 0;

    ws.on("message", raw => { try {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > lim.msgsPerSec) return ws.close(1008, "Too many messages");

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "hello") {
        if (key) return;                 // one identity per connection, for its whole life
        const k = cleanKey(msg.key);
        if (!k) return fail("Bad client key.");
        const other = liveByKey.get(k);
        if (other && other !== ws && other.readyState === WebSocket.OPEN) return send({ type: "rekey" });
        key = k;
        liveByKey.set(key, ws);
        const entry = manager.find(key);
        if (entry) entry.room.reconnect(entry.player, send);
        return send({ type: "hello", resumed: Boolean(entry) });
      }
      if (!key) return fail("Say hello first.");

      const who = () => ({
        key, send, name: cleanName(msg.name), wallet: cleanWallet(msg.wallet), recent: cleanRecent(msg.recent)
      });
      const entry = manager.find(key);

      switch (msg.type) {
        case "create":            // group room, or a head-to-head challenge (mode: "h2h")
        case "findMatch": {       // head to head against whoever is waiting at the same stake
          const stake = cleanStake(msg.stake);
          const currency = msg.currency === "USDC" ? "USDC" : "SOL";
          const w = who();
          if (!w.wallet) return fail("Connect a wallet first.");
          if (stake === null) return fail("Enter a stake between 0.01 and 1000.");
          const r = msg.type === "create"
            ? manager.create(w, { stake, currency, mode: msg.mode })
            : manager.findMatch(w, { stake, currency });
          if (r.error) fail(r.error);
          return;
        }
        case "cancelSearch":
          manager.cancelSearch(key);
          return send({ type: "searchCancelled" });
        case "lookup": {
          // Stops someone scanning for live room codes
          const id = ip || ws, slot = lookups.get(id);
          if (!slot || now - slot.start > 60000) lookups.set(id, { start: now, count: 1 });
          else if (++slot.count > lim.lookupsPerMin) return send({ type: "error", message: "Too many tries. Wait a minute and try again.", about: "lookup" });
          const r = manager.lookup(msg.code);
          return send(r.error ? { type: "error", message: r.error, about: "lookup" } : { type: "lookup", room: r });
        }
        case "join": {
          const w = who();
          if (!w.wallet) return fail("Connect a wallet before joining.");
          const r = manager.join(w, msg.code);
          if (r.error) send({ type: "error", message: r.error, about: "join" });
          return;
        }
        case "start": {
          if (!entry) return fail("You are not in a room.");
          const err = entry.room.start(entry.player);
          if (err) fail(err);
          return;
        }
        case "rematch": {
          if (!entry) return fail("You are not in a room.");
          const err = entry.room.requestRematch(entry.player);
          if (err) fail(err);
          return;
        }
        case "answer":
          if (entry) entry.room.answer(entry.player, msg.index, msg.choice);
          return;
        case "leave":
          if (entry) entry.room.removePlayer(entry.player);
          return send({ type: "left" });
        default:
          return;
      }
    } catch (err) { console.error("message handler failed:", err); } });   // one bad message must never take the server down

    ws.on("close", () => {
      if (!key || liveByKey.get(key) !== ws) return;   // a newer socket already took over
      liveByKey.delete(key);
      manager.cancelSearch(key);
      const entry = manager.find(key);
      if (entry) entry.room.disconnect(entry.player);
    });
  });

  // Drop sockets that stop answering pings (phones going to sleep, dead proxies)
  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 25000);

  heartbeat.unref();

  server.on("close", () => { clearInterval(heartbeat); manager.shutdown(); });
  /* Stop accepting players and drop every open socket (used by tests and on shutdown) */
  const stop = () => new Promise(resolve => {
    wss.clients.forEach(ws => ws.terminate());
    wss.close();
    server.close(() => resolve());
  });
  return { server, wss, manager, stop };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server, stop } = createServer();
  server.listen(port, () => console.log(`Tiki-Taka Trivia running on http://localhost:${port}`));
  // Hosting platforms send SIGTERM on redeploy: close sockets cleanly so clients reconnect fast
  process.on("SIGTERM", () => stop().then(() => process.exit(0)));
}

module.exports = { createServer, cleanName, cleanStake, cleanWallet };
