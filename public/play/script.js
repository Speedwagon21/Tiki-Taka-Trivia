/* Tiki-Taka Trivia client.
   The server runs rooms, questions, timers and scores; this file draws the screens,
   talks to the server over a WebSocket and handles the wallet. */
"use strict";

const $ = id => document.getElementById(id);
const store = {   // storage can be blocked (private mode), so never let it throw
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* ignore */ } }
};
const fmt = n => {
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
const short = addr => (addr ? addr.slice(0, 4) + "…" + addr.slice(-4) : "");
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  kids.flat().forEach(k => k != null && node.append(k));
  return node;
};
const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ======================================================================
   App state
   ====================================================================== */
const app = {
  room: null,           // latest room snapshot from the server
  q: null,              // current question
  picked: null,         // answer index this player chose for the current question
  answered: new Set(),  // player ids who have locked in on the current question
  lastPoints: {},       // points from the latest reveal, by player id
  results: null,
  lookup: null,         // room preview on the Join tab
  wallet: null,         // { address, kind: "phantom" | "demo", balance }
  currency: "SOL",
  screen: "home",
  beforeTerms: "home",
  mode: "group",        // home screen tab: "group" | "h2h"
  search: null,         // { stake, currency } while looking for a head-to-head opponent
  escrow: null,         // { address } when the server takes real SOL stakes on devnet; null = simulated
  payMsg: "homeMsg",    // where the current stake payment reports its progress
  pendingCode: null,    // code from an invite link, looked up once connected
  leaving: false        // set after "Leave" so stray updates don't pull us back in
};

/* ======================================================================
   Screens
   ====================================================================== */
function show(id) {
  if (app.screen === id) return;
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
  app.screen = id;
  // Footer links are hidden mid-match so nobody can stall by opening the terms
  $("siteFooter").hidden = id === "arena";
  window.scrollTo(0, 0);
  const heading = $(id).querySelector("[tabindex='-1']");
  if (heading && id !== "arena") heading.focus({ preventScroll: true });
}

const PAGES = ["terms", "privacy"];
function openPage(id) {
  if (app.screen === "arena") return;
  if ($("accountDialog").open) $("accountDialog").close();
  if (!PAGES.includes(app.screen)) app.beforeTerms = app.screen;
  show(id);
}
document.addEventListener("click", e => {
  const a = e.target.closest('[data-open-terms], a[href="#terms"], a[href="#privacy"]');
  if (!a) return;
  e.preventDefault();
  openPage(a.getAttribute("href").slice(1));
});
addEventListener("hashchange", () => { const id = location.hash.slice(1); if (PAGES.includes(id)) openPage(id); });
$("termsBack").onclick = $("privacyBack").onclick = () => show(screenForRoom() || app.beforeTerms || "home");

/* Which screen the room's phase belongs on */
function screenForRoom() {
  if (!app.room) return null;
  if (["countdown", "question", "reveal"].includes(app.room.phase)) return "arena";
  if (app.room.phase === "results" && app.results) return "results";
  return "room";
}

function setMsg(id, text, ok = false) {
  const m = $(id);
  m.textContent = text || "";
  m.className = "msg" + (ok ? " ok" : "");
}
let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
const announce = text => { $("announcer").textContent = ""; setTimeout(() => { $("announcer").textContent = text; }, 30); };

/* ======================================================================
   Sound (Web Audio, no files). Off switch is remembered.
   ====================================================================== */
const sound = {
  ctx: null,
  muted: store.get("tt-muted") === "1",
  unlock() {
    if (this.ctx || this.muted) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) this.ctx = new AC();
  },
  tone(freq, dur = 0.12, { type = "sine", at = 0, gain = 0.08 } = {}) {
    if (this.muted) return;
    this.unlock();
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator(), g = this.ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  },
  tick() { this.tone(1046, 0.05, { type: "square", gain: 0.03 }); },
  lock() { this.tone(660, 0.08, { type: "triangle" }); },
  beep(last) { this.tone(last ? 880 : 520, last ? 0.3 : 0.12, { type: "triangle", gain: 0.07 }); },
  right() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.18, { at: i * 0.07, type: "triangle" })); },
  wrong() { this.tone(160, 0.32, { type: "sawtooth", gain: 0.05 }); },
  join() { this.tone(784, 0.1, { type: "sine" }); this.tone(1046, 0.12, { at: 0.08 }); },
  win() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.22, { at: i * 0.11, type: "triangle", gain: 0.07 })); },
  lose() { [392, 349, 294].forEach((f, i) => this.tone(f, 0.28, { at: i * 0.16, type: "sine", gain: 0.06 })); },
  noise(dur, { freq = 800, q = 0.7, gain = 0.1, at = 0, attack = 0.3 } = {}) {
    if (this.muted) return;
    this.unlock();
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    const c = this.ctx, t0 = c.currentTime + at;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = buf; f.type = "bandpass"; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
  },
  crowd() { this.noise(3.2, { freq: 900, q: 0.5, gain: 0.12, attack: 0.5 }); this.noise(2.6, { freq: 2200, q: 1, gain: 0.04, at: 0.2, attack: 0.4 }); },
  boom() { this.tone(70, 0.6, { type: "sine", gain: 0.25 }); this.noise(0.5, { freq: 300, gain: 0.15, attack: 0.01 }); },
  pop() { this.noise(0.35, { freq: 1500, q: 2, gain: 0.05, attack: 0.01 }); }
};
function renderMute() {
  const b = $("muteBtn");
  b.setAttribute("aria-pressed", String(sound.muted));
  b.setAttribute("aria-label", sound.muted ? "Unmute sounds" : "Mute sounds");
  b.classList.toggle("muted", sound.muted);
}
$("muteBtn").onclick = () => {
  sound.muted = !sound.muted;
  store.set("tt-muted", sound.muted ? "1" : "0");
  renderMute();
  if (!sound.muted) sound.lock();
};
renderMute();
document.addEventListener("pointerdown", () => sound.unlock(), { once: true });

/* ======================================================================
   Server connection (auto-reconnects and resumes your seat)
   ====================================================================== */
const net = { ws: null, retry: 0, ready: false, queue: [] };
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
let clientKey = store.get("tt-key", sessionStorage) || newKey();
store.set("tt-key", clientKey, sessionStorage);

function setNet(stateName, label) {
  const s = $("netStatus");
  s.className = "net " + stateName;
  s.querySelector("span").textContent = label;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  net.ws = ws;
  setNet("connecting", net.retry ? "Reconnecting…" : "Connecting…");
  ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", key: clientKey, session: store.get("tt-session") })); };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  ws.onclose = () => {
    net.ready = false;
    setNet("offline", "Offline");
    const wait = Math.min(8000, 500 * 2 ** net.retry++);
    setTimeout(connect, wait);
  };
}

function send(msg) {
  if (net.ready && net.ws.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify(msg));
  else { net.queue.push(msg); toast("Reconnecting to the server…"); }
}

/* ======================================================================
   Messages from the server
   ====================================================================== */
function handle(m) {
  switch (m.type) {
    case "rekey":                       // another tab is using our key (duplicated tab)
      clientKey = newKey();
      store.set("tt-key", clientKey, sessionStorage);
      net.ws.send(JSON.stringify({ type: "hello", key: clientKey, session: store.get("tt-session") }));
      return;

    case "hello":
      net.ready = true; net.retry = 0;
      setNet("online", "Online");
      app.escrow = m.escrow || null;
      app.coins = m.coins || null;
      app.cryptoStakes = m.cryptoStakes !== false;
      renderCoins();
      renderEscrowNote();
      if (!m.resumed && app.room) {     // our room is gone (server restarted or it closed)
        resetRoom();
        show("home");
        setMsg("homeMsg", "You lost your place in the room. Create or join another one.");
      }
      // The matchmaking queue forgets us when the connection drops, so get back in line
      if (app.search && isEscrowed(app.search.currency)) {     // a real stake was refunded when the line dropped
        stopSearch();
        show("home");
        setMsg("homeMsg", "The connection dropped while searching, so your stake was refunded. Search again when you're ready.");
      } else if (app.search && !net.queue.some(q => q.type === "findMatch")) send({ type: "findMatch", ...app.search, ...identity() });
      net.queue.splice(0).forEach(send);
      if (app.pendingCode) { lookupCode(app.pendingCode); app.pendingCode = null; }
      return;

    case "room": return onRoom(m);
    case "countdown": return onCountdown(m);
    case "question": return onQuestion(m);
    case "answered": return onAnswered(m);
    case "reveal": return onReveal(m);
    case "results": return onResults(m);
    case "searching": return onSearching(m);
    case "searchCancelled": return;
    case "intent": if (intentWaiter) intentWaiter.resolve(m); return;
    case "refund": return toast(`Stake refunded: ${isCoin(m.currency) ? coinText(m.currency, m.amount) : `${fmt4(m.amount / 1e9)} SOL`}`);
    case "account":
      if (m.token) store.set("tt-session", m.token);
      app.account = m.account;
      renderCoins();
      if (m.token) { $("accountDialog").close(); setMsg("storeMsg", ""); toast(`Signed in as ${m.account.username}`); }
      return;
    case "claimed": setMsg("accountMsg", "Today's free coins are in your balance.", true); return;
    case "itemBought": {
      const item = itemOf(m.item);
      if (item) { send({ type: "equip", kind: item.kind, item: m.item }); toast(`${item.name} is yours`); sound.win(); }
      return;
    }
    case "equipped": return;
    case "accepted": setMsg("accountMsg", "Thanks. You're all set to play.", true); return;
    case "limitSet": setMsg("accountMsg", "Spending limit saved.", true); return;
    case "paused":
      resetRoom(); stopSearch();
      if (app.screen !== "home") show("home");
      setMsg("accountMsg", "Done. Your account is paused for the time you chose.", true);
      return;
    case "export": {          // the player's data as a JSON file
      const url = URL.createObjectURL(new Blob([JSON.stringify(m.data, null, 2)], { type: "application/json" }));
      el("a", { href: url, download: `tiki-taka-data-${new Date().toISOString().slice(0, 10)}.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg("accountMsg", "Your data is downloading.", true);
      return;
    }
    case "deleted":
      store.set("tt-session", "");
      app.account = null;
      renderCoins();
      $("accountDialog").close();
      toast("Your account is closed.");
      return;
    case "bought":
      busy(false);
      setMsg(app.payMsg, `Added ${fmt(m.gc)} GC and ${fmt(m.sc)} free SC to your balance.`, true);
      sound.win();
      return;
    case "purchases": app.purchases = m.list; if (app.screen === "store") renderStore(); return;
    case "redemptions": app.redemptions = m.list; if ($("accountDialog").open) renderAccount(); return;
    case "redeemed": setMsg("accountMsg", "Cash-out requested. We review it and pay within a few days.", true); return;
    case "payout":
      if (app.results) { app.results.tx = m.tx || null; app.results.payoutFailed = Boolean(m.failed); renderLedger(app.results); }
      return;

    case "lookup":
      app.lookup = m.room;
      renderJoin();
      $("joinPreview").scrollIntoView({ block: "center", behavior: prefersReducedMotion ? "auto" : "smooth" });
      return;

    case "closed":
      resetRoom();
      show("home");
      setMsg("homeMsg", "The room was closed.");
      return;

    case "left":
      return;

    case "error": {
      busy(false);
      if (m.about === "intent") { if (intentWaiter) intentWaiter.reject(new Error(m.message)); return; }
      if (m.about === "deposit") return setMsg(app.payMsg, m.message);
      if (m.about === "auth" || m.about === "redeem" || m.about === "rg") return setMsg("accountMsg", m.message);
      if (m.about === "items") return setMsg("shopMsg", m.message);
      if (m.about === "store") { busy(false); return setMsg(app.screen === "store" ? "storeMsg" : "accountMsg", m.message); }
      if (m.about === "lookup" || m.about === "join") {
        if (m.about === "lookup") app.lookup = null;
        renderJoin();
        return setMsg("joinMsg", m.message);
      }
      if (app.screen === "search") { stopSearch(); show("home"); }
      if (app.screen === "home") setMsg("homeMsg", m.message);
      else if (app.screen === "room") setMsg("roomMsg", m.message);
      else toast(m.message);
      return;
    }
  }
}

function resetRoom() {
  app.room = null; app.q = null; app.results = null; app.picked = null;
  stopTimer();
  busy(false);
}

/* ======================================================================
   Home screen: name, mode tabs (Group / Head to Head), join with a code
   ====================================================================== */
const nameInput = $("nameInput");
nameInput.value = store.get("tt-name") || "";
nameInput.addEventListener("input", () => store.set("tt-name", nameInput.value.trim()));
const playerName = () => nameInput.value.trim() || "Player " + clientKey.slice(0, 3).toUpperCase();

const MODES = {
  group: {
    blurb: "Create a room and share the link with up to 7 friends. You start the match when everyone's in.",
    escrow: "Every player locks the same stake. The top score takes the <b>whole pot</b>, a shared top score splits it, and if everyone is level, everyone gets their stake back."
  },
  h2h: {
    blurb: "One on one. Get matched with a random player at the same stake, or send a challenge link to a friend. The match starts as soon as you're both in.",
    escrow: "You and your opponent lock the same stake. The winner takes <b>both stakes</b>; a tie refunds you in full."
  }
};
const REAL_NOTE = '<span class="demo-note">SOL stakes are real transfers of test SOL on Solana devnet. Test SOL has no value. Set Phantom to devnet first (Settings, Developer Settings, Testnet Mode).</span>';
const COIN_NOTE = {
  GC: '<span class="demo-note">Gold Coins are for fun: they come from your account and never cash out.</span>',
  SC: '<span class="demo-note">Sweeps Coins are free (1 on sign-up, 0.30 a day, and a bonus with Gold Coin packs). The house keeps 10% of a won pot; draws are refunded in full. Prize redemption is not open yet.</span>'
};
const isEscrowed = currency => Boolean(app.escrow) && currency === "SOL";
const isCoin = currency => currency === "GC" || currency === "SC";
/* The server keeps Sweeps Coins in cents and Gold Coins whole; these turn its units into coins */
const coinsOf = (currency, units) => (currency === "SC" ? units / 100 : units);
const coinText = (currency, units) => currency === "SC"
  ? `${(units / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SC`
  : `${fmt(units)} GC`;
/* What the winner of a full pot takes home after the house cut */
const winnings = (stake, players, rake = 0) => fmt(stake * players * (1 - rake));
function renderEscrowNote() {   // static text only
  const note = isCoin(app.currency) ? COIN_NOTE[app.currency] : isEscrowed(app.currency) ? REAL_NOTE : DEMO_NOTE;
  $("escrowNote").innerHTML = MODES[app.mode].escrow + "<br>" + note;
  $("stake").step = app.currency === "GC" ? "1" : "0.01";
}
const DEMO_NOTE = '<span class="demo-note">Prototype: the escrow is simulated on Solana devnet, so no real funds move.</span>';

/* Tabs with arrow-key support. The choice is remembered for next time. */
const tabs = ["group", "h2h"];
function selectTab(name, focus = false) {
  app.mode = name;
  store.set("tt-mode", name);
  tabs.forEach(t => {
    const on = t === name;
    const tab = $("tab-" + t);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  });
  $("modePane").setAttribute("aria-labelledby", "tab-" + name);
  $("modeBlurb").textContent = MODES[name].blurb;
  renderEscrowNote();
  document.querySelectorAll(".mode-actions").forEach(box => { box.hidden = box.dataset.mode !== name; });
  setMsg("homeMsg", "");
}
tabs.forEach((t, i) => {
  const tab = $("tab-" + t);
  tab.onclick = () => selectTab(t);
  tab.onkeydown = e => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d) { e.preventDefault(); selectTab(tabs[(i + d + tabs.length) % tabs.length], true); }
  };
});

document.querySelectorAll(".seg button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".seg button").forEach(x => { x.classList.remove("on"); x.setAttribute("aria-checked", "false"); });
  b.classList.add("on");
  b.setAttribute("aria-checked", "true");
  app.currency = b.dataset.cur;
  renderEscrowNote();
});

let isBusy = false;
function busy(on) {
  isBusy = on;
  ["createBtn", "findBtn", "challengeBtn", "joinConfirmBtn", "startBtn", "againBtn"].forEach(id => { $(id).classList.toggle("loading", on); });
  if (!on) renderJoin();
}

const recent = () => { try { return JSON.parse(store.get("tt-recent") || "[]"); } catch { return []; } };
function rememberQuestion(id) {
  const list = recent().filter(x => x !== id);
  list.push(id);
  store.set("tt-recent", JSON.stringify(list.slice(-30)));
}
const identity = () => (app.leaving = false, { name: playerName(), wallet: app.wallet ? app.wallet.address : null, recent: recent() });

/* Shared checks before any stake is locked. Returns the stake, or null after showing why not.
   Coin stakes need an account and a whole number of coins; the others need a wallet. */
async function readyToStake(msgId, consentId, currency) {
  const stake = parseFloat($("stake").value), creating = consentId === "agreeCreate";
  if (creating && currency === "GC" && !(Number.isInteger(stake) && stake >= 1)) { setMsg(msgId, "Enter a whole number of Gold Coins to stake."); return null; }
  if (creating && currency === "SC" && !(stake >= 0.01 && Math.abs(stake * 100 - Math.round(stake * 100)) < 1e-9)) { setMsg(msgId, "Enter a Sweeps Coin stake to the cent, from 0.01."); return null; }
  if (creating && !isCoin(currency) && !(stake >= 0.01 && stake <= 1000)) { setMsg(msgId, "Enter a stake between 0.01 and 1000."); return null; }
  if (!$(consentId).checked) { setMsg(msgId, "Confirm you are 18+ and accept the terms to continue."); return null; }
  if (isCoin(currency)) {
    if (!app.account) { openAccount(); setMsg(msgId, "Sign in to play for coins."); return null; }
    if (creating && stake > coinsOf(currency, app.account[currency])) { setMsg(msgId, `You have ${coinText(currency, app.account[currency])}.`); return null; }
  } else if (!app.wallet && !(await connectWallet())) { setMsg(msgId, "Connect a wallet to play for a stake."); return null; }
  return creating ? stake : true;
}

async function createRoom(mode) {
  if (isBusy) return;
  const stake = await readyToStake("homeMsg", "agreeCreate", app.currency);
  if (stake == null) return;
  busy(true);
  const lock = await lockStake(app.currency, { stake }, "homeMsg");
  if (lock) send({ type: "create", mode, stake, currency: app.currency, ...lock, ...identity() });
}
$("createBtn").onclick = () => createRoom("group");
$("challengeBtn").onclick = () => createRoom("h2h");

/* Head to head with a random opponent */
$("findBtn").onclick = async () => {
  if (isBusy) return;
  const stake = await readyToStake("homeMsg", "agreeCreate", app.currency);
  if (stake == null) return;
  findOpponent(stake, app.currency);
};
async function findOpponent(stake, currency) {
  let lock = {};
  if (isEscrowed(currency)) {       // real stakes are held while you wait, and refunded if you cancel
    busy(true);
    lock = await lockStake(currency, { stake }, "homeMsg");
    if (!lock) return;
  }
  setMsg("homeMsg", "");
  app.search = { stake, currency };
  send({ type: "findMatch", ...app.search, ...lock, ...identity() });
}

const search = { timer: 0, since: 0 };
function onSearching(m) {
  app.search = { stake: m.stake, currency: m.currency };
  busy(false);
  $("searchHint").textContent = isEscrowed(m.currency) || isCoin(m.currency)
    ? "Your stake is held in escrow while you wait. Cancel and it comes back, less the network fee."
    : "Your stake locks only when we find a match. Share the site with a friend to get a game faster.";
  $("searchSub").textContent = `Head to head for ${fmt(m.stake)} ${m.currency} each. Winner takes ${fmt(m.stake * 2)} ${m.currency}.`;
  if (app.screen !== "search") {
    search.since = Date.now();
    clearInterval(search.timer);
    const tick = () => {
      const s = Math.floor((Date.now() - search.since) / 1000);
      $("searchTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    search.timer = setInterval(tick, 1000);
    show("search");
  }
}
function stopSearch() {
  app.search = null;
  clearInterval(search.timer);
}
$("cancelSearchBtn").onclick = () => {
  stopSearch();
  send({ type: "cancelSearch" });
  show("home");
};

/* Join: look the code up first so the player can see the mode and stake before locking it */
const codeInput = $("codeInput");
const CODE_CHARS = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;
codeInput.addEventListener("input", () => {
  const clean = codeInput.value.toUpperCase().replace(CODE_CHARS, "").slice(0, 5);
  codeInput.value = clean;
  app.lookup = null;
  setMsg("joinMsg", "");
  if (clean.length === 5) lookupCode(clean);
  renderJoin();
});
codeInput.addEventListener("keydown", e => { if (e.key === "Enter") $("joinBtn").click(); });
function lookupCode(code) {
  codeInput.value = code;
  send({ type: "lookup", code });
}
$("agreeJoin").onchange = renderJoin;
$("joinBtn").onclick = () => { if (codeInput.value.length === 5) lookupCode(codeInput.value); };

function renderJoin() {
  const r = app.lookup, btn = $("joinConfirmBtn"), preview = $("joinPreview");
  $("joinBtn").disabled = codeInput.value.length !== 5;
  $("joinConsent").hidden = !r;
  preview.hidden = !r;
  btn.hidden = !r;
  preview.replaceChildren();
  if (!r) return;
  const h2h = r.mode === "h2h";
  const full = r.players >= r.maxPlayers, playing = !["lobby", "results"].includes(r.phase);
  preview.append(
    el("div", { className: "preview-head" },
      el("span", { className: "preview-code" }, r.code),
      el("span", { className: "mode-tag " + r.mode }, h2h ? "Head to Head" : "Group")),
    el("dl", {},
      el("dt", {}, h2h ? "Challenger" : "Host"), el("dd", {}, r.host || "—"),
      el("dt", {}, "Stake"), el("dd", {}, `${fmt(r.stake)} ${r.currency} each`),
      el("dt", {}, h2h ? "Winner gets" : "Players"),
      el("dd", {}, h2h ? `${winnings(r.stake, 2, r.rake)} ${r.currency}` : `${r.players} of ${r.maxPlayers}`)),
    ...(playing ? [el("p", { className: "warn" }, "A match is in progress. You can join once it finishes.")] : []),
    ...(h2h && !full && !playing ? [el("p", { className: "hint flush" }, "The match starts the moment you join.")] : [])
  );
  btn.textContent = h2h ? `Accept challenge: lock ${fmt(r.stake)} ${r.currency}` : `Lock ${fmt(r.stake)} ${r.currency} and join`;
  btn.disabled = isBusy || full || playing;
  if (full) btn.textContent = h2h ? "Challenge already taken" : "Room is full";
}

$("joinConfirmBtn").onclick = async () => {
  if (isBusy || !app.lookup) return;
  if ((await readyToStake("joinMsg", "agreeJoin", app.lookup.currency)) == null) return;
  busy(true);
  const code = app.lookup.code;
  const lock = await lockStake(app.lookup.currency, { code }, "joinMsg");
  if (lock) send({ type: "join", code, ...lock, ...identity() });
};

/* ======================================================================
   Room (waiting) screen
   ====================================================================== */
function onRoom(r) {
  if (app.leaving) return;          // a late update for a room we already walked out of
  const prev = app.room;
  app.room = r;
  busy(false);
  stopSearch();
  setMsg("homeMsg", "");
  setMsg("joinMsg", "");
  setMsg("resMsg", "");

  // Sounds and announcements for people arriving and leaving
  if (prev && prev.code === r.code) {
    const before = new Set(prev.players.map(p => p.id));
    const now = new Set(r.players.map(p => p.id));
    r.players.filter(p => !before.has(p.id)).forEach(p => { sound.join(); announce(`${p.name} joined`); });
    prev.players.filter(p => !now.has(p.id)).forEach(p => { announce(`${p.name} left`); if (r.phase === "results") toast(`${p.name} left the room`); });
  }

  renderRoom();
  renderChips();
  // Waiting rooms, and new arrivals while others are on the results screen
  if (r.phase === "lobby" || (r.phase === "results" && !app.results)) {
    if (app.screen !== "terms") show("room");
  } else if (r.phase === "results") {
    renderResultActions();
  }
}

function inviteLink() { return `${location.origin}${location.pathname}?room=${app.room.code}`; }
const me = () => app.room && app.room.players.find(p => p.id === app.room.you);
const isHost = () => app.room && app.room.hostId === app.room.you;
const opponent = () => app.room && app.room.players.find(p => p.id !== app.room.you);

function renderRoom() {
  const r = app.room;
  if (!r) return;
  const h2h = r.mode === "h2h";
  $("roomTitle").textContent = h2h ? "Challenge a friend" : isHost() ? "Your group room" : "You're in";
  $("roomSub").textContent = h2h
    ? "Send this link or code to the person you want to play. The match starts the moment they accept."
    : "Send this link or code to your friends so they can join.";
  if ($("roomCode").dataset.code !== r.code) {     // rebuild (and animate) only when the code changes
    $("roomCode").dataset.code = r.code;
    $("roomCode").replaceChildren(...[...r.code].map(c => el("span", {}, c)));
  }
  $("roomCode").setAttribute("aria-label", "Room code " + [...r.code].join(" "));
  $("roomStake").replaceChildren(
    el("div", {}, el("small", {}, "Stake each"), el("strong", {}, `${fmt(r.stake)} ${r.currency}`)),
    h2h
      ? el("div", {}, el("small", {}, r.rake ? "Winner gets (after 10% cut)" : "Winner gets"), el("strong", { className: "accent" }, `${winnings(r.stake, 2, r.rake)} ${r.currency}`))
      : el("div", {}, el("small", {}, "Pot so far"), el("strong", { className: "accent" }, `${fmt(r.pot)} ${r.currency}`))
  );
  $("playerCount").textContent = `${r.players.length}/${r.maxPlayers}`;
  const rows = r.players.map(p => el("li", { className: p.connected ? "" : "away" },
    miniCard(p),
    tint(el("span", { className: "pname" }, p.name, p.id === r.you ? el("em", {}, " (you)") : null), p),
    p.isHost && !h2h ? el("span", { className: "tag host" }, "Host") : null,
    !p.connected ? el("span", { className: "tag" }, "Reconnecting…") : null,
    el("span", { className: "addr" }, short(p.wallet))
  ));
  if (h2h && r.players.length < 2) {      // an empty seat makes the 1v1 obvious
    rows.push(el("li", { className: "empty" },
      el("span", { className: "avatar", ariaHidden: "true" }, "?"),
      el("span", { className: "pname" }, "Waiting…")));
  }
  $("playerList").replaceChildren(...rows);
  // On a computer the room shows everyone's full player card (the list above is for phones and screen readers)
  $("playerCards").replaceChildren(...r.players.map(p => el("li", { className: p.connected ? "" : "away" },
    cardFor(p, "small"),
    el("span", { className: "pc-tags" },
      p.id === r.you ? el("span", { className: "tag" }, "You") : null,
      p.isHost && !h2h ? el("span", { className: "tag host" }, "Host") : null,
      !p.connected ? el("span", { className: "tag" }, "Reconnecting…") : null))),
    ...Array.from({ length: Math.max(0, (h2h ? 2 : 4) - r.players.length) }, () => el("li", { className: "seat" }, el("span", {}, "Open seat"))));
  $("playerList").classList.toggle("versus", h2h);

  const enough = r.players.length >= 2;
  const host = r.players.find(p => p.isHost);
  $("startBtn").hidden = h2h || !isHost();
  $("startBtn").disabled = !enough;
  $("startBtn").textContent = r.matchNo ? "Start next match" : "Start match";
  $("roomHint").textContent = h2h
    ? "Keep this page open. You'll go straight into the match when they join."
    : isHost()
      ? (enough ? "Everyone in? Start when you're ready." : "Waiting for at least one more player to join…")
      : `Waiting for ${host ? host.name : "the host"} to start the match…`;
  $("shareBtn").hidden = !navigator.share;
}

async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch {   // clipboard can be blocked; fall back to a prompt the player can copy from
    window.prompt("Copy this:", text);
  }
}
$("copyCodeBtn").onclick = () => copy(app.room.code, "Room code copied");
$("copyLinkBtn").onclick = () => copy(inviteLink(), "Invite link copied");
$("shareBtn").onclick = () => navigator.share({
  title: "Tiki-Taka Trivia",
  text: app.room.mode === "h2h"
    ? `I challenge you to a Tiki-Taka Trivia head to head for ${fmt(app.room.stake)} ${app.room.currency}. Code: ${app.room.code}`
    : `Join my Tiki-Taka Trivia room. Code: ${app.room.code}`,
  url: inviteLink()
}).catch(() => {});
$("startBtn").onclick = () => { if (!isBusy) { setMsg("roomMsg", ""); send({ type: "start" }); } };
$("leaveRoomBtn").onclick = leaveRoom;
function leaveRoom() {
  app.leaving = true;
  send({ type: "leave" });
  resetRoom();
  app.lookup = null;
  renderJoin();
  show("home");
}

/* ======================================================================
   Arena
   ====================================================================== */
function renderChips() {
  const r = app.room;
  if (!r) return;
  const list = [...r.players].sort((a, b) => b.score - a.score);
  $("chips").replaceChildren(...list.map(p => {
    const pts = app.lastPoints[p.id];
    return el("li", {
      className: ["chip", app.answered.has(p.id) ? "locked" : "", p.id === r.you ? "you" : "", p.connected ? "" : "away"].join(" ")
    },
      tint(el("span", { className: "cname" }, p.id === r.you ? "You" : p.name), p),
      el("span", { className: "cscore" }, String(p.score)),
      pts != null && app.room.phase === "reveal" ? el("span", { className: "delta" + (pts ? "" : " zero") }, pts ? `+${pts}` : "+0") : null,
      el("span", { className: "tick", ariaLabel: "locked in" }, "✓")
    );
  }));
  const mine = me();
  if (mine) {
    $("myScore").textContent = mine.score;
    const rank = 1 + r.players.filter(p => p.score > mine.score).length;
    $("myRank").textContent = r.players.length > 1 ? `${ordinal(rank)} of ${r.players.length}` : "";
  }
}

function onCountdown(m) {
  app.results = null;
  app.lastPoints = {};
  app.answered = new Set();
  if (app.room) app.room.phase = "countdown";
  $("question").textContent = "";
  $("answers").replaceChildren();
  $("feedback").textContent = "";
  $("counter").textContent = `Question 1 of ${m.total}`;
  setPot();
  renderChips();
  show("arena");
  const box = $("countdown"), num = $("countdownNum");
  box.hidden = false;
  let n = Math.round(m.ms / 1000);
  const step = () => {
    if (n <= 0) { box.hidden = true; return; }
    num.textContent = n;
    num.classList.remove("pop"); void num.offsetWidth; num.classList.add("pop");
    sound.beep(n === 1);
    n--;
    setTimeout(step, 1000);
  };
  step();
}

function setPot() {
  const r = app.room;
  $("pot").textContent = fmt(r.pot);
  $("potCur").textContent = r.currency;
}

function onQuestion(m) {
  app.q = m;
  app.picked = m.yourChoice;
  app.answered = new Set(m.answered);
  app.lastPoints = {};
  rememberQuestion(m.id);
  if (app.room) app.room.phase = "question";
  $("countdown").hidden = true;
  if (app.room) setPot();
  show("arena");

  $("counter").textContent = `Question ${m.index + 1} of ${m.total}`;
  $("badge").className = "badge " + m.tier.cls;
  $("badgeText").textContent = m.tier.name;
  [...$("pips").children].forEach((p, i) => p.classList.toggle("on", i <= m.tier.level));
  const qEl = $("question");
  qEl.textContent = m.q;
  qEl.classList.remove("enter"); void qEl.offsetWidth; qEl.classList.add("enter");
  $("feedback").textContent = "";
  $("feedback").className = "feedback";

  $("answers").replaceChildren(...m.a.map((text, i) => {
    const b = el("button", { className: "ans", type: "button" },
      el("kbd", { ariaHidden: "true" }, String(i + 1)), el("span", {}, text));
    b.style.setProperty("--i", i);
    b.setAttribute("aria-label", `${i + 1}. ${text}`);
    b.onclick = () => pick(i);
    if (app.picked != null) { b.disabled = true; if (i === app.picked) b.classList.add("picked"); }
    return b;
  }));
  if (app.picked != null) $("feedback").textContent = "Locked in. Waiting for the others…";
  renderChips();
  startTimer(m.timeLeftMs, m.durationMs);
  qEl.focus({ preventScroll: true });
}

function pick(i) {
  if (!app.q || app.picked != null || app.room.phase !== "question") return;
  app.picked = i;
  sound.lock();
  const buttons = [...document.querySelectorAll(".ans")];
  buttons.forEach(b => { b.disabled = true; });
  buttons[i].classList.add("picked");
  $("feedback").textContent = "Locked in. Waiting for the others…";
  send({ type: "answer", index: app.q.index, choice: i });
}

document.addEventListener("keydown", e => {
  if (app.screen !== "arena" || e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
  const i = map[e.key.toLowerCase()];
  if (i != null && app.q && i < app.q.a.length) pick(i);
});

function onAnswered(m) {
  if (!app.q || m.index !== app.q.index) return;
  app.answered.add(m.id);
  renderChips();
}

/* Countdown bar runs locally from the time the server says is left */
const timer = { raf: 0, end: 0, dur: 10000, lastSec: null };
function startTimer(leftMs, durMs) {
  stopTimer();
  timer.end = performance.now() + leftMs;
  timer.dur = durMs;
  timer.lastSec = null;
  $("timer").setAttribute("aria-valuemax", String(Math.round(durMs / 1000)));
  const frame = () => {
    const left = Math.max(0, timer.end - performance.now());
    const frac = left / timer.dur;
    const bar = $("timerBar");
    bar.style.transform = `scaleX(${frac})`;
    bar.classList.toggle("low", frac < 0.3);
    const sec = Math.ceil(left / 1000);
    if (sec !== timer.lastSec) {
      timer.lastSec = sec;
      $("secs").textContent = sec;
      $("timer").setAttribute("aria-valuenow", String(sec));
      if (sec <= 3 && sec > 0 && app.picked == null) sound.tick();
    }
    if (left > 0) timer.raf = requestAnimationFrame(frame);
  };
  timer.raf = requestAnimationFrame(frame);
}
function stopTimer() { cancelAnimationFrame(timer.raf); }

function onReveal(m) {
  if (!app.room) return;
  stopTimer();
  app.room.phase = "reveal";
  app.lastPoints = Object.fromEntries(Object.entries(m.picks).map(([id, p]) => [id, p.points]));
  app.room.players.forEach(p => { if (m.scores[p.id] != null) p.score = m.scores[p.id]; });

  const buttons = [...document.querySelectorAll(".ans")];
  buttons.forEach(b => { b.disabled = true; });
  if (buttons[m.correct]) buttons[m.correct].classList.add("right");
  const mine = m.picks[app.room.you];
  const fb = $("feedback");
  if (mine && mine.choice === m.correct) {
    fb.textContent = `Correct! +${mine.points} points`;
    fb.className = "feedback good";
    sound.right();
  } else {
    if (mine && mine.choice != null && buttons[mine.choice]) buttons[mine.choice].classList.add("wrong");
    fb.textContent = mine && mine.choice != null ? "Not this time." : "Time's up!";
    fb.className = "feedback bad";
    sound.wrong();
  }
  // Show how many players picked each answer
  const counts = [0, 0, 0, 0];
  Object.values(m.picks).forEach(p => { if (p.choice != null) counts[p.choice]++; });
  if (app.room.players.length > 2) buttons.forEach((b, i) => {
    if (counts[i]) b.append(el("span", { className: "count", ariaLabel: `${counts[i]} picked this` }, `×${counts[i]}`));
  });
  renderChips();
}

/* ======================================================================
   Results
   ====================================================================== */
function onResults(m) {
  app.results = m;
  stopTimer();
  const youId = app.room ? app.room.you : null;
  const mine = m.standings.find(s => s.id === youId) || { score: 0, rank: 0, payout: 0 };
  const won = m.winnerIds.includes(youId);
  const cur = m.currency;
  const h2h = m.mode === "h2h";
  const rival = h2h ? m.standings.find(s => s.id !== youId) : null;
  const title = $("resTitle");
  title.className = "final";

  let text;
  if (m.outcome === "refund") {
    title.textContent = "Draw";
    title.classList.add("draw");
    text = h2h
      ? `Dead level with ${rival.name}. Both stakes were refunded.`
      : `Everyone finished level, so every stake was refunded (${fmt(m.stake)} ${cur} back to you).`;
  } else if (won && m.outcome === "win") {
    title.textContent = "You win";
    text = h2h
      ? `You beat ${rival.name}. The escrow released ${fmt(m.pot)} ${cur} to your wallet.`
      : `The escrow released the ${fmt(m.pot)} ${cur} pot to your wallet.`;
  } else if (won) {
    title.textContent = "Shared win";
    title.classList.add("draw");
    text = `You tied for the top score and split the pot: ${fmt(mine.payout)} ${cur} to you.`;
  } else {
    title.textContent = "You lose";
    title.classList.add("lose");
    const top = m.standings.filter(s => m.winnerIds.includes(s.id)).map(s => s.name).join(" and ");
    text = h2h ? `${top} beat you and took the ${fmt(m.pot)} ${cur}.` : `${top} took the ${fmt(m.pot)} ${cur} pot.`;
  }
  $("resSub").textContent = h2h
    ? `${mine.score} – ${rival.score} against ${rival.name}`
    : `You finished ${ordinal(mine.rank)} of ${m.standings.length} with ${mine.score} points`;
  $("resText").textContent = text;

  $("standings").replaceChildren(...m.standings.map(s => el("li", { className: s.id === youId ? "you" : "" },
    el("span", { className: "rank" }, String(s.rank)),
    tint(el("span", { className: "sname" }, s.id === youId ? "You" : s.name, s.left ? el("em", {}, " left") : null), s),
    el("span", { className: "spts" }, `${s.score} pts`),
    el("span", { className: "net " + (s.net > 0 ? "up" : s.net < 0 ? "down" : "") },
      (s.net > 0 ? "+" : "") + fmt(s.net) + " " + cur)
  )));

  renderLedger(m);
  renderResultActions();
  show("results");
  const winners = m.outcome === "refund" ? [] : m.standings.filter(s => m.winnerIds.includes(s.id));
  $("winnerCards").replaceChildren(...winners.slice(0, 2).map(s => cardFor(s, "big")));
  const showOff = winners.find(s => itemOf(s.look && s.look.celebration));
  if (showOff) celebrate(itemOf(showOff.look.celebration).value, showOff.name);
  if (won && m.outcome === "win") { if (!showOff) sound.win(); confetti(); } else if (!won && m.outcome !== "refund" && !showOff) sound.lose();
  else sound.right();
}

/* Settlement record. Built with DOM nodes so player names can't inject markup. */
function renderLedger(m) {
  const ledger = $("ledger"), cur = m.currency;
  ledger.replaceChildren();
  const line = (...parts) => ledger.append(el("div", {}, ...parts));
  const em = t => el("em", {}, t);
  line("escrow.tx  ", m.tx || (m.escrowed ? "…" : ""));
  m.standings.filter(s => s.payout > 0).forEach(s =>
    line(m.outcome === "refund" ? "refund" : "release", "(to=", em(short(s.wallet) || s.name), ", amount=", em(`${fmt(s.payout)} ${cur}`), ")"));
  if (!m.escrowed) {
    line("status: ", em("confirmed"));
    ledger.append(el("div", { className: "demo-note" }, "Simulated settlement on devnet. No real funds moved."));
    return;
  }
  if (isCoin(cur)) {
    line("status: ", m.payoutFailed ? el("b", { className: "bad" }, "payout failed, contact support") : em(m.tx ? "paid" : "paying…"));
    ledger.append(el("div", { className: "demo-note" }, `Paid into players' ${cur === "GC" ? "Gold Coin" : "Sweeps Coin"} balances.`));
    return;
  }
  line("status: ", m.payoutFailed ? el("b", { className: "bad" }, "payout failed, contact support") : em(m.tx ? "confirmed on Solana devnet" : "sending payout…"));
  if (m.tx) ledger.append(el("div", {}, el("a", { href: `https://explorer.solana.com/tx/${m.tx}?cluster=devnet`, target: "_blank", rel: "noopener" }, "View the payout on Solana Explorer")));
  ledger.append(el("div", { className: "demo-note" }, "Paid in test SOL on Solana devnet, less the network fee. Test SOL has no value."));
}

function renderResultActions() {
  const r = app.room;
  if (!r || app.screen === "arena" && r.phase !== "results") return;
  const again = $("againBtn"), hint = $("resHint"), newOpp = $("newOppBtn");

  if (r.mode === "h2h") {
    // Rematches need both players to agree
    const opp = opponent();
    const iAsked = r.rematch.includes(r.you), theyAsked = opp && r.rematch.includes(opp.id);
    $("resLeaveBtn").textContent = "Back to menu";
    newOpp.hidden = false;
    again.hidden = !opp;
    again.disabled = iAsked;
    again.textContent = iAsked ? "Rematch requested" : theyAsked ? "Accept rematch" : "Rematch";
    again.classList.toggle("glow", Boolean(theyAsked && !iAsked));
    const name = app.results ? (app.results.standings.find(s => s.id !== r.you) || {}).name : "Your opponent";
    hint.textContent = !opp
      ? (r.matched ? `${name} left. Find a new opponent at the same stake?` : `${name} left. Share code ${r.code} to challenge someone else.`)
      : iAsked ? `Waiting for ${opp.name} to accept…`
      : theyAsked ? `${opp.name} wants a rematch for ${fmt(r.stake)} ${r.currency}.`
      : r.escrowed ? `Same stake again? You both pay ${fmt(r.stake)} ${r.currency} for a rematch.`
      : "Same stake again? You both need to agree to a rematch.";
    return;
  }

  newOpp.hidden = true;
  again.classList.remove("glow");
  $("resLeaveBtn").textContent = "Leave room";
  const host = r.players.find(p => p.isHost);
  again.hidden = !isHost();
  again.textContent = "Rematch";
  again.disabled = r.players.length < 2;
  hint.textContent = isHost()
    ? (r.players.length < 2 ? "Everyone else left. Share the code to get more players in." : `Same room, same ${fmt(r.stake)} ${r.currency} stake. New players can still join with code ${r.code}.`)
    : `Waiting for ${host ? host.name : "the host"} to start a rematch. Room code ${r.code}.`;
  if (!r.escrowed) return;
  // Real stakes: everyone pays again before the next match can start
  const mine = me(), owing = r.players.filter(p => !p.paid);
  if (mine && !mine.paid) {
    again.hidden = false;
    again.disabled = false;
    again.textContent = `Stake ${fmt(r.stake)} ${r.currency} for the next match`;
    hint.textContent = "Each match needs a new stake. Leave the room if you're done.";
  } else if (owing.length) {
    again.disabled = true;
    hint.textContent = `Waiting for ${owing.map(p => p.name).join(", ")} to stake for the next match.`;
  }
}

$("againBtn").onclick = async () => {
  const r = app.room;
  if (isBusy || !r) return;
  if (r.escrowed && !me().paid) {
    busy(true);
    const lock = await lockStake(r.currency, { room: true }, "resMsg");
    if (lock) send({ type: "pay", rematch: r.mode === "h2h", ...lock });   // in head to head, paying is your vote
    return;
  }
  send({ type: "rematch" });
};
$("resLeaveBtn").onclick = leaveRoom;
/* Straight back into matchmaking at the same stake */
$("newOppBtn").onclick = () => {
  if (!app.room) return;
  const again = { stake: app.room.stake, currency: app.room.currency };
  leaveRoom();
  findOpponent(again.stake, again.currency);
};

function confetti() {
  if (prefersReducedMotion) return;
  const box = $("confetti");
  const colors = ["#c9a45a", "#f0d9a4", "#ffffff", "#6fd39a", "#8f8a84"];
  box.replaceChildren(...Array.from({ length: 40 }, () => {
    const s = el("i");
    s.style.left = Math.random() * 100 + "%";
    s.style.background = colors[Math.floor(Math.random() * colors.length)];
    s.style.animationDelay = Math.random() * 0.6 + "s";
    s.style.animationDuration = 1.6 + Math.random() * 1.2 + "s";
    s.style.setProperty("--x", (Math.random() * 120 - 60) + "px");
    s.style.setProperty("--r", (Math.random() * 720 - 360) + "deg");
    return s;
  }));
  setTimeout(() => box.replaceChildren(), 3500);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ======================================================================
   Paying a stake. With an escrow on the server, SOL stakes are real transfers on Solana devnet:
   ask the server what to pay, have Phantom sign it, send it, and hand the server the signature.
   ====================================================================== */
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const fmt4 = n => (Math.round(n * 1e4) / 1e4).toLocaleString(undefined, { maximumFractionDigits: 4 });

let web3Loading = null;       // the Solana library is big, so it only loads when a payment needs it
const loadWeb3 = () => web3Loading || (web3Loading = new Promise((resolve, reject) => {
  document.head.append(el("script", {
    src: "/vendor/web3.js", onload: resolve,
    onerror: () => { web3Loading = null; reject(new Error("Couldn't load the Solana library. Check your connection and try again.")); }
  }));
}));

let intentWaiter = null;
const askIntent = req => new Promise((resolve, reject) => {
  intentWaiter = { resolve, reject };
  send({ type: "intent", ...req });
  setTimeout(() => reject(new Error("The server didn't answer. Try again.")), 15000);
});

async function payStake(req, msgId) {
  if (!app.wallet || app.wallet.kind !== "phantom") throw new Error("SOL stakes need the Phantom wallet. A demo wallet can only play USDC rooms.");
  setMsg(msgId, "Preparing your stake…", true);
  const [intent] = await Promise.all([askIntent(req), loadWeb3()]);
  const { Connection, PublicKey, Transaction, SystemProgram, TransactionInstruction } = window.solanaWeb3;
  const conn = new Connection(intent.rpc, "confirmed");
  const from = new PublicKey(app.wallet.address);
  if (await conn.getBalance(from) < intent.lamports + 10000) {
    throw new Error(`You need ${fmt4(intent.lamports / 1e9)} devnet SOL plus a small fee. Get free test SOL at faucet.solana.com.`);
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(intent.to), lamports: intent.lamports }),
    // The memo is how the server knows this payment is yours
    new TransactionInstruction({ keys: [], programId: new PublicKey(MEMO_PROGRAM), data: new TextEncoder().encode(intent.ref) }));
  tx.feePayer = from;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  setMsg(msgId, "Approve the transfer in Phantom…", true);
  const signed = await provider().signTransaction(tx);
  setMsg(msgId, "Confirming your stake on Solana devnet…", true);
  // We send it to devnet ourselves, so it can never land on the real-money network
  const signature = await conn.sendRawTransaction(signed.serialize());
  return { ref: intent.ref, signature };
}

/* Returns what to attach to the next message ({} when simulated or for coins), or null if the payment didn't happen */
async function lockStake(currency, req, msgId) {
  app.payMsg = msgId;
  if (isCoin(currency)) { setMsg(msgId, "Taking your stake…", true); return {}; }   // the server takes coins from the account
  if (!isEscrowed(currency)) {
    setMsg(msgId, "Signing and locking your stake in escrow…", true);
    await sleep(700);   // mock signing delay, so it feels like a transaction
    return {};
  }
  try { return { deposit: await payStake(req, msgId) }; }
  catch (err) {
    busy(false);
    setMsg(msgId, /reject|cancel|denied/i.test(err.message || "") ? "Payment cancelled. Nothing was taken." : err.message || "The payment didn't go through.");
    return null;
  }
}

/* ======================================================================
   Wallet: real Phantom on Solana devnet, or a demo wallet
   ====================================================================== */
const DEVNET_RPC = "https://api.devnet.solana.com";
const provider = () => {
  const p = window.phantom?.solana || window.solana;
  return p && p.isPhantom ? p : null;
};
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

async function fetchBalance(address) {
  try {
    const res = await fetch(DEVNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] })
    });
    const data = await res.json();
    return typeof data?.result?.value === "number" ? data.result.value / 1e9 : null;
  } catch { return null; }
}

function setWallet(w) {
  app.wallet = w;
  renderWallet();
  renderCoins();                    // the wallet button shows once a wallet is connected
  if (w && w.kind === "phantom") fetchBalance(w.address).then(b => {
    if (app.wallet && app.wallet.address === w.address) { app.wallet.balance = b; renderWallet(); }
  });
}

function renderWallet() {
  const btn = $("walletBtn"), w = app.wallet;
  btn.classList.toggle("connected", Boolean(w));
  btn.replaceChildren();
  if (!w) { btn.textContent = matchMedia("(max-width: 520px)").matches ? "Wallet" : "Connect wallet"; return; }
  btn.append(el("span", { className: "dot" }), short(w.address));
  if (w.balance != null) btn.append(el("small", {}, ` · ${fmt(w.balance)} SOL`));
  if (w.kind === "demo") btn.append(el("small", {}, " · demo"));
}

/* Resolves true once a wallet is connected, false if the player backed out */
let walletResolve = null;
async function connectWallet() {
  const p = provider();
  if (p) {
    try {
      $("walletBtn").textContent = "Connecting…";
      const res = await p.connect();
      setWallet({ address: res.publicKey.toString(), kind: "phantom", balance: null });
      toast("Phantom connected (devnet)");
      return true;
    } catch {
      renderWallet();
      setMsg("homeMsg", "Phantom connection was cancelled.");
      return false;
    }
  }
  return new Promise(resolve => { walletResolve = resolve; openWalletDialog(); });
}

function openWalletDialog() {
  const d = $("walletDialog"), body = $("walletBody"), actions = $("walletActions");
  const w = app.wallet;
  body.replaceChildren();
  actions.replaceChildren();
  if (w) {
    $("walletTitle").textContent = w.kind === "demo" ? "Demo wallet" : "Phantom wallet";
    body.append(
      el("p", { className: "mono" }, w.address),
      el("p", { className: "sub tight" }, w.kind === "demo"
        ? "A made-up address for trying the game. It holds nothing."
        : `Network: Solana devnet${w.balance != null ? ` · Balance ${fmt(w.balance)} SOL` : ""}`)
    );
    actions.append(
      el("button", { className: "btn", value: "close" }, "Close"),
      el("button", { className: "btn danger", value: "disconnect", onclick: disconnectWallet }, "Disconnect")
    );
  } else {
    $("walletTitle").textContent = "Connect a wallet";
    const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
    body.append(
      el("p", { className: "sub tight" }, "Phantom isn't available in this browser. You can install it, or try the game with a demo wallet."),
      el("div", { className: "wallet-options" },
        isMobile
          ? el("a", { className: "btn wide", href: `https://phantom.app/ul/browse/${here}?ref=${ref}` }, "Open in the Phantom app")
          : el("a", { className: "btn wide", href: "https://phantom.app/download", target: "_blank", rel: "noopener" }, "Install Phantom"),
        el("button", { className: "btn solid wide", value: "demo", onclick: useDemoWallet }, "Use a demo wallet"))
    );
    actions.append(el("button", { className: "btn ghost", value: "cancel" }, "Cancel"));
  }
  d.showModal();
}

function useDemoWallet() {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let addr = store.get("tt-demo-wallet");
  if (!addr) {
    addr = Array.from(crypto.getRandomValues(new Uint8Array(44)), b => B58[b % 58]).join("");
    store.set("tt-demo-wallet", addr);
  }
  setWallet({ address: addr, kind: "demo", balance: null });
  toast("Demo wallet connected");
}

function disconnectWallet() {
  const p = provider();
  if (app.wallet?.kind === "phantom" && p) p.disconnect().catch(() => {});
  setWallet(null);
}

$("walletDialog").addEventListener("close", () => {
  if (walletResolve) { walletResolve(Boolean(app.wallet)); walletResolve = null; }
});
$("walletBtn").onclick = () => {
  if (app.wallet || !provider()) openWalletDialog();
  else connectWallet();
};

// Reconnect silently if this site is already trusted in Phantom, and follow account switches
(function initPhantom() {
  const p = provider();
  if (!p) return;
  p.connect({ onlyIfTrusted: true })
    .then(res => setWallet({ address: res.publicKey.toString(), kind: "phantom", balance: null }))
    .catch(() => {});
  p.on?.("accountChanged", pk => {
    if (pk) setWallet({ address: pk.toString(), kind: "phantom", balance: null });
    else setWallet(null);
  });
  p.on?.("disconnect", () => { if (app.wallet?.kind === "phantom") setWallet(null); });
})();

/* ======================================================================
   Account and coins: Gold Coins are bought and played for fun; Sweeps Coins
   are free (sign-up, daily, and a bonus with each pack) and played for prizes.
   ====================================================================== */
function renderCoins() {
  const on = Boolean(app.coins), crypto = app.cryptoStakes !== false, a = app.account, btn = $("accountBtn");
  btn.hidden = !on;
  $("storeBtn").hidden = !on;
  document.querySelectorAll(".coin-only").forEach(b => { b.hidden = !on; });
  // With crypto stakes off, rooms are played for coins only and a wallet is only needed to buy a pack
  document.querySelectorAll(".crypto-only").forEach(b => { b.hidden = !crypto; });
  $("walletBtn").hidden = !crypto && !app.wallet;
  if (!on && isCoin(app.currency)) document.querySelector('.seg [data-cur="SOL"]').click();
  if (!crypto && !isCoin(app.currency)) document.querySelector('.seg [data-cur="GC"]').click();
  btn.replaceChildren(...(a
    ? [el("span", {}, a.username), el("small", {}, ` · ${coinText("GC", a.GC)} · ${coinText("SC", a.SC)}`)]
    : ["Sign in"]));
  if ($("accountDialog").open) renderAccount();
  if (app.screen === "store") renderStore();
  renderHomeCard();
}

function renderAccount() {
  const body = $("accountBody"), a = app.account;
  body.replaceChildren();
  if (!a) {
    $("accountTitle").textContent = "Sign in to play for coins";
    const user = el("input", { type: "text", id: "accUser", autocomplete: "username", maxLength: 20, spellcheck: false });
    const pass = el("input", { type: "password", id: "accPass", autocomplete: "current-password", maxLength: 200 });
    const agree = el("input", { type: "checkbox", id: "accAgree" });
    const go = type => () => {
      setMsg("accountMsg", "");
      if (type === "register" && !agree.checked) return setMsg("accountMsg", "Confirm you are 18 or older and accept the terms and privacy notice.");
      send({ type, username: user.value.trim(), password: pass.value, ...(type === "register" ? { acceptTerms: true } : {}) });
    };
    body.append(
      el("p", { className: "sub tight" }, "New accounts start with 10,000 Gold Coins and 1 Sweeps Coin."),
      el("label", { className: "field" }, el("span", {}, "Username"), user),
      el("label", { className: "field" }, el("span", {}, "Password (8 characters or more)"), pass),
      el("label", { className: "consent" }, agree, el("span", {}, "New account: I am 18 or older and accept the ",
        el("a", { href: "#terms" }, "terms"), " and ",
        el("a", { href: "#privacy" }, "privacy notice"), ".")),
      el("div", { className: "wallet-options" },
        el("button", { className: "btn solid wide", type: "button", onclick: go("login") }, "Sign in"),
        el("button", { className: "btn wide", type: "button", onclick: go("register") }, "Create account")));
    pass.addEventListener("keydown", e => { if (e.key === "Enter") go("login")(); });
    return;
  }
  $("accountTitle").textContent = a.username;
  if (!a.termsCurrent) body.append(el("div", { className: "draft" },
    "Our ", el("a", { href: "#terms" }, "terms"), " and ", el("a", { href: "#privacy" }, "privacy notice"),
    " have changed. Accept them to keep playing.",
    el("button", { className: "btn solid wide", type: "button", onclick: () => send({ type: "acceptTerms" }) }, "I accept")));
  if (a.pausedUntil) body.append(el("div", { className: "draft" },
    `${a.pauseKind === "exclusion" ? "You've excluded yourself" : "You're taking a break"} until ${longDate(a.pausedUntil)}. You can't play, claim free coins or buy coins until then.`));
  body.append(el("div", { className: "my-card" }, cardFor({ name: a.username, look: a.look }),
    el("p", { className: "hint" }, "Your player card. Play matches to raise your rating, and change its design in the store.")));
  const balance = (code, name, note) => el("div", {}, el("small", {}, name), el("strong", {}, coinText(code, a[code])), el("span", { className: "t-note" }, note));
  body.append(
    el("div", { className: "stake-strip" },
      balance("GC", "Gold Coins", "Buy items or play for fun. Never cashed out."),
      balance("SC", "Sweeps Coins", "Free. Played for prizes.")),
    el("button", {
      className: "btn solid wide", type: "button", disabled: !a.dailyReady || Boolean(a.pausedUntil),
      onclick: () => { setMsg("accountMsg", ""); send({ type: "claimDaily" }); }
    }, a.pausedUntil ? "Free coins are paused" : a.dailyReady ? "Claim today's free coins" : "Free coins claimed today. Back tomorrow."));
  body.append(el("button", {
    className: "btn wide", type: "button", onclick: () => { $("accountDialog").close(); openStore(); }
  }, "Open the store"));
  body.append(...cashOutSection(a), safetySection(a), dataSection());
  body.append(el("button", {
    className: "btn ghost wide", type: "button",
    onclick: () => { send({ type: "logout", session: store.get("tt-session") }); store.set("tt-session", ""); }
  }, "Sign out"));
}

/* Cashing out Sweeps Coins: only shown once the server has it switched on */
function cashOutSection(a) {
  const c = app.coins || {};
  if (!c.redemption) return [el("p", { className: "hint" }, "Cashing out Sweeps Coins isn't open yet.")];
  const amount = el("input", { type: "number", id: "redeemAmount", min: c.redeemMin / 100, step: "0.01", inputMode: "decimal", placeholder: String(c.redeemMin / 100) });
  const wallet = el("input", { type: "text", id: "redeemWallet", spellcheck: false, autocomplete: "off", placeholder: "Solana wallet address", value: app.wallet && app.wallet.kind === "phantom" ? app.wallet.address : "" });
  const list = app.redemptions || [];
  return [
    el("h3", { className: "list-title" }, "Cash out Sweeps Coins"),
    el("p", { className: "hint" }, `You can cash out ${coinText("SC", a.redeemable)} (1 SC = $1 in USDC, at least ${c.redeemMin / 100} SC). Free coins count once you've played them in a match.${a.verified ? "" : " We check your identity and age before your first cash-out."}`),
    el("label", { className: "field" }, el("span", {}, "Sweeps Coins to cash out"), amount),
    el("label", { className: "field" }, el("span", {}, "Pay to this Solana wallet (USDC)"), wallet),
    el("button", {
      className: "btn wide", type: "button", disabled: a.redeemable < c.redeemMin,
      onclick: () => { setMsg("accountMsg", ""); send({ type: "redeem", amount: Number(amount.value), wallet: wallet.value.trim() }); }
    }, a.redeemable < c.redeemMin ? `Reach ${c.redeemMin / 100} SC to cash out` : "Request cash-out"),
    ...(list.length ? [el("ul", { className: "players" }, ...list.map(r => el("li", {},
      el("span", { className: "pname" }, coinText("SC", r.amount), el("em", {}, ` · ${new Date(r.at).toLocaleDateString()}`)),
      el("span", { className: "tag" + (r.status === "paid" ? " host" : "") }, r.status === "pending" ? "Waiting for review" : r.status === "paid" ? "Paid" : "Returned"))))] : [])
  ];
}

const longDate = iso => new Date(iso).getFullYear() > new Date().getFullYear() + 50 ? "you ask us to lift it" : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const dollars = cents => `$${(cents / 100).toFixed(2)}`;

/* A folding account section that stays open when the account redraws */
const openSections = new Set();
const fold = (title, ...kids) => el("details", { className: "acct-more", open: openSections.has(title),
  ontoggle: e => openSections[e.target.open ? "add" : "delete"](title) }, el("summary", {}, title), ...kids);

/* Spending limit, breaks and self-exclusion */
function safetySection(a) {
  const limit = el("input", { type: "number", min: 0, step: "1", inputMode: "decimal", placeholder: "e.g. 50" });
  const pause = choice => {
    const long = choice.startsWith("exclude");
    if (long && !confirm("Self-exclusion can't be shortened or undone early. Exclude yourself?")) return;
    setMsg("accountMsg", "");
    send({ type: "pause", choice });
  };
  const excludeFor = el("select", {},
    el("option", { value: "exclude-182" }, "6 months"), el("option", { value: "exclude-365" }, "1 year"), el("option", { value: "exclude-forever" }, "Permanently"));
  const p = a.pendingLimit;
  return fold("Play safely",
    el("p", { className: "hint" }, `Spent on coin packs this month: ${dollars(a.spentThisMonth)}. ` +
      (a.spendLimit == null ? "No monthly limit set." : `Monthly limit: ${dollars(a.spendLimit)}.`) +
      (p ? ` Changing to ${p.cents == null ? "no limit" : dollars(p.cents)} on ${longDate(p.at)}.` : "") +
      " A lower limit applies at once; a higher one or removing it waits 24 hours."),
    el("label", { className: "field" }, el("span", {}, "Monthly spending limit ($)"), limit),
    el("div", { className: "wallet-options" },
      el("button", { className: "btn wide", type: "button", onclick: () => { setMsg("accountMsg", ""); send({ type: "setLimit", usd: limit.value === "" ? NaN : Number(limit.value) }); } }, "Set limit"),
      a.spendLimit != null && !(p && p.cents == null) ? el("button", { className: "btn ghost wide", type: "button", onclick: () => send({ type: "setLimit", usd: null }) }, "Remove limit") : null),
    el("h3", { className: "list-title" }, "Take a break"),
    el("p", { className: "hint" }, "Stop playing and buying for a while. A break can be made longer but not shorter."),
    el("div", { className: "wallet-options" },
      ...[["break-1", "24 hours"], ["break-7", "7 days"], ["break-30", "30 days"]].map(([c, t]) =>
        el("button", { className: "btn wide", type: "button", onclick: () => pause(c) }, t))),
    el("h3", { className: "list-title" }, "Self-exclusion"),
    el("p", { className: "hint" }, "For a longer stop. If gambling is causing you harm, a free local problem-gambling helpline can help."),
    el("label", { className: "field" }, el("span", {}, "Exclude me for"), excludeFor),
    el("button", { className: "btn wide", type: "button", onclick: () => pause(excludeFor.value) }, "Exclude me"));
}

/* Download or delete what we hold */
function dataSection() {
  const pass = el("input", { type: "password", autocomplete: "current-password", maxLength: 200 });
  return fold("Your data",
    el("p", { className: "hint" }, "Download everything we hold about your account, or close it. See the ",
      el("a", { href: "#privacy" }, "privacy notice"), "."),
    el("button", { className: "btn wide", type: "button", onclick: () => send({ type: "exportData" }) }, "Download my data"),
    el("h3", { className: "list-title" }, "Close my account"),
    el("p", { className: "hint" }, "Your coins are removed and you can't get the account back. We keep payment and coin records the law requires, without your username."),
    el("label", { className: "field" }, el("span", {}, "Password to confirm"), pass),
    el("button", { className: "btn ghost wide", type: "button", onclick: () => {
      if (!confirm("Close your account for good? Your coins will be gone.")) return;
      setMsg("accountMsg", "");
      send({ type: "deleteAccount", password: pass.value });
    } }, "Close my account"));
}

function openAccount() {
  setMsg("accountMsg", "");
  renderAccount();
  $("accountDialog").showModal();
  if (app.account && app.coins && app.coins.redemption) send({ type: "redemptions" });
}
$("accountBtn").onclick = openAccount;
$("accountClose").onclick = () => $("accountDialog").close();

/* ----- the coin store ----- */
function openStore() {
  if (app.screen === "arena") return;
  if (app.screen !== "store") app.beforeStore = app.screen;
  setMsg("storeMsg", "");
  renderStore();
  show("store");
  if (app.account) send({ type: "purchases" });
}
$("storeBtn").onclick = openStore;
$("storeBack").onclick = () => show(screenForRoom() || app.beforeStore || "home");

function renderStore() {
  const packs = (app.coins && app.coins.packs) || {}, a = app.account, open = Boolean(app.coins && app.coins.packs);
  const first = !a || a.firstPurchase;
  $("firstBanner").hidden = !open || !first;
  // The welcome offer is only for an account's first purchase, so it disappears after one
  $("packGrid").replaceChildren(...Object.entries(packs).filter(([, p]) => first || !p.firstOnly).map(([id, p]) =>
    el("li", { className: "pack" + (p.tag ? " tagged" : "") },
      p.tag ? el("span", { className: "pack-tag" }, p.tag) : null,
      el("span", { className: "pack-name" }, p.name),
      el("strong", { className: "pack-gc" }, `${fmt(p.gc)} GC`),
      el("span", { className: "pack-sc" }, `+ ${p.sc} Sweeps Coin${p.sc === 1 ? "" : "s"} free`),
      el("button", { className: "btn solid wide", type: "button", onclick: () => buyPack(id) }, `Buy for $${p.usd.toFixed(2)}`),
      el("span", { className: "pack-extra" }, `Paid as ${fmt4(p.lamports / 1e9)} SOL`))));
  if (!open) $("packGrid").replaceChildren(el("li", { className: "pack-closed" }, "Coin packs go on sale once payments are switched on. Until then, claim free daily coins from your account."));
  renderShop();
  const list = (a && app.purchases) || [];
  $("historyBox").hidden = !list.length;
  $("purchaseList").replaceChildren(...list.map(p => el("li", {},
    el("span", { className: "pname" }, p.name, el("em", {}, ` · ${new Date(p.at).toLocaleDateString()}`)),
    el("a", { className: "addr", href: `https://explorer.solana.com/tx/${p.signature}?cluster=devnet`, target: "_blank", rel: "noopener" }, "Receipt"))));
}

/* ----- what players wear: Gold Coin items, looked up by id in the server's catalogue ----- */
const itemOf = id => (id && app.coins && app.coins.items && Object.hasOwn(app.coins.items, id) && app.coins.items[id]) || null;
const RARITY = { common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary" };

/* A name in the player's colour, or animated style */
function tint(node, p) {
  const c = itemOf(p.look && p.look.color);
  if (c && c.value.startsWith("anim-")) node.classList.add("name-" + c.value);
  else if (c) node.style.color = c.value;
  return node;
}

/* The player card: design from their card item, rating and stats from their record (Bronze until they buy one) */
const designOf = p => { const c = itemOf(p.look && p.look.card); return c ? c.value : "bronze"; };
function miniCard(p) {
  const r = p.look && p.look.rating;
  return el("span", { className: "pmini d-" + designOf(p), title: r ? `Rating ${r}` : "" }, r ? String(r) : (p.name[0] || "?").toUpperCase());
}
function cardFor(p, extra = "") {
  const look = p.look || {}, st = look.stats || {};
  const stat = (label, v) => el("span", {}, el("b", {}, v == null ? "–" : String(v)), label);
  return el("div", { className: `pcard d-${designOf(p)} ${extra}` },
    el("span", { className: "pc-top" }, el("strong", { className: "pc-rating" }, look.rating ? String(look.rating) : "–"), el("small", {}, "TTT")),
    el("span", { className: "pc-face", ariaHidden: "true" }, (p.name[0] || "?").toUpperCase()),
    el("span", { className: "pc-name" }, p.name),
    el("span", { className: "pc-stats" }, stat("ACC", st.acc), stat("SPD", st.spd), stat("WIN", st.win), stat("MP", st.mp)));
}

/* Home screen side panel on a computer: your card and coins, or an invitation to sign in */
function renderHomeCard() {
  const box = $("homeCard"), a = app.account;
  if (!app.coins) return box.replaceChildren();
  if (!a) return box.replaceChildren(
    cardFor({ name: "You", look: {} }),
    el("div", {}, el("h3", { className: "list-title" }, "Get your player card"),
      el("p", { className: "hint" }, "Sign up for 10,000 Gold Coins and 1 Sweeps Coin. Your card's rating grows with every match."),
      el("button", { className: "btn solid", type: "button", onclick: openAccount }, "Sign up free")));
  box.replaceChildren(
    cardFor({ name: a.username, look: a.look }),
    el("div", {},
      el("h3", { className: "list-title" }, a.username),
      el("p", { className: "home-bal" }, el("strong", {}, coinText("GC", a.GC)), el("strong", {}, coinText("SC", a.SC))),
      el("div", { className: "home-actions" },
        a.dailyReady && !a.pausedUntil ? el("button", { className: "btn solid small", type: "button", onclick: () => send({ type: "claimDaily" }) }, "Claim free coins") : null,
        el("button", { className: "btn small", type: "button", onclick: openStore }, "Store"))));
}

/* ----- celebrations: take over the screen when someone wins (everyone in the room sees the winner's) ----- */
const CELEBRATION_ICONS = { confetti: "🎉", fireworks: "🎆", trophy: "🏆", net: "⚽", goldrain: "🪙" };
function celebrate(kind, name) {
  document.querySelector(".celebration")?.remove();
  const box = el("div", { className: `celebration is-${kind}`, ariaHidden: "true" }, el("div", { className: "cel-dim" }));
  const head = el("div", { className: "cel-head" },
    el("strong", {}, kind === "net" ? "GOOOAL!" : kind === "trophy" ? "CHAMPION" : kind === "goldrain" ? "LEGENDARY" : "WINNER"),
    el("span", {}, name));
  document.body.append(box);
  setTimeout(() => box.remove(), 4200);
  sound.crowd();
  if (prefersReducedMotion) { box.append(head); return; }

  const canvas = el("canvas"), ctx = canvas.getContext("2d");
  const W = canvas.width = innerWidth, H = canvas.height = innerHeight;
  box.append(canvas);
  const parts = [], rnd = (a, b) => a + Math.random() * (b - a);
  const COLORS = ["#e8c26a", "#5fd38d", "#6cc4ff", "#ff6b6b", "#b48cff", "#fff"];
  const confettiBurst = (x, dir, n, colors = COLORS) => { for (let i = 0; i < n; i++) parts.push({
    x, y: H + 10, vx: dir * rnd(3, 11), vy: -rnd(13, 22), g: 0.38, w: rnd(6, 11), h: rnd(10, 16), r: rnd(0, 6), vr: rnd(-0.3, 0.3),
    c: colors[i % colors.length], life: 1, fade: 0.004, shape: "rect" }); };
  const firework = () => {
    const x = rnd(W * 0.15, W * 0.85), y = rnd(H * 0.12, H * 0.45), c = COLORS[Math.floor(rnd(0, 5))];
    for (let i = 0; i < 70; i++) { const a = (i / 70) * Math.PI * 2, v = rnd(2, 6.5);
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0.06, w: 3, h: 3, r: 0, vr: 0, c, life: 1, fade: 0.014, shape: "dot" }); }
    sound.pop();
  };
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));

  if (kind === "confetti") { confettiBurst(0, 1, 90); confettiBurst(W, -1, 90); at(700, () => { confettiBurst(0, 1, 60); confettiBurst(W, -1, 60); }); }
  if (kind === "fireworks") for (let i = 0; i < 9; i++) at(i * 380, firework);
  if (kind === "trophy") {
    box.append(el("div", { className: "cel-trophy" }, "🏆"));
    at(900, () => { confettiBurst(0, 1, 70, ["#e8c26a", "#fff", "#f3d27a"]); confettiBurst(W, -1, 70, ["#e8c26a", "#fff", "#f3d27a"]); sound.win(); });
  }
  if (kind === "net") {
    box.append(el("div", { className: "cel-net" }), el("div", { className: "cel-ball" }, "⚽"), el("div", { className: "cel-flash" }));
    at(650, () => {
      box.classList.add("shake"); sound.boom();
      for (let i = 0; i < 60; i++) { const a = rnd(0, Math.PI * 2), v = rnd(3, 10);
        parts.push({ x: W / 2, y: H * 0.42, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0.2, w: 4, h: 4, r: 0, vr: 0, c: "#fff", life: 1, fade: 0.018, shape: "dot" }); }
    });
  }
  if (kind === "goldrain") {
    box.append(el("div", { className: "cel-glow" }));
    for (let i = 0; i < 140; i++) parts.push({ x: rnd(0, W), y: rnd(-H, -10), vx: rnd(-0.6, 0.6), vy: rnd(3, 7), g: 0.03, w: rnd(9, 15), h: 0,
      r: rnd(0, 6), vr: rnd(0.05, 0.15), c: "#e8c26a", life: 1, fade: 0.002, shape: "coin" });
    at(300, () => sound.win());
  }
  at(kind === "net" ? 650 : kind === "trophy" ? 500 : 250, () => box.append(head));

  const t0 = performance.now();
  (function frame(now) {
    if (!box.isConnected) { timers.forEach(clearTimeout); return; }
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life -= p.fade;
      if (p.shape === "rect") p.vx *= 0.99;
      if (p.life <= 0) continue;
      ctx.globalAlpha = Math.min(1, p.life * 1.5);
      ctx.fillStyle = p.c;
      if (p.shape === "rect") { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); }
      else if (p.shape === "coin") { ctx.beginPath(); ctx.ellipse(p.x, p.y, p.w * Math.abs(Math.cos(p.r)) + 1, p.w, 0, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(p.x, p.y, p.w, 0, Math.PI * 2); ctx.fill(); }
    }
    if (now - t0 < 4000) requestAnimationFrame(frame);
  })(t0);
}

/* ----- the item shop ----- */
const KIND_TITLES = { card: "Player cards", celebration: "Celebrations", color: "Name styles" };
const KIND_NOTES = {
  card: "Your card shows in every room and on the results screen. Its rating comes from your real record.",
  celebration: "Win a match and it takes over everyone's screen.",
  color: "How your name looks to everyone."
};
function renderShop() {
  const items = (app.coins && app.coins.items) || {}, a = app.account;
  const owned = new Set((a && a.owned) || []), look = (a && a.look) || {};
  const me = { name: a ? a.username : "You", look };
  const today = new Date().toISOString().slice(0, 10);
  $("shop").replaceChildren(...Object.entries(KIND_TITLES).map(([kind, title]) => el("div", {},
    el("h4", { className: "shop-kind" }, title),
    el("p", { className: "hint" }, KIND_NOTES[kind]),
    el("ul", { className: "item-grid" + (kind === "card" ? " cards" : "") }, ...Object.entries(items)
      .filter(([id, it]) => it.kind === kind && (!it.until || it.until >= today || owned.has(id)))
      .map(([id, it]) => {
        const has = owned.has(id), worn = look[kind] === id;
        const preview = kind === "card" ? cardFor({ ...me, look: { ...look, card: id } }, "small")
          : kind === "celebration" ? el("button", { className: "cel-preview", type: "button", title: "Preview", onclick: () => celebrate(it.value, me.name) },
            el("span", {}, CELEBRATION_ICONS[it.value] || "🎉"), el("small", {}, "Preview"))
          : tint(el("span", { className: "item-swatch" }, me.name), { look: { color: id } });
        const label = !a ? `${fmt(it.price)} GC` : worn ? "Take off" : has ? "Use" : `Buy · ${fmt(it.price)} GC`;
        const days = it.until && Math.ceil((new Date(it.until + "T23:59:59Z") - Date.now()) / 864e5);
        return el("li", { className: `item r-${it.rarity}` + (worn ? " worn" : "") },
          el("span", { className: "rarity" }, RARITY[it.rarity] || ""),
          it.until && !has ? el("span", { className: "limited" }, days <= 1 ? "Last day" : `Leaves in ${days} days`) : null,
          preview,
          el("span", { className: "item-name" }, it.name),
          el("button", {
            className: "btn small" + (has ? "" : " solid"), type: "button",
            disabled: Boolean(a) && !has && a.GC < it.price,
            onclick: () => {
              setMsg("shopMsg", "");
              if (!a) { openAccount(); return setMsg("accountMsg", "Sign in to spend Gold Coins."); }
              send(has ? { type: "equip", kind, item: worn ? null : id } : { type: "buyItem", item: id });
            }
          }, label));
      })))));
}

async function buyPack(id) {
  if (isBusy) return;
  const msgId = app.screen === "store" ? "storeMsg" : "accountMsg";
  if (!app.account) { openAccount(); return setMsg(msgId, "Sign in to buy coins."); }
  if ((!app.wallet || app.wallet.kind !== "phantom") && !(await connectWallet())) return setMsg(msgId, "Connect Phantom to buy a pack.");
  busy(true);
  app.payMsg = msgId;
  try {
    const deposit = await payStake({ pack: id }, msgId);
    send({ type: "buy", pack: id, deposit });
  } catch (err) {
    busy(false);
    setMsg(msgId, /reject|cancel|denied/i.test(err.message || "") ? "Payment cancelled. Nothing was taken." : err.message || "The payment didn't go through.");
  }
}

/* ======================================================================
   Start up
   ====================================================================== */
(function boot() {
  const code = new URLSearchParams(location.search).get("room");
  selectTab(store.get("tt-mode") === "h2h" ? "h2h" : "group");
  if (code && /^[A-Za-z0-9]{5}$/.test(code)) {
    app.pendingCode = code.toUpperCase();
    codeInput.value = app.pendingCode;
    history.replaceState(null, "", location.pathname);   // a refresh shouldn't re-run the invite
  }
  if (PAGES.includes(location.hash.slice(1))) show(location.hash.slice(1));      // the landing page links straight to these
  renderWallet();
  renderJoin();
  connect();
})();
