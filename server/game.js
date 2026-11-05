/* Room and match engine. The server owns the clock, the questions and the scores,
   so clients only ever send "start", "answer", "rematch" and "leave".

   Two modes:
   - group: a host creates a room, shares the code or link with up to 7 others, and starts the match.
   - h2h:   head to head, exactly two players. Either a friend joins via a challenge link,
            or two strangers who picked the same stake are paired by matchmaking.
            The match starts on its own once both players are in; rematches need both to agree. */
const crypto = require("crypto");
const { TIERS } = require("./questions");

const DEFAULTS = {
  questionMs: 10000,   // time to answer each question
  revealMs: 2800,      // pause on the correct answer before moving on
  countdownMs: 3000,   // "get ready" before question 1
  graceMs: 30000,      // how long a dropped player keeps their seat before being removed
  groupMax: 8,
  maxRooms: 1000,
  maxQueue: 1000
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I to misread
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const randomFrom = (alphabet, length) =>
  Array.from(crypto.randomBytes(length), b => alphabet[b % alphabet.length]).join("");
const fakeTxHash = () => randomFrom(BASE58, 44);
const round2 = n => Math.round(n * 100) / 100;

/* Fisher-Yates shuffle (returns a new array) */
function shuffle(list, rand = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* One question per tier, preferring ones nobody in the room has seen recently */
function buildRound(avoid = new Set(), rand = Math.random) {
  return TIERS.map((tier, level) => {
    const fresh = tier.questions.filter(item => !avoid.has(item.id));
    const pool = fresh.length ? fresh : tier.questions;
    const pick = pool[Math.floor(rand() * pool.length)];
    const answers = shuffle(pick.a.map((text, i) => ({ text, ok: i === pick.correct })), rand);
    return {
      id: pick.id,
      q: pick.q,
      a: answers.map(x => x.text),
      correct: answers.findIndex(x => x.ok),
      tier: { name: tier.name, cls: tier.cls, level }
    };
  });
}

/* 500 for a right answer plus up to 500 more for speed */
function scoreAnswer(isRight, elapsedMs, questionMs) {
  if (!isRight) return 0;
  const speed = Math.max(0, Math.min(1, 1 - elapsedMs / questionMs));
  return 500 + Math.round(500 * speed);
}

/* Who gets what. The top score takes the pot; a shared top score splits it;
   if every player is level, everyone is refunded. */
function settle(players, stake) {
  const pot = round2(stake * players.length);
  const best = Math.max(...players.map(p => p.score));
  const winners = players.filter(p => p.score === best);
  const everyoneLevel = winners.length === players.length;
  const outcome = everyoneLevel ? "refund" : winners.length > 1 ? "split" : "win";
  const share = everyoneLevel ? stake : round2(pot / winners.length);

  const sorted = [...players].sort((a, b) => b.score - a.score);
  const standings = sorted.map(p => {
    const rank = 1 + sorted.filter(o => o.score > p.score).length;
    const payout = everyoneLevel || p.score === best ? share : 0;
    return { id: p.id, name: p.name, wallet: p.wallet, left: p.left,
             score: p.score, rank, payout, net: round2(payout - stake) };
  });
  return { pot, outcome, standings, winnerIds: everyoneLevel ? [] : winners.map(p => p.id) };
}

class Room {
  constructor(manager, { code, stake, currency, mode, matched = false }) {
    this.manager = manager;
    this.opts = manager.opts;
    this.code = code;
    this.stake = stake;
    this.currency = currency;
    this.mode = mode;                 // "group" | "h2h"
    this.matched = matched;           // h2h paired by matchmaking (private: no code to share)
    this.maxPlayers = mode === "h2h" ? 2 : this.opts.groupMax;
    this.players = [];
    this.hostId = null;
    this.phase = "lobby";             // lobby | countdown | question | reveal | results
    this.round = null;
    this.qIndex = -1;
    this.qStartedAt = 0;
    this.timers = new Set();
    this.seen = new Set();            // question ids already used in this room
    this.rematch = new Set();         // h2h: player ids who asked for a rematch
    this.lastResults = null;
    this.lastReveal = null;
    this.matchNo = 0;
  }

  /* ----- timers ----- */
  later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers.clear(); }

  /* ----- players ----- */
  get active() { return this.players.filter(p => !p.left); }
  player(id) { return this.players.find(p => p.id === id); }
  inMatch() { return ["countdown", "question", "reveal"].includes(this.phase); }

  addPlayer({ key = null, name, wallet = null, send = null, recent = [] }) {
    const p = {
      id: randomFrom(BASE58, 10), key, name, wallet, send,
      connected: Boolean(send), left: false, score: 0, answer: null,
      recent: new Set(recent), dropTimer: null
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    return p;
  }

  removePlayer(p) {
    if (p.dropTimer) clearTimeout(p.dropTimer);
    if (this.inMatch()) {
      p.left = true; p.connected = false; p.send = null;   // keeps their stake in this pot
    } else {
      this.players = this.players.filter(x => x !== p);
    }
    this.rematch.delete(p.id);
    if (p.key) this.manager.byKey.delete(p.key);
    if (this.hostId === p.id) this.pickNewHost();
    if (this.active.length === 0) return this.manager.close(this);
    this.syncState();
    this.maybeEndQuestionEarly();
  }

  pickNewHost() {
    const next = this.active.find(p => p.connected) || this.active[0];
    this.hostId = next ? next.id : null;
  }

  disconnect(p) {
    p.connected = false;
    p.send = null;
    if (this.hostId === p.id && this.active.some(h => h.connected)) this.pickNewHost();
    if (!this.active.some(h => h.connected)) {
      // Nobody left watching: close the room after the grace period unless someone returns
      p.dropTimer = setTimeout(() => {
        if (!this.active.some(h => h.connected)) this.manager.close(this);
      }, this.opts.graceMs);
    } else {
      p.dropTimer = setTimeout(() => { if (!p.connected) this.removePlayer(p); }, this.opts.graceMs);
    }
    this.syncState();
    this.maybeEndQuestionEarly();
  }

  reconnect(p, send) {
    if (p.dropTimer) clearTimeout(p.dropTimer);
    p.dropTimer = null;
    p.connected = true;
    p.send = send;
    if (!this.player(this.hostId)?.connected) this.pickNewHost();
    this.syncState();
    // Bring them back to wherever the match is
    if (this.phase === "question") this.sendQuestion(p);
    else if (this.phase === "reveal" && this.lastReveal) p.send(this.lastReveal);
    else if (this.phase === "results" && this.lastResults) p.send(this.lastResults);
  }

  /* ----- messaging ----- */
  broadcast(msg) { this.players.forEach(p => p.send && p.send(msg)); }

  state(forPlayer) {
    return {
      type: "room",
      code: this.code,
      mode: this.mode,
      matched: this.matched,
      phase: this.phase,
      you: forPlayer.id,
      hostId: this.hostId,
      stake: this.stake,
      currency: this.currency,
      pot: round2(this.stake * this.players.length),   // includes anyone who quit mid-match
      maxPlayers: this.maxPlayers,
      matchNo: this.matchNo,
      rematch: [...this.rematch],
      players: this.active.map(p => ({
        id: p.id, name: p.name, wallet: p.wallet,
        connected: p.connected, score: p.score, isHost: p.id === this.hostId
      }))
    };
  }
  syncState() { this.players.forEach(p => p.send && p.send(this.state(p))); }

  /* ----- match flow ----- */

  /* Group: only the host starts. Head to head never needs a start button. */
  start(by) {
    if (this.mode === "h2h") return "Head-to-head matches start on their own once both players are in.";
    if (by.id !== this.hostId) return "Only the host can start the match.";
    if (this.inMatch()) return "The match has already started.";
    if (this.active.length < 2) return "You need at least one other player to start.";
    if (this.active.some(p => !p.connected)) return "Wait for everyone to reconnect first.";
    this.begin();
    return null;
  }

  /* "Play again" from the results screen */
  requestRematch(by) {
    if (this.mode === "group") return this.start(by);
    if (this.phase !== "results") return "The match isn't over yet.";
    if (this.active.length < 2) return "Your opponent has left.";
    this.rematch.add(by.id);
    if (this.active.every(p => this.rematch.has(p.id))) this.begin();
    else this.syncState();
    return null;
  }

  /* A head-to-head starts as soon as the second player arrives */
  maybeAutoStart() {
    if (this.mode !== "h2h" || this.inMatch() || this.active.length !== 2) return false;
    this.begin();
    return true;
  }

  begin() {
    this.players = this.active;                     // drop anyone who left the last match
    this.players.forEach(p => { p.score = 0; p.answer = null; });
    const avoid = new Set(this.seen);
    this.players.forEach(p => p.recent.forEach(id => avoid.add(id)));
    this.round = buildRound(avoid);
    this.round.forEach(item => this.seen.add(item.id));
    this.qIndex = -1;
    this.rematch.clear();
    this.lastResults = null;
    this.phase = "countdown";
    this.syncState();
    this.broadcast({ type: "countdown", ms: this.opts.countdownMs, total: this.round.length });
    this.later(this.opts.countdownMs, () => this.nextQuestion());
  }

  nextQuestion() {
    this.qIndex++;
    if (this.qIndex >= this.round.length) return this.finish();
    this.phase = "question";
    this.qStartedAt = Date.now();
    this.lastReveal = null;
    this.active.forEach(p => { p.answer = null; });
    this.active.forEach(p => this.sendQuestion(p));
    this.later(this.opts.questionMs, () => this.reveal());
  }

  sendQuestion(p) {
    if (!p.send) return;
    const item = this.round[this.qIndex];
    p.send({
      type: "question",
      index: this.qIndex,
      total: this.round.length,
      id: item.id,
      q: item.q,
      a: item.a,
      tier: item.tier,
      durationMs: this.opts.questionMs,
      timeLeftMs: Math.max(0, this.opts.questionMs - (Date.now() - this.qStartedAt)),
      yourChoice: p.answer ? p.answer.choice : null,
      answered: this.active.filter(o => o.answer).map(o => o.id)
    });
  }

  answer(p, index, choice) {
    if (this.phase !== "question" || index !== this.qIndex || p.left || p.answer) return;
    if (!Number.isInteger(choice) || choice < 0 || choice >= this.round[this.qIndex].a.length) return;
    p.answer = { choice, ms: Date.now() - this.qStartedAt };
    this.broadcast({ type: "answered", index, id: p.id });
    this.maybeEndQuestionEarly();
  }

  /* Once every connected player has locked in, there is no reason to wait out the clock */
  maybeEndQuestionEarly() {
    if (this.phase !== "question") return;
    const waiting = this.active.filter(p => p.connected && !p.answer);
    if (waiting.length === 0) {
      this.phase = "reveal";                         // stops double reveals
      this.clearTimers();
      this.later(500, () => this.reveal(true));
    }
  }

  reveal(force = false) {
    if (this.phase !== "question" && !force) return;
    this.clearTimers();
    this.phase = "reveal";
    const item = this.round[this.qIndex];
    const picks = {};
    this.active.forEach(p => {
      const choice = p.answer ? p.answer.choice : null;
      const points = p.answer ? scoreAnswer(choice === item.correct, p.answer.ms, this.opts.questionMs) : 0;
      p.score += points;
      picks[p.id] = { choice, points };
    });
    this.lastReveal = {
      type: "reveal",
      index: this.qIndex,
      correct: item.correct,
      picks,
      scores: Object.fromEntries(this.active.map(p => [p.id, p.score])),
      last: this.qIndex === this.round.length - 1,
      nextInMs: this.opts.revealMs
    };
    this.broadcast(this.lastReveal);
    this.later(this.opts.revealMs, () => this.nextQuestion());
  }

  finish() {
    this.phase = "results";
    this.matchNo++;
    const result = settle(this.players, this.stake);
    this.lastResults = {
      type: "results",
      mode: this.mode,
      stake: this.stake,
      currency: this.currency,
      tx: fakeTxHash(),
      ...result
    };
    this.players = this.active;
    this.syncState();
    this.broadcast(this.lastResults);
  }
}

class RoomManager {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.rooms = new Map();
    this.byKey = new Map();           // client key -> { room, player }
    this.queue = new Map();           // client key -> { who, stake, currency, since } waiting for an opponent
  }

  newCode() {
    for (let i = 0; i < 50; i++) {
      const code = randomFrom(CODE_ALPHABET, 5);
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("Could not allocate a room code");
  }

  find(key) {
    const entry = key && this.byKey.get(key);
    if (!entry || !this.rooms.has(entry.room.code) || entry.player.left) return null;
    return entry;
  }

  /* A browser tab can be in one room, or one queue, at a time */
  leaveCurrent(key) {
    this.cancelSearch(key);
    const entry = this.find(key);
    if (entry) entry.room.removePlayer(entry.player);
  }

  open({ stake, currency, mode, matched = false }) {
    if (this.rooms.size >= this.opts.maxRooms) return null;
    const room = new Room(this, { code: this.newCode(), stake, currency, mode, matched });
    this.rooms.set(room.code, room);
    return room;
  }

  seat(room, who) {
    const p = room.addPlayer(who);
    if (who.key) this.byKey.set(who.key, { room, player: p });
    return p;
  }

  /* Group room, or a head-to-head challenge for a friend */
  create(who, { stake, currency, mode }) {
    this.leaveCurrent(who.key);
    const room = this.open({ stake, currency, mode: mode === "h2h" ? "h2h" : "group" });
    if (!room) return { error: "The server is full right now. Try again in a minute." };
    const p = this.seat(room, who);
    room.syncState();
    return { room, player: p };
  }

  /* Head to head with a stranger: pair with whoever is waiting at the same stake */
  findMatch(who, { stake, currency }) {
    this.leaveCurrent(who.key);
    const opponent = [...this.queue.values()].find(e => e.stake === stake && e.currency === currency);
    if (!opponent) {
      if (this.queue.size >= this.opts.maxQueue) return { error: "Matchmaking is busy right now. Try again in a minute." };
      this.queue.set(who.key, { who, stake, currency, since: Date.now() });
      who.send({ type: "searching", stake, currency });
      return { waiting: true };
    }
    this.queue.delete(opponent.who.key);
    const room = this.open({ stake, currency, mode: "h2h", matched: true });
    if (!room) return { error: "The server is full right now. Try again in a minute." };
    this.seat(room, opponent.who);
    this.seat(room, who);
    room.maybeAutoStart();                          // goes straight to the countdown
    return { room };
  }

  cancelSearch(key) { return this.queue.delete(key); }

  lookup(code) {
    const room = this.rooms.get(String(code || "").toUpperCase());
    if (!room || room.matched) return { error: "No room with that code. Check it and try again." };
    const host = room.player(room.hostId);
    return {
      code: room.code, mode: room.mode, stake: room.stake, currency: room.currency, phase: room.phase,
      players: room.active.length, maxPlayers: room.maxPlayers, host: host ? host.name : null
    };
  }

  join(who, code) {
    code = String(code || "").toUpperCase();
    const room = this.rooms.get(code);
    if (!room || room.matched) return { error: "No room with that code. Check it and try again." };
    const already = this.find(who.key);
    if (already && already.room === room) { room.reconnect(already.player, who.send); return already; }
    if (room.inMatch()) return { error: "That match is already under way. Try again when it finishes." };
    if (room.active.length >= room.maxPlayers) {
      return { error: room.mode === "h2h" ? "That head-to-head already has two players." : "That room is full." };
    }
    this.leaveCurrent(who.key);
    const p = this.seat(room, who);
    if (!room.maybeAutoStart()) room.syncState();
    return { room, player: p };
  }

  close(room) {
    room.clearTimers();
    room.players.forEach(p => {
      if (p.dropTimer) clearTimeout(p.dropTimer);
      if (p.key && this.byKey.get(p.key)?.room === room) this.byKey.delete(p.key);
      if (p.send) p.send({ type: "closed" });
    });
    this.rooms.delete(room.code);
  }

  shutdown() { [...this.rooms.values()].forEach(r => this.close(r)); this.queue.clear(); }
}

module.exports = { RoomManager, Room, buildRound, scoreAnswer, settle, shuffle, DEFAULTS };
