/* Accounts, Gold Coins and Sweeps Coins. Runs on an in-memory Postgres (pg-mem), or on a real one with
   TEST_DATABASE_URL set (its tables are dropped first). */
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createCoins, WELCOME, DAILY, PACKS, UNIT, SC_RAKE, REDEEM_MIN, TERMS_VERSION } = require("../server/coins");
const fs = require("fs");
const { regionAllowed, isSanctioned, countryOf, LIST_FILE } = require("../server/compliance");
const { createServer } = require("../server");

async function freshPool() {
  if (process.env.TEST_DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query("DROP TABLE IF EXISTS owned_items, consents, redemptions, purchases, ledger, sessions, accounts, meta");
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
  const { token, account } = await coins.register("Ana_9", "correct horse", true);
  assert.equal(account.username, "ana_9");
  assert.deepEqual([account.GC, account.SC], [WELCOME.GC, WELCOME.SC]);
  await assert.rejects(coins.register("ANA_9", "another password", true), /taken/);
  await assert.rejects(coins.register("a", "correct horse", true), /username/);
  await assert.rejects(coins.register("bob", "short", true), /8 characters/);
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
  const { account } = await coins.register("cyan", "password123", true);
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

test("coins: packs credit Gold Coins plus free Sweeps Coins, once per payment; the welcome offer only first", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("dani", "password123", true);
  assert.equal(account.firstPurchase, true);
  assert.equal(await coins.mayBuy(account.id, "welcome"), true);
  await coins.creditPack(account.id, "welcome", "sig-1");
  await assert.rejects(coins.creditPack(account.id, "welcome", "sig-1"), /first purchase only|already been used/);
  await assert.rejects(coins.creditPack(account.id, "gold-bars", "sig-2"), /no such pack/);
  const a = await coins.account(account.id);
  assert.equal(a.firstPurchase, false);
  assert.equal(await coins.mayBuy(account.id, "welcome"), false, "the welcome offer is gone after the first purchase");
  assert.deepEqual([a.GC, a.SC], [WELCOME.GC + PACKS.welcome.gc, WELCOME.SC + PACKS.welcome.sc * UNIT.SC]);
  await assert.rejects(coins.creditPack(account.id, "welcome", "sig-4"), /first purchase only/);
  await coins.creditPack(account.id, "mega", "sig-3");
  assert.deepEqual((await coins.purchases(account.id)).map(p => p.pack).sort(), ["mega", "welcome"]);
  const rows = await pool.query("SELECT reason FROM ledger WHERE account_id = $1 AND ref = 'sig-1' ORDER BY id", [account.id]);
  assert.deepEqual(rows.rows.map(r => r.reason), ["purchase", "purchase-bonus"], "the ledger shows the SC as a bonus, not a sale");
  for (const p of Object.values(PACKS)) assert.ok(p.sc < p.usd * 0.6, `${p.name}: the free SC stay under 60% of the price`);
  await ledgerMatches(pool);
});

// Real Postgres only: pg-mem can't run the CREATE TABLE IF NOT EXISTS setup twice on one database
test("coins: an older database's whole Sweeps Coins become cents, once", { skip: !process.env.TEST_DATABASE_URL && "needs TEST_DATABASE_URL" }, async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("eli", "password123", true);
  // Pretend the database is from before cents: whole coins and no conversion mark
  await pool.query("UPDATE accounts SET sc = 3 WHERE id = $1", [account.id]);
  await pool.query("UPDATE ledger SET delta = 3, balance = 3 WHERE currency = 'SC' AND account_id = $1", [account.id]);
  await pool.query("DELETE FROM meta");
  await createCoins(pool);
  await createCoins(pool);                       // a second start changes nothing
  assert.equal((await coins.account(account.id)).SC, 300);
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

async function coinServer(opts = {}) {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { server, stop } = createServer({ ...FAST, ...opts }, {}, null, coins);
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

  ana.send({ type: "register", username: "ana", password: "password123", acceptTerms: true });
  const signedIn = await ana.next("account", m => m.token);
  ben.send({ type: "register", username: "ben", password: "password123", acceptTerms: true });
  await ben.next("account", m => m.token);

  // More than the balance is refused; less than a cent is refused; Gold Coins are whole
  ana.send({ type: "create", name: "Ana", stake: 1.5, currency: "SC" });
  assert.match((await ana.next("error")).message, /don't have 1.5 Sweeps Coins/);
  ana.send({ type: "create", name: "Ana", stake: 0.005, currency: "SC" });
  assert.match((await ana.next("error")).message, /0.01 to 10,000/);
  ana.send({ type: "create", name: "Ana", stake: 10.5, currency: "GC" });
  assert.match((await ana.next("error")).message, /whole number of Gold Coins/);

  ana.send({ type: "create", mode: "h2h", name: "Ana", stake: WELCOME.SC / UNIT.SC, currency: "SC" });
  const room = await ana.next("room");
  assert.equal(room.escrowed, true);
  assert.equal(room.rake, SC_RAKE);
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
  if (results.outcome === "refund") assert.deepEqual(bal, [WELCOME.SC, WELCOME.SC], "a draw is refunded in full, no house cut");
  else {
    const pot = 2 * WELCOME.SC, winnings = pot - Math.floor(pot * SC_RAKE);
    assert.deepEqual(bal.sort((x, y) => x - y), [0, winnings], "the winner gets the pot less the 10% house cut");
    assert.equal(results.standings[0].payout, winnings / UNIT.SC, "the results screen shows what was really paid");
  }

  // A match with a winner plays the staked free coins through; Ana and Ben staked all their locked coins
  if (results.outcome !== "refund") {
    const locked = (await pool.query("SELECT sc_locked FROM accounts ORDER BY username")).rows.map(r => Number(r.sc_locked));
    assert.deepEqual(locked, [0, 0], "the staked free coins count as played");
  }

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
  cy.send({ type: "register", username: "cyril", password: "password123", acceptTerms: true });
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

/* ---- cashing out Sweeps Coins ---- */

test("cash-out: free coins must be played first, then a verified player can cash out 50 SC or more", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("fay", "password123", true);
  await coins.claimDaily(account.id);
  let a = await coins.account(account.id);
  assert.equal(a.redeemable, 0, "free sign-up and daily coins are not redeemable yet");
  await coins.creditPack(account.id, "mega", "sig-fay");
  assert.equal((await coins.account(account.id)).redeemable, 0, "the free coins with a pack are not redeemable yet either");

  // Winnings are redeemable at once; staked free coins unlock once played
  await coins.bank("SC").pay([{ to: account.id, amount: 6000, reason: "win" }]);
  assert.equal((await coins.account(account.id)).redeemable, 6000);
  await coins.played([{ to: account.id, amount: 100 }]);
  a = await coins.account(account.id);
  assert.equal(a.redeemable, 6100);

  await assert.rejects(coins.requestRedemption(account.id, 6000, "WaLLet1111111111111111111111111111111111"), /Verify your identity/);
  await coins.setVerified("fay", true);
  await assert.rejects(coins.requestRedemption(account.id, REDEEM_MIN - 1, "w"), /least you can cash out is 50/);
  await assert.rejects(coins.requestRedemption(account.id, 6200, "w"), /more than you can cash out/);

  const before = (await coins.account(account.id)).SC;
  const rid = await coins.requestRedemption(account.id, 5000, "WaLLet1111111111111111111111111111111111");
  assert.equal((await coins.account(account.id)).SC, before - 5000, "the coins leave the balance while the request waits");
  assert.deepEqual((await coins.redemptions(account.id)).map(r => [r.amount, r.status]), [[5000, "pending"]]);

  await coins.resolveRedemption(rid, "rejected", "wallet looks wrong");
  assert.equal((await coins.account(account.id)).SC, before, "a rejected cash-out gives the coins back");
  await assert.rejects(coins.resolveRedemption(rid, "paid", "tx"), /not pending/);

  const rid2 = await coins.requestRedemption(account.id, 5000, "WaLLet1111111111111111111111111111111111");
  await coins.resolveRedemption(rid2, "paid", "5xTransaction");
  assert.equal((await coins.account(account.id)).SC, before - 5000);
  assert.deepEqual((await coins.redemptions(account.id)).map(r => r.status), ["paid", "rejected"]);
  await ledgerMatches(pool);
});

test("cash-out: switched off unless the server opens it", async () => {
  const off = await coinServer();
  const c = await client(off.port, "redeem-off");
  assert.equal(c.inbox.find(m => m.type === "hello").coins.redemption, false);
  c.send({ type: "register", username: "gus", password: "password123", acceptTerms: true });
  await c.next("account", m => m.token);
  c.send({ type: "redeem", amount: 50, wallet: "7xQ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.match((await c.next("error")).message, /isn't open yet/);
  c.close(); await off.stop();

  const on = await coinServer({ redemption: true });
  const d = await client(on.port, "redeem-on");
  assert.equal(d.inbox.find(m => m.type === "hello").coins.redemption, true);
  d.send({ type: "register", username: "hal", password: "password123", acceptTerms: true });
  const acct = (await d.next("account", m => m.token)).account;
  await on.coins.setVerified("hal", true);
  await on.coins.bank("SC").pay([{ to: acct.id, amount: 5500, reason: "win" }]);
  d.send({ type: "redeem", amount: 50, wallet: "not a wallet" });
  assert.match((await d.next("error")).message, /Solana wallet/);
  d.send({ type: "redeem", amount: 50, wallet: "7xQ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  await d.next("redeemed");
  const list = await d.next("redemptions");
  assert.deepEqual(list.list.map(r => [r.amount, r.status]), [[5000, "pending"]]);
  d.close();
  await ledgerMatches(on.pool);
  await on.stop();
});

/* ---- terms, privacy, responsible play, compliance ---- */

test("terms: sign-up records the accepted version; an account without it can't play until it accepts", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  await assert.rejects(coins.register("jo", "password123"), /accept the terms/);
  await assert.rejects(coins.register("joe", "password123", false), /accept the terms/);
  const { account } = await coins.register("joe", "password123", true);
  assert.equal(account.termsCurrent, true);
  const rows = (await pool.query("SELECT version FROM consents WHERE account_id = $1", [account.id])).rows;
  assert.deepEqual(rows.map(r => r.version), [TERMS_VERSION]);
  // As if the terms changed after sign-up
  await pool.query("UPDATE consents SET version = 'old' WHERE account_id = $1", [account.id]);
  assert.equal((await coins.account(account.id)).termsCurrent, false);
  await assert.rejects(coins.take(account.id, "GC", 100, "x"), /Accept the updated terms/);
  await coins.acceptTerms(account.id);
  assert.equal(await coins.take(account.id, "GC", 100, "x"), true);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM consents WHERE account_id = $1", [account.id])).rows[0].n), 2, "every acceptance is kept");
});

test("responsible play: a monthly limit stops purchases; lowering is immediate, raising waits a day", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("kim", "password123", true);
  await coins.setSpendLimit(account.id, 500);
  assert.equal((await coins.account(account.id)).spendLimit, 500, "a new limit is lowering, so it's immediate");
  assert.equal(await coins.checkPurchase(account.id, "starter"), null, "$4.99 fits in $5.00");
  await coins.creditPack(account.id, "starter", "sig-k1");
  assert.equal((await coins.account(account.id)).spentThisMonth, 499);
  assert.match(await coins.checkPurchase(account.id, "starter"), /monthly spending limit of \$5.00/);
  await coins.setSpendLimit(account.id, 10000);
  let a = await coins.account(account.id);
  assert.equal(a.spendLimit, 500, "a raise doesn't apply yet");
  assert.equal(a.pendingLimit.cents, 10000);
  assert.match(await coins.checkPurchase(account.id, "starter"), /spending limit/);
  await pool.query("UPDATE accounts SET spend_limit_next_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), account.id]);
  a = await coins.account(account.id);
  assert.equal(a.spendLimit, 10000, "the raise applies once its day has passed");
  assert.equal(await coins.checkPurchase(account.id, "starter"), null);
  await coins.setSpendLimit(account.id, null);
  assert.equal((await coins.account(account.id)).spendLimit, 10000, "removing a limit also waits a day");
});

test("responsible play: a break or self-exclusion stops play, free coins and purchases, and can't be shortened", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("lou", "password123", true);
  await coins.pause(account.id, "exclude-182");
  await coins.pause(account.id, "break-1");                     // shorter: ignored
  const a = await coins.account(account.id);
  assert.equal(a.pauseKind, "exclusion");
  assert.ok(new Date(a.pausedUntil) > new Date(Date.now() + 150 * 864e5), "the longer exclusion stands");
  await assert.rejects(coins.take(account.id, "GC", 100, "x"), /excluded yourself until/);
  await assert.rejects(coins.claimDaily(account.id), /excluded yourself/);
  assert.match(await coins.checkPurchase(account.id, "starter"), /excluded yourself/);
  await assert.rejects(coins.pause(account.id, "forever-and-ever"), /how long/);
});

test("your data: download everything held, and close the account", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account, token } = await coins.register("max", "password123", true);
  await coins.claimDaily(account.id);
  const data = await coins.exportData(account.id);
  assert.equal(data.account.username, "max");
  assert.ok(!("pass_hash" in data.account), "the export never includes the password hash");
  assert.deepEqual(data.ledger.map(l => l.reason), ["welcome", "welcome", "daily", "daily"]);
  assert.equal(data.consents[0].version, TERMS_VERSION);

  await assert.rejects(coins.deleteAccount(account.id, "wrong password"), /password isn't right/);
  await coins.deleteAccount(account.id, "password123");
  assert.equal(await coins.account(account.id), null);
  assert.equal(await coins.resume(token), null, "its sessions are gone");
  await assert.rejects(coins.login("max", "password123"), /Wrong username or password/);
  const kept = (await pool.query("SELECT username, gc, sc, deleted_at FROM accounts WHERE id = $1", [account.id])).rows[0];
  assert.deepEqual([kept.username, Number(kept.gc), Number(kept.sc)], ["deleted-" + account.id, 0, 0]);
  assert.ok(kept.deleted_at);
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM ledger WHERE account_id = $1", [account.id])).rows[0].n > 0, "coin records are kept");
  const again = await coins.register("max", "password123", true);
  assert.notEqual(again.account.id, account.id, "the name is free again");
  await ledgerMatches(pool);
});

test("closing an account waits for a pending cash-out", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("ned", "password123", true);
  await coins.setVerified("ned", true);
  await coins.bank("SC").pay([{ to: account.id, amount: 6000, reason: "win" }]);
  await coins.requestRedemption(account.id, 5000, "7xQ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "GB");
  assert.equal((await coins.exportData(account.id)).cashOuts[0].country, "GB");
  await assert.rejects(coins.deleteAccount(account.id, "password123"), /Wait for your cash-out/);
});

test("compliance: blocked countries and the sanctions list", () => {
  const saved = { ...process.env };
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(countryOf({ headers: { "cf-ipcountry": "IR" } }), null, "the country header is only trusted behind the proxy");
    process.env.TRUST_PROXY = "1";
    assert.equal(countryOf({ headers: { "cf-ipcountry": "ir" } }), "IR");
    assert.equal(countryOf({ headers: { "cf-ipcountry": "XX" } }), null);
    assert.equal(regionAllowed("IR"), false, "comprehensively sanctioned countries are blocked by default");
    assert.equal(regionAllowed("T1"), false, "Tor is blocked");
    assert.equal(regionAllowed("GB"), true);
    assert.equal(regionAllowed(null), true, "an unknown country may still play and buy");
    assert.equal(regionAllowed(null, { cashOut: true }), false, "but not cash out behind the proxy");
    process.env.BLOCKED_COUNTRIES = "US,GB";
    assert.equal(regionAllowed("GB"), false, "a lawyer's list replaces the default");
    assert.equal(regionAllowed("IR"), true);
  } finally { process.env = saved; }

  const lines = fs.readFileSync(LIST_FILE, "utf8").split("\n");
  const sol = lines[lines.indexOf("# SOL") + 1];
  assert.ok(sol && isSanctioned(sol), "a Solana address on the OFAC list is caught");
  assert.equal(isSanctioned("7xQ9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
});

test("compliance over the connection: no Sweeps Coin play or cash-out from a blocked country, no payout to a listed wallet", async () => {
  const saved = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "1";
  const on = await coinServer({ redemption: true });
  try {
    const connect = (key, country) => new Promise(resolve => {
      const ws = new WebSocket(`ws://localhost:${on.port}/ws`, { headers: { "cf-ipcountry": country } });
      const inbox = [];
      ws.on("message", raw => inbox.push(JSON.parse(raw)));
      ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", key: key.padEnd(16, "0") })); resolve({ ws, inbox, send: m => ws.send(JSON.stringify(m)) }); });
    });
    const wait = async (c, pred) => { for (let i = 0; i < 100; i++) { const m = c.inbox.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 20)); } throw new Error("no reply"); };

    const iran = await connect("from-iran", "IR");
    assert.equal((await wait(iran, m => m.type === "hello")).coins.regionAllowed, false);
    iran.send({ type: "register", username: "ozzy", password: "password123", acceptTerms: true });
    await wait(iran, m => m.type === "account" && m.token);
    iran.send({ type: "create", name: "Oz", stake: 0.5, currency: "SC" });
    assert.match((await wait(iran, m => m.type === "error")).message, /aren't available where you are/);
    iran.ws.close();

    const uk = await connect("from-uk", "GB");
    uk.send({ type: "register", username: "pia", password: "password123", acceptTerms: true });
    const acct = (await wait(uk, m => m.type === "account" && m.token)).account;
    await on.coins.setVerified("pia", true);
    await on.coins.bank("SC").pay([{ to: acct.id, amount: 6000, reason: "win" }]);
    const lines = fs.readFileSync(LIST_FILE, "utf8").split("\n");
    uk.send({ type: "redeem", amount: 50, wallet: lines[lines.indexOf("# SOL") + 1] });
    assert.match((await wait(uk, m => m.type === "error" && m.about === "redeem")).message, /can't pay that wallet/);
    uk.ws.close();
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved;
    await on.stop();
  }
});

/* ---- Gold Coin items ---- */

test("items: Gold Coins buy an avatar, frame or name colour once, and only owned items can be worn", async () => {
  const pool = await freshPool(), coins = await createCoins(pool);
  const { account } = await coins.register("ola", "password123", true);
  await assert.rejects(coins.buyItem(account.id, "no-such-thing"), /no such item/);
  await assert.rejects(coins.buyItem(account.id, "__proto__"), /no such item/);
  await assert.rejects(coins.equip(account.id, "avatar", "av-goat"), /Buy it first/);
  await coins.buyItem(account.id, "av-goat");                                  // 6,000 of the 10,000 welcome GC
  await assert.rejects(coins.buyItem(account.id, "av-goat"), /already own/);
  await assert.rejects(coins.buyItem(account.id, "fr-gold"), /need 8,000 Gold Coins/);
  let a = await coins.account(account.id);
  assert.equal(a.GC, 4000, "a refused purchase takes nothing");
  assert.deepEqual(a.owned, ["av-goat"]);
  await assert.rejects(coins.equip(account.id, "frame", "av-goat"), /no such item/, "an avatar isn't a frame");
  await assert.rejects(coins.equip(account.id, "hat", null), /no such item/);
  await coins.equip(account.id, "avatar", "av-goat");
  assert.equal((await coins.account(account.id)).look.avatar, "av-goat");
  await coins.equip(account.id, "avatar", null);
  assert.equal((await coins.account(account.id)).look.avatar, null);
  assert.deepEqual((await coins.exportData(account.id)).items.map(i => i.item), ["av-goat"]);
  await coins.pause(account.id, "break-1");
  await assert.rejects(coins.buyItem(account.id, "nc-green"), /taking a break/);
  await ledgerMatches(pool);
});

test("items: what a player wears shows on everyone's room screen, and changes at once", async () => {
  const { coins, port, stop } = await coinServer();
  try {
    const ana = await client(port, "look-ana"), ben = await client(port, "look-ben");
    assert.equal(ana.inbox.find(m => m.type === "hello").coins.items["av-goat"].value, "🐐");
    ana.send({ type: "register", username: "anal", password: "password123", acceptTerms: true });
    await ana.next("account", m => m.token);
    ana.send({ type: "buyItem", item: "av-lion" }); await ana.next("itemBought");
    ana.send({ type: "equip", kind: "avatar", item: "av-lion" }); await ana.next("equipped");
    ben.send({ type: "register", username: "benl", password: "password123", acceptTerms: true });
    await ben.next("account", m => m.token);
    ana.send({ type: "create", name: "Ana", stake: 10, currency: "GC" });
    const { code } = await ana.next("room");
    ben.send({ type: "join", name: "Ben", code });
    const seen = await ben.next("room", m => m.players.length === 2);
    assert.equal(seen.players.find(p => p.name === "Ana").look.avatar, "av-lion");
    assert.equal(seen.players.find(p => p.name === "Ben").look.avatar, null);
    ana.send({ type: "buyItem", item: "nc-purple" }); await ana.next("itemBought");
    ana.send({ type: "equip", kind: "color", item: "nc-purple" }); await ana.next("equipped");
    await ben.next("room", m => m.players.find(p => p.name === "Ana").look.color === "nc-purple");
    ana.send({ type: "equip", kind: "frame", item: "fr-gold" });
    assert.match((await ana.next("error", m => m.about === "items")).message, /Buy it first/);
    ana.close(); ben.close();
  } finally { await stop(); }
});
