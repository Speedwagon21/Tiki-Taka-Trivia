/* Accounts, Gold Coins and Sweeps Coins. Runs on an in-memory Postgres (pg-mem), or on a real one with
   TEST_DATABASE_URL set (its tables are dropped first). */
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createCoins, WELCOME, DAILY, PACKS, FIRST_BONUS } = require("../server/coins");
const { createServer } = require("../server");

async function freshPool() {
  if (process.env.TEST_DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query("DROP TABLE IF EXISTS purchases, ledger, sessions, accounts");
    return pool;
  }
  const { newDb } = require("pg-mem");
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

/* Every account's balances must equal the sum of its ledger rows */
async function ledgerMatches(pool) {
  const sums = {};
  for (const r of (await pool.query("SELECT account_id, currency, SUM(delta) AS total FROM ledger GROUP BY account_id, currency")).rows) {
    sums[`${r.account_id}:${r.currency}`] = Number(r.total);
  }
  for (const a of (await pool.query("SELECT id, gc, sc FROM accounts")).rows) {
    assert.equal(Number(a.gc), sums[`${a.id}:GC`] || 0, `GC ledger of account ${a.id}`);
    assert.equal(Number(a.sc), sums[`${a.id}:SC`] || 0, `SC ledger of account ${a.id}`);
  }
}

test("accounts: sign up with welcome coins, log in, resume and log out", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { token, account } = await coins.register("Ana_9", "correct horse");
  assert.equal(account.username, "ana_9");
  assert.deepEqual([account.GC, account.SC], [WELCOME.GC, WELCOME.SC]);
  await assert.rejects(coins.register("ANA_9", "another password"), /taken/);
  await assert.rejects(coins.register("a", "correct horse"), /username/);
  await assert.rejects(coins.register("bob", "short"), /8 characters/);
  await assert.rejects(coins.login("ana_9", "wrong password"), /Wrong username or password/);
  await assert.rejects(coins.login("nobody", "correct horse"), /Wrong username or password/);
  const again = await coins.login("ANA_9", "correct horse");
  assert.equal(await coins.resume(token), account.id);
  assert.equal(await coins.resume(again.token), account.id);
  assert.equal(await coins.resume("not-a-token"), null);
  await coins.logout(token);
  assert.equal(await coins.resume(token), null, "a logged-out session is gone");
  const stored = await pool.query("SELECT pass_hash FROM accounts");
  assert.ok(!stored.rows[0].pass_hash.includes("correct horse"), "the password is never stored as written");
  await ledgerMatches(pool);
});

test("coins: the daily claim works once a day, and a balance can't be overspent", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const changed = [];
  coins.onChange = id => changed.push(id);
  const { account } = await coins.register("cyan", "password123");
  assert.equal(account.dailyReady, true);
  await coins.claimDaily(account.id);
  await assert.rejects(coins.claimDaily(account.id), /today's free coins/);
  const after = await coins.account(account.id);
  assert.deepEqual([after.GC, after.SC, after.dailyReady], [WELCOME.GC + DAILY.GC, WELCOME.SC + DAILY.SC, false]);

  assert.equal(await coins.take(account.id, "SC", after.SC + 1, "x"), false, "can't stake more than the balance");
  assert.equal(await coins.take(account.id, "SC", after.SC, "x"), true);
  assert.equal((await coins.account(account.id)).SC, 0);
  assert.ok(changed.length >= 2, "balance changes are announced");
  await ledgerMatches(pool);
});

test("coins: a paid pack credits Gold Coins plus its free Sweeps Coins, once per payment", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("dani", "password123");
  assert.equal(account.firstPurchase, true);
  const first = await coins.creditPack(account.id, "starter", "sig-1");
  assert.equal(first.extra, PACKS.starter.gc * FIRST_BONUS, "the first pack comes with 50% more Gold Coins");
  await assert.rejects(coins.creditPack(account.id, "starter", "sig-1"), /already been used/);
  await assert.rejects(coins.creditPack(account.id, "gold-bars", "sig-2"), /no such pack/);
  const a = await coins.account(account.id);
  assert.equal(a.firstPurchase, false);
  assert.deepEqual([a.GC, a.SC], [WELCOME.GC + PACKS.starter.gc * (1 + FIRST_BONUS), WELCOME.SC + PACKS.starter.sc]);
  const second = await coins.creditPack(account.id, "mega", "sig-3");
  assert.equal(second.extra, 0, "only the first pack has the bonus");
  assert.deepEqual((await coins.purchases(account.id)).map(p => p.pack).sort(), ["mega", "starter"]);
  const rows = await pool.query("SELECT reason FROM ledger WHERE account_id = $1 AND reason LIKE '%purchase%' AND ref = 'sig-1' ORDER BY id", [account.id]);
  assert.deepEqual(rows.rows.map(r => r.reason), ["purchase", "purchase-bonus", "first-purchase-bonus"], "the ledger shows the SC as a bonus, not a sale");
  await ledgerMatches(pool);
});

/* ---- coin matches over real connections ---- */

const FAST = { questionMs: 300, revealMs: 40, countdownMs: 20, graceMs: 200 };

function client(port, key) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [], waiters = [], used = new Set();
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (!used.has(m) && waiters[i].match(m)) { used.add(m); waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  const c = {
    ws, inbox, send: m => ws.send(JSON.stringify(m)),
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

async function coinServer() {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { server, stop } = createServer(FAST, {}, null, coins);
  await new Promise(r => server.listen(0, r));
  return { pool, coins, port: server.address().port, stop };
}

test("coin rooms: stakes come from accounts, need no wallet, and the winner takes the pot", async () => {
  const { pool, port, stop } = await coinServer();
  const ana = await client(port, "coin-ana");
  const ben = await client(port, "coin-ben");
  assert.ok(ana.inbox.find(m => m.type === "hello").coins, "the server says coins are on");

  // With coins on, rooms are coin rooms only: SOL and USDC stakes are switched off
  assert.equal(ana.inbox.find(m => m.type === "hello").cryptoStakes, false);
  ana.send({ type: "create", name: "Ana", wallet: "7xQ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stake: 1, currency: "SOL" });
  assert.match((await ana.next("error")).message, /Gold Coins or Sweeps Coins/);

  // Signed out: no coin games
  ana.send({ type: "create", name: "Ana", stake: 1, currency: "SC" });
  assert.match((await ana.next("error")).message, /Sign in/);

  ana.send({ type: "register", username: "ana", password: "password123" });
  const signedIn = await ana.next("account", m => m.token);
  ben.send({ type: "register", username: "ben", password: "password123" });
  await ben.next("account", m => m.token);

  // More than the balance is refused; a fraction of a coin is refused
  ana.send({ type: "create", name: "Ana", stake: WELCOME.SC + 1, currency: "SC" });
  assert.match((await ana.next("error")).message, /don't have 3 Sweeps Coins/);
  ana.send({ type: "create", name: "Ana", stake: 1.5, currency: "SC" });
  assert.match((await ana.next("error")).message, /whole number/);

  ana.send({ type: "create", mode: "h2h", name: "Ana", stake: 2, currency: "SC" });
  const room = await ana.next("room");
  assert.equal(room.escrowed, true);
  assert.equal((await ana.next("account", m => m.account && m.account.SC === 0)).account.SC, 0, "the stake left Ana's balance");

  ben.send({ type: "join", code: room.code, name: "Ben" });
  await ben.next("countdown");
  for (let i = 0; i < 3; i++) {
    const q = await ana.next("question", m => m.index === i);
    // Ana answers every option until one is right: she answers first, so if right she wins on speed
    ana.send({ type: "answer", index: i, choice: 0 });
    ben.send({ type: "answer", index: i, choice: 1 });
    await ana.next("reveal", m => m.index === i);
    assert.ok(q);
  }
  const results = await ana.next("results");
  await ana.next("payout", m => m.tx);
  await new Promise(r => setTimeout(r, 100));
  const bal = (await pool.query("SELECT username, sc FROM accounts ORDER BY username")).rows.map(r => Number(r.sc));
  assert.equal(bal[0] + bal[1], 2 * WELCOME.SC, "no coins created or lost");
  if (results.outcome === "refund") assert.deepEqual(bal, [WELCOME.SC, WELCOME.SC]);
  else assert.deepEqual(bal.sort(), [0, 2 * WELCOME.SC].sort(), "the winner holds both stakes");

  // Signing in again on a new connection resumes the account
  const again = await client(port, "coin-ana-2");
  again.send({ type: "hello" });
  const resumed = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise(r => resumed.on("open", r));
  const acct = new Promise(r => resumed.on("message", raw => { const m = JSON.parse(raw); if (m.type === "account") r(m.account); }));
  resumed.send(JSON.stringify({ type: "hello", key: "coin-ana-resume0", session: signedIn.token }));
  assert.equal((await acct).username, "ana");

  [ana, ben, again].forEach(c => c.close()); resumed.close();
  await ledgerMatches(pool);
  await stop();
});

test("coin rooms: leaving a waiting room or cancelling a search gives the coins back", async () => {
  const { pool, port, stop } = await coinServer();
  const cy = await client(port, "coin-cy");
  cy.send({ type: "register", username: "cyril", password: "password123" });
  await cy.next("account", m => m.token);

  cy.send({ type: "create", name: "Cy", stake: 500, currency: "GC" });
  await cy.next("room");
  await cy.next("account", m => m.account.GC === WELCOME.GC - 500);
  cy.send({ type: "leave" });
  assert.equal((await cy.next("refund")).amount, 500);
  await cy.next("account", m => m.account.GC === WELCOME.GC);

  cy.send({ type: "findMatch", name: "Cy", stake: 700, currency: "GC" });
  await cy.next("searching");
  cy.send({ type: "cancelSearch" });
  assert.equal((await cy.next("refund")).amount, 700);
  await cy.next("account", m => m.account.GC === WELCOME.GC);

  cy.send({ type: "claimDaily" });
  await cy.next("claimed");
  cy.send({ type: "claimDaily" });
  assert.match((await cy.next("error")).message, /today's free coins/);

  cy.close();
  await ledgerMatches(pool);
  await stop();
});
