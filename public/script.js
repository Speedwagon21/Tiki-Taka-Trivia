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

document.querySelectorAll("[data-open-terms]").forEach(a => a.addEventListener("click", e => {
  e.preventDefault();
  if (app.screen === "arena") return;
  if (app.screen !== "terms") app.beforeTerms = app.screen;
  show("terms");
}));
$("termsBack").onclick = () => show(screenForRoom() || app.beforeTerms);

/* Which screen the room's phase belongs on */
function screenForRoom() {
  if (!app.room) return null;
  if (["countdown", "question", "reveal"].includes(app.room.phase)) return "arena";
  if (app.room.phase === "results" && app.results) return "results";
  return app.room.practice ? null : "room";
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
  lose() { [392, 349, 294].forEach((f, i) => this.tone(f, 0.28, { at: i * 0.16, type: "sine", gain: 0.06 })); }
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
  ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", key: clientKey })); };
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
      net.ws.send(JSON.stringify({ type: "hello", key: clientKey }));
      return;

    case "hello":
      net.ready = true; net.retry = 0;
      setNet("online", "Online");
      if (!m.resumed && app.room) {     // our room is gone (server restarted or it closed)
        resetRoom();
        show("home");
        setMsg("homeMsg", "You lost your place in the room. Create or join another one.");
      }
      net.queue.splice(0).forEach(send);
      if (app.pendingCode) { lookupCode(app.pendingCode); app.pendingCode = null; }
      return;

    case "room": return onRoom(m);
    case "countdown": return onCountdown(m);
    case "question": return onQuestion(m);
    case "answered": return onAnswered(m);
    case "reveal": return onReveal(m);
    case "results": return onResults(m);

    case "lookup":
      app.lookup = m.room;
      renderJoin();
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
      if (m.about === "lookup") { app.lookup = null; renderJoin(); }
      const where = { home: "homeMsg", room: "roomMsg" }[app.screen] || "homeMsg";
      if (app.screen === "home" || app.screen === "room") setMsg(where, m.message);
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
   Home screen: name, tabs, create / join / practice
   ====================================================================== */
const nameInput = $("nameInput");
nameInput.value = store.get("tt-name") || "";
nameInput.addEventListener("input", () => store.set("tt-name", nameInput.value.trim()));
const playerName = () => nameInput.value.trim() || "Player " + clientKey.slice(0, 3).toUpperCase();

/* Tabs with arrow-key support */
const tabs = ["create", "join", "practice"];
function selectTab(name, focus = false) {
  tabs.forEach(t => {
    const on = t === name;
    const tab = $("tab-" + t);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $("pane-" + t).hidden = !on;
    if (on && focus) tab.focus();
  });
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
});

let isBusy = false;
function busy(on) {
  isBusy = on;
  ["createBtn", "joinBtn", "practiceBtn", "startBtn", "againBtn"].forEach(id => { $(id).classList.toggle("loading", on); });
  if (!on) renderJoin();
}

const recent = () => { try { return JSON.parse(store.get("tt-recent") || "[]"); } catch { return []; } };
function rememberQuestion(id) {
  const list = recent().filter(x => x !== id);
  list.push(id);
  store.set("tt-recent", JSON.stringify(list.slice(-30)));
}
const identity = () => (app.leaving = false, { name: playerName(), wallet: app.wallet ? app.wallet.address : null, recent: recent() });

$("createBtn").onclick = async () => {
  if (isBusy) return;
  const stake = parseFloat($("stake").value);
  if (!(stake >= 0.01 && stake <= 1000)) return setMsg("homeMsg", "Enter a stake between 0.01 and 1000.");
  if (!$("agreeCreate").checked) return setMsg("homeMsg", "Confirm you are 18+ and accept the terms to continue.");
  if (!app.wallet && !(await connectWallet())) return setMsg("homeMsg", "Connect a wallet to create a staked room.");
  busy(true);
  setMsg("homeMsg", "Signing and locking your stake in escrow…", true);
  await sleep(700);   // mock signing delay, so it feels like a transaction
  send({ type: "create", stake, currency: app.currency, ...identity() });
};

$("practiceBtn").onclick = () => {
  if (isBusy) return;
  busy(true);
  setMsg("homeMsg", "");
  send({ type: "practice", ...identity() });
};

/* Join: look the code up first so the player can see the stake before locking it */
const codeInput = $("codeInput");
const CODE_CHARS = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;
codeInput.addEventListener("input", () => {
  const clean = codeInput.value.toUpperCase().replace(CODE_CHARS, "").slice(0, 5);
  codeInput.value = clean;
  app.lookup = null;
  setMsg("homeMsg", "");
  if (clean.length === 5) lookupCode(clean);
  renderJoin();
});
function lookupCode(code) {
  codeInput.value = code;
  send({ type: "lookup", code });
}
$("agreeJoin").onchange = renderJoin;

function renderJoin() {
  const r = app.lookup, btn = $("joinBtn"), preview = $("joinPreview");
  $("joinConsent").hidden = !r;
  preview.hidden = !r;
  preview.replaceChildren();
  if (!r) {
    btn.textContent = "Find room";
    btn.disabled = codeInput.value.length !== 5 || isBusy;
    return;
  }
  const full = r.players >= r.maxPlayers, playing = !["lobby", "results"].includes(r.phase);
  preview.append(
    el("div", { className: "preview-code" }, r.code),
    el("dl", {},
      el("dt", {}, "Host"), el("dd", {}, r.host || "—"),
      el("dt", {}, "Stake"), el("dd", {}, `${fmt(r.stake)} ${r.currency} each`),
      el("dt", {}, "Players"), el("dd", {}, `${r.players} of ${r.maxPlayers}`)),
    ...(playing ? [el("p", { className: "warn" }, "A match is in progress. You can join once it finishes.")] : [])
  );
  btn.textContent = `Lock ${fmt(r.stake)} ${r.currency} and join`;
  btn.disabled = isBusy || full || playing;
  if (full) btn.textContent = "Room is full";
}

$("joinBtn").onclick = async () => {
  if (isBusy) return;
  if (!app.lookup) { if (codeInput.value.length === 5) lookupCode(codeInput.value); return; }
  if (!$("agreeJoin").checked) return setMsg("homeMsg", "Confirm you are 18+ and accept the terms to continue.");
  if (!app.wallet && !(await connectWallet())) return setMsg("homeMsg", "Connect a wallet to join a staked room.");
  busy(true);
  setMsg("homeMsg", "Signing and locking your stake in escrow…", true);
  await sleep(700);
  send({ type: "join", code: app.lookup.code, ...identity() });
};

/* ======================================================================
   Room (waiting) screen
   ====================================================================== */
function onRoom(r) {
  if (app.leaving) return;          // a late update for a room we already walked out of
  const prev = app.room;
  app.room = r;
  busy(false);
  setMsg("homeMsg", "");

  // Sounds and announcements for people arriving and leaving
  if (prev && prev.code === r.code && !r.practice) {
    const before = new Set(prev.players.map(p => p.id));
    const now = new Set(r.players.map(p => p.id));
    r.players.filter(p => !before.has(p.id)).forEach(p => { sound.join(); announce(`${p.name} joined`); });
    prev.players.filter(p => !now.has(p.id)).forEach(p => announce(`${p.name} left`));
  }

  renderRoom();
  renderChips();
  // New arrivals during the results screen wait in the room for the next match
  if (!r.practice && (r.phase === "lobby" || (r.phase === "results" && !app.results))) {
    if (app.screen !== "terms") show("room");
  } else if (r.phase === "results") {
    renderResultActions();
  }
}

function inviteLink() { return `${location.origin}${location.pathname}?room=${app.room.code}`; }
const me = () => app.room && app.room.players.find(p => p.id === app.room.you);
const isHost = () => app.room && app.room.hostId === app.room.you;

function renderRoom() {
  const r = app.room;
  if (!r || r.practice) return;
  $("roomTitle").textContent = isHost() ? "Your room" : "You're in";
  if ($("roomCode").dataset.code !== r.code) {     // rebuild (and animate) only when the code changes
    $("roomCode").dataset.code = r.code;
    $("roomCode").replaceChildren(...[...r.code].map(c => el("span", {}, c)));
  }
  $("roomCode").setAttribute("aria-label", "Room code " + [...r.code].join(" "));
  $("roomStake").replaceChildren(
    el("div", {}, el("small", {}, "Stake each"), el("strong", {}, `${fmt(r.stake)} ${r.currency}`)),
    el("div", {}, el("small", {}, "Pot so far"), el("strong", { className: "accent" }, `${fmt(r.pot)} ${r.currency}`))
  );
  $("playerCount").textContent = `${r.players.length}/${r.maxPlayers}`;
  $("playerList").replaceChildren(...r.players.map(p => el("li", { className: p.connected ? "" : "away" },
    el("span", { className: "avatar", ariaHidden: "true" }, (p.name[0] || "?").toUpperCase()),
    el("span", { className: "pname" }, p.name, p.id === r.you ? el("em", {}, " (you)") : null),
    p.isHost ? el("span", { className: "tag host" }, "Host") : null,
    !p.connected ? el("span", { className: "tag" }, "Reconnecting…") : null,
    el("span", { className: "addr" }, short(p.wallet))
  )));

  const enough = r.players.length >= 2;
  const host = r.players.find(p => p.isHost);
  $("startBtn").hidden = !isHost();
  $("startBtn").disabled = !enough;
  $("startBtn").textContent = r.matchNo ? "Start next match" : "Start match";
  $("roomHint").textContent = isHost()
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
  text: `Join my Tiki-Taka Trivia room. Code: ${app.room.code}`,
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
      el("span", { className: "cname" }, p.id === r.you ? "You" : p.name),
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
  $("pot").textContent = r.practice ? "Free" : fmt(r.pot);
  $("potCur").textContent = r.practice ? "practice" : r.currency;
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
  const mine = m.standings.find(s => s.id === youId) || { score: 0, rank: 0 };
  const won = m.winnerIds.includes(youId);
  const cur = m.currency;
  const title = $("resTitle");
  title.className = "final";

  let text;
  if (m.outcome === "refund") {
    title.textContent = "Draw";
    title.classList.add("draw");
    text = m.practice ? "Dead level with the bot." : `Everyone finished level, so every stake was refunded (${fmt(m.stake)} ${cur} back to you).`;
  } else if (won && m.outcome === "win") {
    title.textContent = "You win";
    text = m.practice ? "You beat the bot. Ready for a real room?" : `The escrow released the ${fmt(m.pot)} ${cur} pot to your wallet.`;
  } else if (won) {
    title.textContent = "Shared win";
    title.classList.add("draw");
    text = `You tied for the top score and split the pot: ${fmt(m.standings.find(s => s.id === youId).payout)} ${cur} to you.`;
  } else {
    title.textContent = "You lose";
    title.classList.add("lose");
    const top = m.standings.filter(s => m.winnerIds.includes(s.id)).map(s => s.name).join(" and ");
    text = m.practice ? "The bot edged it this time. Run it back?" : `${top} took the ${fmt(m.pot)} ${cur} pot.`;
  }
  $("resSub").textContent = m.standings.length > 1 ? `You finished ${ordinal(mine.rank)} of ${m.standings.length} with ${mine.score} points` : "";
  $("resText").textContent = text;

  $("standings").replaceChildren(...m.standings.map(s => el("li", { className: s.id === youId ? "you" : "" },
    el("span", { className: "rank" }, String(s.rank)),
    el("span", { className: "sname" }, s.id === youId ? "You" : s.name, s.isBot ? el("em", {}, " bot") : null, s.left ? el("em", {}, " left") : null),
    el("span", { className: "spts" }, `${s.score} pts`),
    m.practice ? null : el("span", { className: "net " + (s.net > 0 ? "up" : s.net < 0 ? "down" : "") },
      (s.net > 0 ? "+" : "") + fmt(s.net) + " " + cur)
  )));

  // Settlement record. Built with DOM nodes so player names can't inject markup.
  const ledger = $("ledger");
  ledger.replaceChildren();
  if (!m.practice) {
    const line = (...parts) => ledger.append(el("div", {}, ...parts));
    const em = t => el("em", {}, t);
    line("escrow.tx  ", m.tx);
    m.standings.filter(s => s.payout > 0).forEach(s =>
      line(m.outcome === "refund" ? "refund" : "release", "(to=", em(short(s.wallet) || s.name), ", amount=", em(`${fmt(s.payout)} ${cur}`), ")"));
    line("status: ", em("confirmed"));
    ledger.append(el("div", { className: "demo-note" }, "Simulated settlement on devnet. No real funds moved."));
  }

  renderResultActions();
  show("results");
  if (won && m.outcome === "win") { sound.win(); confetti(); } else if (!won && m.outcome !== "refund") sound.lose();
  else sound.right();
}

function renderResultActions() {
  const r = app.room;
  if (!r || app.screen === "arena" && r.phase !== "results") return;
  const again = $("againBtn"), hint = $("resHint");
  if (r.practice) {
    again.hidden = false;
    again.textContent = "Play again";
    $("resLeaveBtn").textContent = "Back to menu";
    hint.textContent = "";
    return;
  }
  $("resLeaveBtn").textContent = "Leave room";
  const host = r.players.find(p => p.isHost);
  again.hidden = !isHost();
  again.textContent = "Rematch";
  again.disabled = r.players.length < 2;
  hint.textContent = isHost()
    ? (r.players.length < 2 ? "Everyone else left. Share the code to get more players in." : `Same room, same ${fmt(r.stake)} ${r.currency} stake. New players can still join with code ${r.code}.`)
    : `Waiting for ${host ? host.name : "the host"} to start a rematch. Room code ${r.code}.`;
}

$("againBtn").onclick = () => {
  if (isBusy || !app.room) return;
  if (app.room.practice) { busy(true); send({ type: "practice", ...identity() }); return; }
  send({ type: "start" });
};
$("resLeaveBtn").onclick = leaveRoom;

function confetti() {
  if (prefersReducedMotion) return;
  const box = $("confetti");
  const colors = ["#2dff8a", "#ffd166", "#ff5d6c", "#7cc6ff", "#e8f3ec"];
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
  if (w && w.kind === "phantom") fetchBalance(w.address).then(b => {
    if (app.wallet && app.wallet.address === w.address) { app.wallet.balance = b; renderWallet(); }
  });
}

function renderWallet() {
  const btn = $("walletBtn"), w = app.wallet;
  btn.classList.toggle("connected", Boolean(w));
  btn.replaceChildren();
  if (!w) { btn.textContent = "Connect wallet"; return; }
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
   Start up
   ====================================================================== */
(function boot() {
  const code = new URLSearchParams(location.search).get("room");
  if (code && /^[A-Za-z0-9]{5}$/.test(code)) {
    selectTab("join");
    app.pendingCode = code.toUpperCase();
    codeInput.value = app.pendingCode;
    history.replaceState(null, "", location.pathname);   // a refresh shouldn't re-run the invite
  }
  renderWallet();
  renderJoin();
  connect();
})();
