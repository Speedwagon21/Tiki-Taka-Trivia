/* End-to-end over real WebSockets: create a room, join with the code, play a match. */
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createServer } = require("../server");

const WALLET_A = "7xQ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".slice(0, 44);
const WALLET_B = "9bQ7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".slice(0, 44);
const FAST = { questionMs: 400, revealMs: 60, countdownMs: 30, graceMs: 200 };

function startServer(opts = FAST) {
  const { server, stop } = createServer(opts);
  return new Promise(resolve => server.listen(0, () =>
    resolve({ server: { close: stop }, port: server.address().port })));
}

/* A tiny client that records every message and can wait for a given type */
function client(port, key) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  const used = new Set();
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (!used.has(m) && waiters[i].match(m)) { used.add(m); waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  const c = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    /* Resolves with the first matching message not yet handed out, including ones that already arrived */
    next(type, pred = () => true, ms = 3000) {
      const match = m => m.type === type && !used.has(m) && pred(m);
      const waiting = inbox.find(match);
      if (waiting) { used.add(waiting); return Promise.resolve(waiting); }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), ms);
        waiters.push({ match, resolve: m => { clearTimeout(t); resolve(m); } });
      });
    },
    close: () => ws.close()
  };
  return new Promise(resolve => ws.on("open", async () => {
    c.send({ type: "hello", key });
    await c.next("hello");
    resolve(c);
  }));
}

test("static files and health check are served", async () => {
  const { server, port } = await startServer();
  const home = await fetch(`http://localhost:${port}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Tiki-Taka/);
  assert.equal((await fetch(`http://localhost:${port}/healthz`)).status, 200);
  assert.equal((await fetch(`http://localhost:${port}/..%2fpackage.json`)).status, 403);
  assert.equal((await fetch(`http://localhost:${port}/nope.js`)).status, 404);
  server.close();
});

test("create a room, join it by code, play three questions and settle the pot", async () => {
  const { server, port } = await startServer();
  const host = await client(port, "host-key-123");
  const guest = await client(port, "guest-key-456");

  host.send({ type: "create", name: "Ana", wallet: WALLET_A, stake: 1.5, currency: "USDC" });
  const created = await host.next("room");
  assert.equal(created.code.length, 5);
  assert.equal(created.phase, "lobby");
  assert.equal(created.hostId, created.you);

  // The guest can peek at the room before locking a stake
  guest.send({ type: "lookup", code: created.code.toLowerCase() });
  const peek = await guest.next("lookup");
  assert.deepEqual([peek.room.stake, peek.room.currency, peek.room.players, peek.room.host], [1.5, "USDC", 1, "Ana"]);

  // Starting alone is refused
  host.send({ type: "start" });
  assert.match((await host.next("error")).message, /at least one other player/);

  guest.send({ type: "join", code: created.code, name: "Ben <b>", wallet: WALLET_B });
  const joined = await guest.next("room");
  assert.equal(joined.players.length, 2);
  assert.equal(joined.pot, 3);
  assert.equal(joined.players[1].name, "Ben b", "names are cleaned of markup");
  await host.next("room", m => m.players.length === 2);

  // Only the host can start
  guest.send({ type: "start" });
  assert.match((await guest.next("error")).message, /Only the host/);

  host.send({ type: "start" });
  await guest.next("countdown");

  // Host always answers first with the correct answer, guest always picks a wrong one
  for (let i = 0; i < 3; i++) {
    const q = await host.next("question", m => m.index === i);
    const gq = await guest.next("question", m => m.index === i);
    assert.equal(q.correct, undefined, "the correct answer is never sent with the question");
    assert.equal(gq.q, q.q);
    // We don't know the answer, so answer, then check the reveal
    host.send({ type: "answer", index: i, choice: 0 });
    guest.send({ type: "answer", index: i, choice: 1 });
    const reveal = await host.next("reveal", m => m.index === i);
    assert.equal(Object.keys(reveal.picks).length, 2);
  }
  const results = await host.next("results");
  const guestResults = await guest.next("results");
  assert.equal(results.pot, 3);
  assert.equal(guestResults.tx, results.tx);
  const total = results.standings.reduce((sum, s) => sum + s.payout, 0);
  assert.equal(Math.round(total * 100) / 100, 3, "the whole pot is paid out");

  // Rematch from the results screen works and keeps the same room
  host.send({ type: "start" });
  await guest.next("countdown");

  host.close(); guest.close(); server.close();
});

test("a question ends early once everyone has answered", async () => {
  const { server, port } = await startServer({ ...FAST, questionMs: 5000 });
  const host = await client(port, "early-host-1");
  const guest = await client(port, "early-guest-1");
  host.send({ type: "create", name: "A", wallet: WALLET_A, stake: 1, currency: "SOL" });
  const { code } = await host.next("room");
  guest.send({ type: "join", code, name: "B", wallet: WALLET_B });
  await host.next("room", m => m.players.length === 2);
  host.send({ type: "start" });
  await host.next("question");
  const started = Date.now();
  host.send({ type: "answer", index: 0, choice: 2 });
  guest.send({ type: "answer", index: 0, choice: 2 });
  await host.next("reveal");
  assert.ok(Date.now() - started < 2000, "did not wait out the 5s clock");
  host.close(); guest.close(); server.close();
});

test("joining needs a wallet and a real code, and rooms cap at 8", async () => {
  const { server, port } = await startServer();
  const host = await client(port, "cap-host-01");
  host.send({ type: "create", name: "Host", wallet: WALLET_A, stake: 1, currency: "SOL" });
  const { code } = await host.next("room");

  const noWallet = await client(port, "no-wallet-1");
  noWallet.send({ type: "join", code, name: "X" });
  assert.match((await noWallet.next("error")).message, /wallet/);

  noWallet.send({ type: "join", code: "ZZZZZ", name: "X", wallet: WALLET_B });
  assert.match((await noWallet.next("error")).message, /No room/);

  const guests = [];
  for (let i = 0; i < 7; i++) {
    const g = await client(port, `cap-guest-${i}`);
    g.send({ type: "join", code, name: `G${i}`, wallet: WALLET_B });
    await g.next("room");
    guests.push(g);
  }
  const late = await client(port, "cap-late-01");
  late.send({ type: "join", code, name: "Late", wallet: WALLET_B });
  assert.match((await late.next("error")).message, /full/);

  [host, noWallet, late, ...guests].forEach(c => c.close());
  server.close();
});

test("a dropped player resumes their seat, and the host role moves if the host leaves", async () => {
  const { server, port } = await startServer({ ...FAST, graceMs: 2000 });
  const host = await client(port, "resume-host");
  const guest = await client(port, "resume-guest");
  host.send({ type: "create", name: "Host", wallet: WALLET_A, stake: 1, currency: "SOL" });
  const { code } = await host.next("room");
  guest.send({ type: "join", code, name: "Guest", wallet: WALLET_B });
  const g1 = await guest.next("room");

  guest.close();
  await host.next("room", m => m.players.some(p => !p.connected));
  const back = await client(port, "resume-guest");      // same key, as after a page refresh
  assert.ok(back.inbox.find(m => m.type === "hello").resumed);
  const g2 = back.inbox.find(m => m.type === "room");
  assert.equal(g2.you, g1.you);

  host.send({ type: "leave" });
  const after = await back.next("room", m => m.players.length === 1);
  assert.equal(after.hostId, g1.you);

  back.close(); host.close(); server.close();
});

test("head to head challenge: a friend joins by code and the match starts by itself", async () => {
  const { server, port } = await startServer();
  const host = await client(port, "h2h-host-01");
  const friend = await client(port, "h2h-friend-1");
  const third = await client(port, "h2h-third-01");

  host.send({ type: "create", mode: "h2h", name: "Ana", wallet: WALLET_A, stake: 2, currency: "SOL" });
  const room = await host.next("room");
  assert.equal(room.mode, "h2h");
  assert.equal(room.maxPlayers, 2);

  host.send({ type: "start" });
  assert.match((await host.next("error")).message, /start on their own/);

  friend.send({ type: "lookup", code: room.code });
  const peek = await friend.next("lookup");
  assert.equal(peek.room.mode, "h2h");

  friend.send({ type: "join", code: room.code, name: "Ben", wallet: WALLET_B });
  await host.next("countdown");
  await friend.next("countdown");
  const first = friend.inbox.find(m => m.type === "room");
  assert.equal(first.phase, "countdown", "the friend goes straight into the match, no waiting room");

  third.send({ type: "join", code: room.code, name: "Cy", wallet: WALLET_B });
  assert.match((await third.next("error")).message, /already under way|two players/);

  [host, friend, third].forEach(c => c.close());
  server.close();
});

test("head to head rematch needs both players to agree", async () => {
  const { server, port } = await startServer();
  const a = await client(port, "rematch-a-01");
  const b = await client(port, "rematch-b-01");
  a.send({ type: "create", mode: "h2h", name: "A", wallet: WALLET_A, stake: 1, currency: "SOL" });
  const { code } = await a.next("room");
  b.send({ type: "join", code, name: "B", wallet: WALLET_B });
  await a.next("results", () => true, 5000);          // nobody answers; clock runs out
  await b.next("results", () => true, 5000);

  a.send({ type: "rematch" });
  const pending = await b.next("room", m => m.rematch.length === 1);
  assert.equal(pending.phase, "results", "one vote is not enough");
  b.send({ type: "rematch" });
  await a.next("countdown", m => true);
  await b.next("countdown");

  a.close(); b.close(); server.close();
});

test("matchmaking pairs players at the same stake and currency only", async () => {
  const { server, port } = await startServer();
  const p1 = await client(port, "mm-player-1");
  const p2 = await client(port, "mm-player-2");
  const p3 = await client(port, "mm-player-3");

  p1.send({ type: "findMatch", name: "One", wallet: WALLET_A, stake: 1, currency: "SOL" });
  assert.equal((await p1.next("searching")).stake, 1);
  p2.send({ type: "findMatch", name: "Two", wallet: WALLET_B, stake: 1, currency: "USDC" });
  await p2.next("searching");                          // different currency: no match yet

  p3.send({ type: "findMatch", name: "Three", wallet: WALLET_B, stake: 1, currency: "SOL" });
  const r1 = await p1.next("room");
  const r3 = await p3.next("room");
  assert.equal(r1.code, r3.code);
  assert.equal(r1.mode, "h2h");
  assert.equal(r1.matched, true);
  assert.equal(r1.phase, "countdown");
  await p1.next("countdown");

  // Matched rooms are private: no joining by code
  p2.send({ type: "lookup", code: r1.code });
  assert.match((await p2.next("error")).message, /No room/);

  // Cancelling leaves the queue, so a later player at that stake waits instead of pairing
  p2.send({ type: "cancelSearch" });
  await p2.next("searchCancelled");
  const p4 = await client(port, "mm-player-4");
  p4.send({ type: "findMatch", name: "Four", wallet: WALLET_A, stake: 1, currency: "USDC" });
  await p4.next("searching");

  // A dropped connection also leaves the queue
  p4.close();
  await new Promise(r => setTimeout(r, 50));
  p2.send({ type: "findMatch", name: "Two", wallet: WALLET_B, stake: 1, currency: "USDC" });
  await p2.next("searching");

  [p1, p2, p3].forEach(c => c.close());
  server.close();
});

test("matchmaking needs a wallet and a valid stake", async () => {
  const { server, port } = await startServer();
  const c = await client(port, "mm-invalid-1");
  c.send({ type: "findMatch", name: "X", stake: 1, currency: "SOL" });
  assert.match((await c.next("error")).message, /wallet/);
  c.send({ type: "findMatch", name: "X", wallet: WALLET_A, stake: 0, currency: "SOL" });
  assert.match((await c.next("error")).message, /stake/);
  c.close(); server.close();
});
