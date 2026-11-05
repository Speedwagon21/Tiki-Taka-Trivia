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
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY"
};

/* ----- input cleaning: everything from a client is untrusted ----- */
const cleanName = v => {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
  return s || "Player";
};
const cleanWallet = v => (typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null);
const cleanKey = v => (typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
const cleanRecent = v => (Array.isArray(v) ? v.filter(x => typeof x === "string" && x.length < 20).slice(0, 60) : []);
function cleanStake(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0.01 || n > 1000) return null;
  return Math.round(n * 100) / 100;
}

function serveStatic(req, res) {
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

function createServer(gameOpts = {}) {
  const manager = new RoomManager(gameOpts);
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
  const liveByKey = new Map();          // client key -> the socket currently using it

  wss.on("connection", ws => {
    let key = null;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
    const fail = message => send({ type: "error", message });

    // Simple flood guard: at most 20 messages per second per socket
    let windowStart = Date.now(), count = 0;

    ws.on("message", raw => {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > 20) return;

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "hello") {
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
        case "create": {
          const stake = cleanStake(msg.stake);
          const currency = msg.currency === "USDC" ? "USDC" : "SOL";
          const w = who();
          if (!w.wallet) return fail("Connect a wallet before creating a room.");
          if (stake === null) return fail("Enter a stake between 0.01 and 1000.");
          const r = manager.create(w, { stake, currency });
          if (r.error) fail(r.error);
          return;
        }
        case "practice": {
          const r = manager.practice(who());
          if (r.error) fail(r.error);
          return;
        }
        case "lookup": {
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
        case "answer":
          if (entry) entry.room.answer(entry.player, msg.index, msg.choice);
          return;
        case "leave":
          if (entry) entry.room.removePlayer(entry.player);
          return send({ type: "left" });
        default:
          return;
      }
    });

    ws.on("close", () => {
      if (!key || liveByKey.get(key) !== ws) return;   // a newer socket already took over
      liveByKey.delete(key);
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
