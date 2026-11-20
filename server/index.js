/* HTTP server for the static front end plus a WebSocket endpoint at /ws for rooms. */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { RoomManager } = require("./game");

const { createEscrow } = require("./escrow");
const { createCoins, REDEEM_MIN } = require("./coins");
const { countryOf, regionAllowed, isSanctioned } = require("./compliance");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const WEB3_BUNDLE = path.join(__dirname, "..", "node_modules", "@solana", "web3.js", "lib", "index.iife.min.js");
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
const headersFor = (req, rpc = "https://api.devnet.solana.com") => ({
  ...BASE_HEADERS,
  "Content-Security-Policy": [
    "default-src 'self'", `script-src 'self' ${INLINE_SCRIPTS}`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "worker-src 'self' blob:",
    `connect-src 'self' wss://${req.headers.host} ws://${req.headers.host} ${new URL(rpc).origin}`,
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"
  ].join("; ")
});
/* The landing page's two one-line head scripts (they must run before first paint) are allowed by hash, nothing else inline */
const INLINE_SCRIPTS = (fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map(tag => `'sha256-${crypto.createHash("sha256").update(tag.slice(8, -9)).digest("base64")}'`).join(" ");
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
const COIN = c => c === "GC" || c === "SC";
const coinName = c => (c === "GC" ? "Gold Coins" : "Sweeps Coins");
/* A coin stake: whole Gold Coins, or Sweeps Coins to the cent */
function cleanCoinStake(v, currency) {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (currency === "GC") return Number.isInteger(n) && n >= 1 && n <= 1000000 ? n : null;
  return Number.isFinite(n) && n >= 0.01 && n <= 10000 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9 ? Math.round(n * 100) / 100 : null;
}
/* A stake in the units it is held in: lamports for SOL, cents for Sweeps Coins, coins for Gold Coins */
const unitsFor = (currency, stake) => (currency === "SOL" ? Math.round(stake * 1e9) : currency === "SC" ? Math.round(stake * 100) : stake);
/* Packs are priced in dollars and charged in SOL at this rate.
   shortcut: a fixed rate from SOL_USD (default 35), switch to a live price feed before taking real SOL */
const SOL_USD = Number(process.env.SOL_USD) || 35;
const packLamports = pack => Math.round(pack.usd / SOL_USD * 1e9);
function cleanStake(v) {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0.01 || n > 1000) return null;
  return Math.round(n * 100) / 100;
}

function serveStatic(req, res, rpc) {
  const SECURITY_HEADERS = headersFor(req, rpc);
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
    return res.end("ok");
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = "/"; }
  // The game lives at /play/. Old invite links (/?room=CODE) and /play without the slash still land there.
  if (rel === "/play" || (rel === "/" && url.searchParams.has("room"))) {
    res.writeHead(302, { Location: "/play/" + url.search, ...SECURITY_HEADERS });
    return res.end();
  }
  if (rel.endsWith("/")) rel += "index.html";
  // The Solana library the page needs to build a stake payment, served from our own origin
  const file = rel === "/vendor/web3.js" ? WEB3_BUNDLE : path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== WEB3_BUNDLE && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end(); }
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

/* escrow: when given, SOL rooms take and pay real stakes on-chain; without it SOL stakes are simulated.
   coins: when given, players can make accounts and play for Gold and Sweeps Coins. */
function createServer(gameOpts = {}, limits = {}, escrow = null, coins = null) {
  const lim = { ...LIMITS, ...limits };
  // SOL and USDC stakes are player-funded pots, which need a gambling licence in most places, so they
  // are off whenever coins are on. gameOpts.cryptoStakes switches them back on where they are cleared.
  const cryptoStakes = Boolean(gameOpts.cryptoStakes) || !coins;
  // Cashing out Sweeps Coins stays off until it is legally cleared: gameOpts.redemption (REDEMPTION=1) opens it
  const redemption = Boolean(gameOpts.redemption) && Boolean(coins);
  const manager = new RoomManager(gameOpts, escrow, coins);
  const accountSockets = new Map();     // account id -> the send functions of its open connections
  const pushAccount = id => coins.account(id).then(a => (accountSockets.get(id) || []).forEach(s => s({ type: "account", account: a })));
  if (coins) coins.onChange = id => { pushAccount(id).catch(err => console.error("account push failed:", err)); };
  const authTries = new Map();          // address (or socket) -> { start, count }
  const server = http.createServer((req, res) => serveStatic(req, res, escrow ? escrow.rpcUrl : undefined));
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
    const country = countryOf(req);       // where the player is, for blocked places (server/compliance.js)
    if (ip) perIp.set(ip, (perIp.get(ip) || 0) + 1);
    ws.on("close", () => {
      lookups.delete(ws); authTries.delete(ws);
      if (account) accountSockets.get(account)?.delete(send);
      if (ip) perIp.get(ip) > 1 ? perIp.set(ip, perIp.get(ip) - 1) : (perIp.delete(ip), lookups.delete(ip));
    });
    let key = null, account = null;     // account: the signed-in account's id
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
    const fail = message => send({ type: "error", message });

    // Flood guard: a real client never comes close, so anything over the limit is cut off
    let windowStart = Date.now(), count = 0;

    // Confirms the on-chain payment a message carries. Returns { payer, lamports }, or null after telling the player why not.
    let confirming = false;
    const deposit = async msg => {
      const d = msg.deposit;
      if (!d || typeof d.ref !== "string" || typeof d.signature !== "string") { send({ type: "error", message: "Your stake payment is missing.", about: "deposit" }); return null; }
      if (confirming) { send({ type: "error", message: "Still confirming your last payment.", about: "deposit" }); return null; }
      confirming = true;
      try { return await escrow.verify(key, d.ref, d.signature); }
      catch (err) {
        if (!err.userMessage) console.error("deposit check failed:", err);
        send({ type: "error", message: err.userMessage || "We couldn't confirm your payment. Try again.", about: "deposit" });
        return null;
      } finally { confirming = false; }
    };
    // Applies a confirmed payment to the player; if they vanished while we were checking, it goes straight back
    const paidBy = (w, d) => {
      Object.assign(w, { wallet: d.payer, paid: d.lamports });   // the paying wallet is the one that gets paid out
      if (ws.readyState === WebSocket.OPEN) return true;
      manager.refund(w, "SOL");
      return false;
    };
    // Takes a coin stake from the signed-in account. Returns false after telling the player why not.
    const takeCoins = async (w, currency, amount, about) => {
      const no = message => { send({ type: "error", message, about }); return false; };
      if (!account) return no("Sign in to play for coins.");
      if (currency === "SC" && !regionAllowed(country)) return no("Sweeps Coin games aren't available where you are.");
      let taken;
      try { taken = await coins.take(account, currency, amount, "stake"); }
      catch (err) { if (!err.userMessage) throw err; return no(err.userMessage); }    // a break, self-exclusion or new terms
      if (!taken) return no(`You don't have ${(amount / coins.unit[currency]).toLocaleString("en")} ${coinName(currency)}.`);
      Object.assign(w, { account, paid: amount });
      if (ws.readyState === WebSocket.OPEN) return true;
      manager.refund(w, currency);
      return false;
    };
    // Takes the stake a room needs, on-chain for SOL or from the account for coins
    const takeStake = async (w, currency, units, about) => {
      if (COIN(currency)) return takeCoins(w, currency, units, about);
      const d = await deposit(w.msg);
      if (!d || !paidBy(w, d)) return false;
      if (d.lamports >= units) return true;
      send({ type: "error", message: "That payment doesn't cover this stake.", about });
      manager.refund(w, "SOL");
      return false;
    };
    const signIn = async (id, token) => {
      if (account) accountSockets.get(account)?.delete(send);
      account = id;
      if (!accountSockets.has(id)) accountSockets.set(id, new Set());
      accountSockets.get(id).add(send);
      send({ type: "account", account: await coins.account(id), ...(token ? { token } : {}) });
    };

    ws.on("message", async raw => { try {
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
        send({
          type: "hello", resumed: Boolean(entry), escrow: escrow ? { address: escrow.address } : null, cryptoStakes,
          coins: coins ? {
            packs: escrow ? Object.fromEntries(Object.entries(coins.packs).map(([id, p]) => [id, { ...p, lamports: packLamports(p) }])) : null,
            redemption, redeemMin: REDEEM_MIN, termsVersion: coins.termsVersion, pauses: Object.keys(coins.pauses),
            regionAllowed: regionAllowed(country)
          } : null
        });
        const id = coins && await coins.resume(msg.session);
        if (id) await signIn(id);
        return;
      }
      if (!key) return fail("Say hello first.");

      const who = () => ({
        key, send, msg, name: cleanName(msg.name), wallet: cleanWallet(msg.wallet), recent: cleanRecent(msg.recent)
      });
      const entry = manager.find(key);

      switch (msg.type) {
        case "register":
        case "login": {
          if (!coins) return;
          const id = ip || ws, slot = authTries.get(id);      // slows down password guessing
          if (!slot || now - slot.start > 60000) authTries.set(id, { start: now, count: 1 });
          else if (++slot.count > 10) return send({ type: "error", message: "Too many tries. Wait a minute and try again.", about: "auth" });
          try {
            const r = msg.type === "register" ? await coins.register(msg.username, msg.password, msg.acceptTerms === true) : await coins.login(msg.username, msg.password);
            return signIn(r.account.id, r.token);
          } catch (err) {
            if (!err.userMessage) throw err;
            return send({ type: "error", message: err.userMessage, about: "auth" });
          }
        }
        case "logout":
          if (!coins || !account) return;
          accountSockets.get(account)?.delete(send);
          account = null;
          await coins.logout(msg.session);
          return send({ type: "account", account: null });
        case "redeem": {          // cash out Sweeps Coins to a Solana wallet (paid by hand after review)
          if (!coins || !account) return;
          if (!redemption) return send({ type: "error", message: "Cashing out isn't open yet.", about: "redeem" });
          const wallet = cleanWallet(msg.wallet);
          const amount = cleanCoinStake(msg.amount, "SC");
          if (!wallet) return send({ type: "error", message: "Enter the Solana wallet address to pay.", about: "redeem" });
          if (amount === null) return send({ type: "error", message: "Enter how many Sweeps Coins to cash out.", about: "redeem" });
          if (!regionAllowed(country, { cashOut: true })) return send({ type: "error", message: "Cashing out isn't available where you are.", about: "redeem" });
          if (isSanctioned(wallet)) {
            // Never pay a sanctioned wallet; the request is refused and logged for whoever reviews cash-outs
            console.warn("SANCTIONS: cash-out to a listed wallet refused", JSON.stringify({ account, wallet, country }));
            return send({ type: "error", message: "We can't pay that wallet. Contact us if you think this is a mistake.", about: "redeem" });
          }
          try { await coins.requestRedemption(account, unitsFor("SC", amount), wallet, country); }
          catch (err) { if (!err.userMessage) throw err; return send({ type: "error", message: err.userMessage, about: "redeem" }); }
          send({ type: "redeemed" });
          return send({ type: "redemptions", list: await coins.redemptions(account) });
        }
        case "redemptions":
          if (!coins || !account) return;
          return send({ type: "redemptions", list: await coins.redemptions(account) });
        case "acceptTerms":
          if (!coins || !account) return;
          await coins.acceptTerms(account);
          return send({ type: "accepted" });
        case "setLimit": {        // a monthly spending limit in dollars, or null to remove it
          if (!coins || !account) return;
          const usd = msg.usd === null ? null : Number(msg.usd);
          if (usd !== null && !(Number.isFinite(usd) && usd >= 0)) return send({ type: "error", message: "Enter a monthly limit in dollars.", about: "rg" });
          try { await coins.setSpendLimit(account, usd === null ? null : Math.round(usd * 100)); return send({ type: "limitSet" }); }
          catch (err) { if (!err.userMessage) throw err; return send({ type: "error", message: err.userMessage, about: "rg" }); }
        }
        case "pause": {           // a break or self-exclusion
          if (!coins || !account) return;
          try { await coins.pause(account, msg.choice); }
          catch (err) { if (!err.userMessage) throw err; return send({ type: "error", message: err.userMessage, about: "rg" }); }
          manager.leaveCurrent(key);       // stepping away means leaving any room or search now
          return send({ type: "paused" });
        }
        case "exportData":
          if (!coins || !account) return;
          return send({ type: "export", data: await coins.exportData(account) });
        case "deleteAccount": {
          if (!coins || !account) return;
          try { await coins.deleteAccount(account, msg.password); }
          catch (err) { if (!err.userMessage) throw err; return send({ type: "error", message: err.userMessage, about: "rg" }); }
          manager.leaveCurrent(key);
          accountSockets.get(account)?.delete(send);
          account = null;
          return send({ type: "deleted" });
        }
        case "purchases":
          if (!coins || !account) return;
          return send({ type: "purchases", list: await coins.purchases(account) });
        case "claimDaily": {
          if (!coins || !account) return;
          try { await coins.claimDaily(account); return send({ type: "claimed" }); }
          catch (err) { if (!err.userMessage) throw err; return send({ type: "error", message: err.userMessage, about: "store" }); }
        }
        case "buy": {             // a Gold Coin pack, paid in SOL through the escrow
          if (!coins || !escrow || !account) return;
          const pack = coins.packs[msg.pack];
          if (!pack) return;
          if (!regionAllowed(country)) return send({ type: "error", message: "Coin packs aren't available where you are.", about: "store" });
          const why = await coins.checkPurchase(account, msg.pack);
          if (why) return send({ type: "error", message: why, about: "store" });
          const d = await deposit(msg);
          if (!d) return;
          if (isSanctioned(d.payer)) {
            // shortcut: payment from a listed wallet is kept unspent and logged for a person (and legal advice) to handle
            console.warn("SANCTIONS: payment from a listed wallet", JSON.stringify({ account, payer: d.payer, signature: msg.deposit.signature }));
            return send({ type: "error", message: "We can't accept a payment from that wallet. Contact us.", about: "store" });
          }
          if (d.lamports < packLamports(pack)) return send({ type: "error", message: "That payment doesn't cover the pack.", about: "store" });
          try {
            const got = await coins.creditPack(account, msg.pack, msg.deposit.signature);
            send({ type: "bought", pack: msg.pack, gc: got.gc, sc: got.sc });
            return send({ type: "purchases", list: await coins.purchases(account) });
          }
          catch (err) { if (!err.userMessage) throw err; return send({ type: "error", message: err.userMessage, about: "store" }); }
        }
        case "intent": {          // "what do I pay, and where?" before a SOL payment
          if (!escrow) return;
          let lamports = null;
          if (msg.pack !== undefined) {
            const pack = account && coins && coins.packs[msg.pack];
            if (pack && !regionAllowed(country)) return send({ type: "error", message: "Coin packs aren't available where you are.", about: "intent" });
            const why = pack && await coins.checkPurchase(account, msg.pack);
            if (why) return send({ type: "error", message: why, about: "intent" });
            lamports = pack ? packLamports(pack) : null;
          }
          else if (msg.room) lamports = entry && entry.room.escrowed && entry.room.currency === "SOL" ? entry.room.units : null;
          else if (msg.code !== undefined) { const info = manager.lookup(msg.code); lamports = info.escrowed && info.currency === "SOL" ? info.units : null; }
          else { const stake = cleanStake(msg.stake); lamports = stake && Math.round(stake * 1e9); }
          if (!lamports) return send({ type: "error", message: "There is nothing to pay for.", about: "intent" });
          return send({ type: "intent", ...escrow.intent(key, lamports), rpc: escrow.rpcUrl });
        }
        case "pay": {             // stake for the next match in a room you are already in
          if (!entry || !entry.room.escrowed || entry.player.paid || entry.room.inMatch()) return;
          const currency = entry.room.currency, w = { send, msg };
          if (!(await takeStake(w, currency, entry.room.units, "deposit"))) return;
          const seat = manager.find(key);
          if (!seat || seat.room !== entry.room || seat.room.inMatch() || seat.player.paid) return manager.refund(w, currency);
          Object.assign(seat.player, { wallet: w.wallet || seat.player.wallet, account: w.account || seat.player.account, paid: w.paid });
          const err = msg.rematch === true && seat.room.mode === "h2h" ? seat.room.requestRematch(seat.player) : null;
          if (err) fail(err);
          return seat.room.syncState();
        }
        case "create":            // group room, or a head-to-head challenge (mode: "h2h")
        case "findMatch": {       // head to head against whoever is waiting at the same stake
          const currency = ["SOL", "USDC", "GC", "SC"].includes(msg.currency) ? msg.currency : cryptoStakes ? "SOL" : "GC";
          if (COIN(currency) && !coins) return fail("Coin games aren't available right now.");
          if (!COIN(currency) && !cryptoStakes) return fail("Rooms are played for Gold Coins or Sweeps Coins.");
          const stake = COIN(currency) ? cleanCoinStake(msg.stake, currency) : cleanStake(msg.stake);
          const w = who();
          if (!COIN(currency) && !w.wallet) return fail("Connect a wallet first.");
          if (stake === null) return fail(currency === "GC" ? "Enter a whole number of Gold Coins to stake." : currency === "SC" ? "Enter a Sweeps Coin stake from 0.01 to 10,000." : "Enter a stake between 0.01 and 1000.");
          if ((COIN(currency) || (escrow && currency === "SOL")) &&
              !(await takeStake(w, currency, unitsFor(currency, stake), "deposit"))) return;
          const r = msg.type === "create"
            ? manager.create(w, { stake, currency, mode: msg.mode })
            : manager.findMatch(w, { stake, currency });
          if (r.error) { fail(r.error); manager.refund(w, currency); }
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
          const info = manager.lookup(msg.code);
          if (!COIN(info.currency) && !w.wallet) return fail("Connect a wallet before joining.");
          const seated = entry && entry.room.code === info.code;      // just reconnecting: already paid
          if (info.escrowed && !seated && !(await takeStake(w, info.currency, info.units, "join"))) return;
          const r = manager.join(w, msg.code);
          if (r.error) { send({ type: "error", message: r.error, about: "join" }); manager.refund(w, info.currency); }
          else if (seated) manager.refund(w, info.currency);
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
    server.closeAllConnections();          // a half-read download must not hold the shutdown open
  }).then(() => escrow && escrow.idle());   // let refunds for anything still held go out (coin refunds are immediate)
  return { server, wss, manager, stop };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // ESCROW_SECRET: the escrow wallet's secret key as a JSON array. Unset means simulated stakes.
  const escrow = process.env.ESCROW_SECRET ? createEscrow({ secret: process.env.ESCROW_SECRET, rpcUrl: process.env.SOLANA_RPC }) : null;
  console.log(escrow ? `Escrow wallet ${escrow.address} on ${escrow.rpcUrl}` : "No ESCROW_SECRET set: all stakes are simulated");
  // DATABASE_URL: the Postgres database for accounts and coins. Unset means no accounts and no coin games.
  (async () => {
    let coins = null;
    if (process.env.DATABASE_URL) {
      const { Pool } = require("pg");
      const url = process.env.DATABASE_URL;
      coins = await createCoins(new Pool({ connectionString: url, ssl: /render\.com/.test(url) ? { rejectUnauthorized: false } : undefined }));
    }
    console.log(coins ? "Accounts and coins are on" : "No DATABASE_URL set: no accounts or coin games");
    // CRYPTO_STAKES=1 brings back SOL and USDC rooms next to the coins (only where a lawyer has cleared them)
    // REDEMPTION=1 opens cashing out Sweeps Coins (only once a lawyer has cleared it)
    const { server, stop } = createServer({ cryptoStakes: process.env.CRYPTO_STAKES === "1", redemption: process.env.REDEMPTION === "1" }, {}, escrow, coins);
    server.listen(port, () => console.log(`Tiki-Taka Trivia running on http://localhost:${port}`));
    // Hosting platforms send SIGTERM on redeploy: close sockets cleanly so clients reconnect fast
    process.on("SIGTERM", () => stop().then(() => process.exit(0)));
  })();
}

module.exports = { createServer, cleanName, cleanStake, cleanWallet };
