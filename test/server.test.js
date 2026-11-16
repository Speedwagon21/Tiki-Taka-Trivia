/* End-to-end over real WebSockets: create a room, join with the code, play a match. */
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createServer } = require("../server");

const WALLET_A = "7xQ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".slice(0, 44);
const WALLET_B = "9bQ7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".slice(0, 44);
const FAST = { questionMs: 400, revealMs: 60, countdownMs: 30, graceMs: 200 };

function startServer(opts = FAST, limits, escrow) {
  const { server, stop } = createServer(opts, limits, escrow);
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
    c.send({ type: "hello", key: key.padEnd(16, "0") });
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
  const manifest = await fetch(`http://localhost:${port}/play/manifest.webmanifest`);
  assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
  for (const icon of (await manifest.json()).icons) assert.equal((await fetch(`http://localhost:${port}/play/${icon.src}`)).status, 200);
  // The game moved to /play/: old invite links still reach it with their code
  const invite = await fetch(`http://localhost:${port}/?room=ABCDE`, { redirect: "manual" });
  assert.equal(invite.status, 302);
  assert.equal(invite.headers.get("location"), "/play/?room=ABCDE");
  assert.equal((await fetch(`http://localhost:${port}/play/`)).status, 200);
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

/* ---- security ---- */

test("malformed fields cannot crash the server", async () => {
  const { server, port } = await startServer();
  const c = await client(port, "crash-attempt-1");
  const bad = { toString: 1 };
  c.send({ type: "create", name: "x", wallet: WALLET_A, stake: bad, currency: "SOL" });
  assert.match((await c.next("error")).message, /stake/);
  c.send({ type: "create", name: bad, wallet: WALLET_A, stake: 1, currency: bad, mode: bad, recent: bad });
  const room = await c.next("room");
  assert.equal(room.players[0].name, "Player");
  c.send({ type: "lookup", code: bad });
  assert.match((await c.next("error")).message, /No room/);
  c.send({ type: "join", code: bad, name: bad, wallet: WALLET_B });
  assert.match((await c.next("error")).message, /No room/);
  c.send({ type: "answer", index: bad, choice: bad });
  c.send({ type: "lookup", code: room.code });
  assert.equal((await c.next("lookup")).room.code, room.code, "still serving after the bad messages");
  c.close(); server.close();
});

test("a connection keeps one identity, so it cannot leave rooms behind", async () => {
  const { server, port } = await startServer({ ...FAST, graceMs: 30 });
  const c = await client(port, "one-identity-01");
  const watcher = await client(port, "one-identity-watch");
  const codes = [];
  for (let i = 0; i < 5; i++) {
    c.send({ type: "hello", key: `second-identity-${i}0` });
    c.send({ type: "create", name: "x", wallet: WALLET_A, stake: 1, currency: "SOL" });
    codes.push((await c.next("room")).code);
  }
  // Each create replaced the last room: only the newest code is live
  watcher.send({ type: "lookup", code: codes[0] });
  assert.match((await watcher.next("error")).message, /No room/);
  c.close();
  await new Promise(r => setTimeout(r, 150));
  watcher.send({ type: "lookup", code: codes[4] });
  assert.match((await watcher.next("error")).message, /No room/, "nothing left once the connection is gone");
  watcher.close(); server.close();
});

test("short session keys are refused", async () => {
  const { server, port } = await startServer();
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise(r => ws.on("open", r));
  const reply = new Promise(r => ws.on("message", raw => r(JSON.parse(raw))));
  ws.send(JSON.stringify({ type: "hello", key: "guessable" }));
  assert.match((await reply).message, /Bad client key/);
  ws.close(); server.close();
});

test("connections from another website are refused, and each address has a connection limit", async () => {
  const { server, port } = await startServer(FAST, { perIp: 3 });
  const open = headers => new Promise(resolve => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers });
    ws.on("open", () => resolve(ws));
    ws.on("error", () => resolve(null));
  });
  assert.equal(await open({ Origin: "https://evil.example" }), null);
  const own = await open({ Origin: `http://localhost:${port}` });
  assert.ok(own);
  const more = [await open(), await open()];
  assert.ok(more.every(Boolean));
  assert.equal(await open(), null, "the 4th connection from one address is refused");
  more[0].close();
  await new Promise(r => setTimeout(r, 50));
  const again = await open();
  assert.ok(again, "a slot frees up when a connection closes");
  [own, more[1], again].forEach(ws => ws.close());
  server.close();
});

test("room code guessing and message floods are cut off", async () => {
  const { server, port } = await startServer(FAST, { lookupsPerMin: 5 });
  const c = await client(port, "scanner-0000001");
  for (let i = 0; i < 5; i++) { c.send({ type: "lookup", code: "ZZZZ" + i }); assert.match((await c.next("error")).message, /No room/); }
  c.send({ type: "lookup", code: "ZZZZZ" });
  assert.match((await c.next("error")).message, /Too many tries/);

  const flood = await client(port, "flooder-0000001");
  const closed = new Promise(r => flood.ws.on("close", code => r(code)));
  for (let i = 0; i < 40; i++) flood.send({ type: "cancelSearch" });
  assert.equal(await closed, 1008);
  c.close(); server.close();
});

test("idle rooms are closed, names are de-duplicated and wallets are shortened for other players", async () => {
  const { server, port } = await startServer({ ...FAST, idleMs: 150, sweepMs: 30 });
  const a = await client(port, "idle-host-000001");
  const b = await client(port, "idle-guest-00001");
  a.send({ type: "create", name: "A\u200Bna\u202E", wallet: WALLET_A, stake: 1, currency: "SOL" });
  const room = await a.next("room");
  assert.equal(room.players[0].name, "Ana", "invisible and direction characters are stripped");
  b.send({ type: "join", code: room.code, name: "ANA", wallet: WALLET_B });
  const joined = await b.next("room");
  assert.deepEqual(joined.players.map(p => p.name), ["Ana", "ANA 2"]);
  assert.ok(joined.players.every(p => p.wallet.length < 12), "full addresses are not shared");
  await a.next("closed", () => true, 2000);
  a.close(); b.close(); server.close();
});

test("pages are served with a content security policy", async () => {
  const { server, port } = await startServer();
  const res = await fetch(`http://localhost:${port}/`);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.ok(res.headers.get("strict-transport-security"));
  server.close();
});

/* ---- escrow: real stakes, with the blockchain replaced by a stand-in ---- */

const FEE = 5000, SOL = 1e9;
/* Stand-in chain: a "signature" of `ok:<wallet>` is a confirmed payment from that wallet */
function fakeEscrow() {
  const intents = new Map(), sent = [];
  return {
    address: "EscrowWa11et", rpcUrl: "test", fee: FEE, sent,
    intent(owner, lamports) { const ref = "ref" + intents.size; intents.set(ref, { owner, lamports }); return { ref, to: this.address, lamports }; },
    async verify(owner, ref, signature) {
      const i = intents.get(ref);
      if (!i || i.owner !== owner || !signature.startsWith("ok:")) throw Object.assign(new Error("no"), { userMessage: "Payment not found." });
      intents.delete(ref);
      return { payer: signature.slice(3), lamports: i.lamports };
    },
    pay(transfers) { sent.push(transfers); return Promise.resolve("tx" + sent.length); },
    idle: () => Promise.resolve()
  };
}
/* Asks what to pay, "pays" it from `wallet`, and returns the deposit to attach to the next message */
async function stake(c, wallet, req) {
  c.send({ type: "intent", ...req });
  const intent = await c.next("intent");
  return { deposit: { ref: intent.ref, signature: "ok:" + wallet }, lamports: intent.lamports };
}

test("escrow: stakes are taken before seating, refunded on leaving, and the pot is paid to the winner", async () => {
  const escrow = fakeEscrow();
  const { server, port } = await startServer({ ...FAST, questionMs: 5000 }, undefined, escrow);
  const host = await client(port, "escrow-host-0001");
  const guest = await client(port, "escrow-guest-001");
  assert.equal(host.inbox.find(m => m.type === "hello").escrow.address, "EscrowWa11et");

  // No payment, or a payment that isn't on-chain: no room
  host.send({ type: "create", name: "Ana", wallet: WALLET_A, stake: 2, currency: "SOL" });
  assert.match((await host.next("error")).message, /payment is missing/);
  const bad = await stake(host, WALLET_A, { stake: 2 });
  host.send({ type: "create", name: "Ana", wallet: WALLET_A, stake: 2, currency: "SOL", deposit: { ...bad.deposit, signature: "nope" } });
  assert.match((await host.next("error")).message, /Payment not found/);

  const h = await stake(host, WALLET_A, { stake: 2 });
  assert.equal(h.lamports, 2 * SOL);
  host.send({ type: "create", name: "Ana", wallet: WALLET_B, stake: 2, currency: "SOL", ...h });
  const room = await host.next("room");
  assert.equal(room.escrowed, true);
  assert.equal(room.players[0].paid, true);
  assert.equal(room.players[0].wallet, "7xQ9…aaaa", "the wallet that paid is used, not the one claimed");

  // A payment can't be used twice
  host.send({ type: "pay", ...h });
  guest.send({ type: "join", code: room.code, name: "Ben", wallet: WALLET_B, ...h });
  assert.match((await guest.next("error")).message, /Payment not found/);

  // Guest pays and joins, leaves the waiting room, and gets the stake back less the fee
  const g1 = await stake(guest, WALLET_B, { code: room.code });
  guest.send({ type: "join", code: room.code, name: "Ben", wallet: WALLET_B, ...g1 });
  await guest.next("room");
  guest.send({ type: "leave" });
  const refund = await guest.next("refund");
  assert.equal(refund.lamports, 2 * SOL - FEE);
  assert.deepEqual(escrow.sent[0], [{ to: WALLET_B, lamports: 2 * SOL - FEE }]);

  const g2 = await stake(guest, WALLET_B, { code: room.code });
  guest.send({ type: "join", code: room.code, name: "Ben", wallet: WALLET_B, ...g2 });
  await host.next("room", m => m.players.length === 2 && m.players.every(p => p.paid));
  host.send({ type: "start" });

  for (let i = 0; i < 3; i++) {
    await host.next("question", m => m.index === i);
    host.send({ type: "answer", index: i, choice: 0 });
    guest.send({ type: "answer", index: i, choice: 0 });
    await host.next("reveal", m => m.index === i);
  }
  const results = await host.next("results");
  assert.equal(results.escrowed, true);
  assert.equal(results.tx, null, "the real signature arrives with the payout");
  assert.equal((await host.next("payout")).tx, "tx2");
  const paid = escrow.sent[1];
  assert.equal(paid.reduce((sum, t) => sum + t.lamports, 0) + FEE, 4 * SOL, "the whole pot goes out, less one fee");
  const expected = results.outcome === "refund" ? [WALLET_A, WALLET_B] : [results.standings[0].id === results.winnerIds[0] && results.winnerIds[0] === room.you ? WALLET_A : WALLET_B];
  assert.deepEqual(paid.map(t => t.to).sort(), expected.sort());

  // The next match needs new stakes from everyone
  host.send({ type: "start" });
  assert.match((await host.next("error")).message, /pay their stake/);
  host.send({ type: "pay", ...(await stake(host, WALLET_A, { room: true })) });
  guest.send({ type: "pay", ...(await stake(guest, WALLET_B, { room: true })) });
  await host.next("room", m => m.phase === "results" && m.players.every(p => p.paid));
  host.send({ type: "start" });
  await guest.next("countdown");

  // Server shutdown mid-match returns what it holds
  const before = escrow.sent.length;
  await server.close();
  assert.equal(escrow.sent.length, before + 2);
  host.close(); guest.close();
});

test("escrow: matchmaking refunds a cancelled search, and a seat that can't be taken", async () => {
  const escrow = fakeEscrow();
  const { server, port } = await startServer(FAST, undefined, escrow);
  const a = await client(port, "escrow-mm-a-0001");
  const b = await client(port, "escrow-mm-b-0001");
  const c = await client(port, "escrow-mm-c-0001");

  a.send({ type: "findMatch", name: "A", wallet: WALLET_A, stake: 1, currency: "SOL", ...(await stake(a, WALLET_A, { stake: 1 })) });
  await a.next("searching");
  a.send({ type: "cancelSearch" });
  assert.equal((await a.next("refund")).lamports, SOL - FEE);

  // USDC is still simulated: no payment needed even with the escrow on
  a.send({ type: "create", name: "A", wallet: WALLET_A, stake: 1, currency: "USDC" });
  assert.equal((await a.next("room")).escrowed, false);
  a.send({ type: "leave" });

  // Two players matched head to head; a third who pays for the full room is refunded
  a.send({ type: "create", mode: "h2h", name: "A", wallet: WALLET_A, stake: 1, currency: "SOL", ...(await stake(a, WALLET_A, { stake: 1 })) });
  const room = await a.next("room", m => m.escrowed);
  const late = await stake(c, WALLET_B, { code: room.code });
  b.send({ type: "join", code: room.code, name: "B", wallet: WALLET_B, ...(await stake(b, WALLET_B, { code: room.code })) });
  await b.next("countdown");
  c.send({ type: "join", code: room.code, name: "C", wallet: WALLET_B, ...late });
  assert.match((await c.next("error")).message, /under way|two players/);
  assert.equal((await c.next("refund")).lamports, SOL - FEE);

  // Head-to-head rematch: paying is what casts your vote
  await a.next("results", () => true, 5000);
  await a.next("payout");
  a.send({ type: "rematch" });
  assert.match((await a.next("error")).message, /Pay your stake/);
  a.send({ type: "pay", rematch: true, ...(await stake(a, WALLET_A, { room: true })) });
  await b.next("room", m => m.rematch.length === 1);
  b.send({ type: "leave" });                         // opponent walks away: the payer's stake comes back when they leave
  await a.next("room", m => m.players.length === 1);
  a.send({ type: "leave" });
  assert.equal((await a.next("refund")).lamports, SOL - FEE);

  [a, b, c].forEach(x => x.close());
  await server.close();
});

test("the Solana library is served to the page", async () => {
  const { server, port } = await startServer();
  const res = await fetch(`http://localhost:${port}/vendor/web3.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  await res.arrayBuffer();
  server.close();
});
