/* Accounts and the two coins.
   Gold Coins (GC) are bought and played for fun; they never cash out.
   Sweeps Coins (SC) are never sold: they come free (on sign-up, once a day, and as a bonus with a
   Gold Coin pack) and are what players win from each other in SC rooms.
   Every change to a balance is one row in `ledger`, written in the same transaction as the balance.
   Amounts are stored in whole units: Gold Coins as coins, Sweeps Coins in cents (UNIT.SC = 100 to a coin). */
const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

const CURRENCIES = ["GC", "SC"];
const UNIT = { GC: 1, SC: 100 };                // stored units per coin
const WELCOME = { GC: 10000, SC: 100 };         // in units: 10,000 GC and 1 SC
const DAILY = { GC: 2000, SC: 30 };             // in units: 2,000 GC and 0.30 SC
const SC_RAKE = 0.1;                            // the house keeps 10% of every Sweeps Coin pot a player wins
const SESSION_DAYS = 30;
/* Gold Coin packs, priced in dollars and charged in SOL at checkout, cheapest first. `sc` is whole
   Sweeps Coins given free with the pack (1 SC is meant to redeem for $1), kept well under the price.
   `firstOnly` packs can only be an account's first purchase. */
const PACKS = {
  welcome: { name: "Welcome offer", usd: 1.99, gc: 5000, sc: 1, firstOnly: true, tag: "First purchase only" },
  starter: { name: "Starter", usd: 4.99, gc: 5000, sc: 2 },
  plus: { name: "Hat-trick", usd: 9.99, gc: 12000, sc: 4, tag: "Most popular" },
  pro: { name: "Pro", usd: 19.99, gc: 25000, sc: 8 },
  mega: { name: "Golden Boot", usd: 49.99, gc: 70000, sc: 18, tag: "Best value" }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  gc BIGINT NOT NULL DEFAULT 0 CHECK (gc >= 0),
  sc BIGINT NOT NULL DEFAULT 0 CHECK (sc >= 0),
  last_daily DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL,
  delta BIGINT NOT NULL,
  balance BIGINT NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchases (
  signature TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  pack TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

const playerError = message => Object.assign(new Error(message), { userMessage: message });
/* Turns Postgres's duplicate-key error into a message for the player */
const unique = (promise, message) => promise.catch(err => { throw err.code === "23505" ? playerError(message) : err; });
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const col = c => (c === "GC" ? "gc" : "sc");      // the only two column names that ever reach SQL

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + (await scrypt(password, salt, 32)).toString("hex");
}
async function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(":");
  const got = await scrypt(password, Buffer.from(salt, "hex"), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, "hex"));
}

/* pool: a pg Pool (or pg-mem's). Set api.onChange(accountId) to hear about every balance change. */
async function createCoins(pool) {
  const onChange = id => api.onChange(id);
  await pool.query(SCHEMA);
  // Sweeps Coins used to be stored as whole coins; they are cents now. Converts an older database once.
  await tx(async client => {
    const done = await client.query("SELECT value FROM meta WHERE key = 'sc_units'");
    if (done.rows.length) return;
    await client.query("UPDATE accounts SET sc = sc * 100");
    await client.query("UPDATE ledger SET delta = delta * 100, balance = balance * 100 WHERE currency = 'SC'");
    await client.query("INSERT INTO meta (key, value) VALUES ('sc_units', 'cents')");
  });

  /* Runs fn(client) in one transaction */
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  /* Adds delta (negative to take) to one balance and records it. Returns the new balance,
     or null when the balance is too low; a balance never goes below zero. */
  async function move(client, accountId, currency, delta, reason, ref = null) {
    const c = col(currency);
    const r = await client.query(
      `UPDATE accounts SET ${c} = ${c} + $1 WHERE id = $2 AND ${c} + $1 >= 0 RETURNING ${c} AS balance`,
      [delta, accountId]);
    if (!r.rows.length) return null;
    const balance = Number(r.rows[0].balance);
    await client.query(
      "INSERT INTO ledger (account_id, currency, delta, balance, reason, ref) VALUES ($1, $2, $3, $4, $5, $6)",
      [accountId, currency, delta, balance, reason, ref]);
    return balance;
  }

  async function newSession(accountId) {
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)",
      [sha256(token), accountId, new Date(Date.now() + SESSION_DAYS * 864e5)]);
    return token;
  }

  const today = () => new Date().toISOString().slice(0, 10);

  const api = {
    packs: PACKS,
    unit: UNIT,
    onChange: () => {},

    async register(username, password) {
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username || "")) throw playerError("Pick a username of 3 to 20 letters, numbers or _.");
      if (typeof password !== "string" || password.length < 8 || password.length > 200) throw playerError("Use a password of at least 8 characters.");
      const passHash = await hashPassword(password);
      const id = await tx(async client => {
        const r = await unique(client.query(
          "INSERT INTO accounts (username, pass_hash) VALUES ($1, $2) RETURNING id",
          [username.toLowerCase(), passHash]), "That username is taken.");
        const accountId = r.rows[0].id;
        for (const c of CURRENCIES) await move(client, accountId, c, WELCOME[c], "welcome");
        return accountId;
      });
      return { token: await newSession(id), account: await api.account(id) };
    },

    async login(username, password) {
      const r = await pool.query("SELECT id, pass_hash FROM accounts WHERE username = $1", [String(username || "").toLowerCase()]);
      const ok = r.rows.length && typeof password === "string" && await passwordMatches(password, r.rows[0].pass_hash);
      if (!ok) throw playerError("Wrong username or password.");
      return { token: await newSession(r.rows[0].id), account: await api.account(r.rows[0].id) };
    },

    /* The account id for a session token, or null */
    async resume(token) {
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
      const r = await pool.query("SELECT account_id FROM sessions WHERE token_hash = $1 AND expires_at > now()", [sha256(token)]);
      return r.rows.length ? r.rows[0].account_id : null;
    },

    async logout(token) {
      if (typeof token === "string") await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
    },

    async account(id) {
      const r = await pool.query("SELECT id, username, gc, sc, last_daily FROM accounts WHERE id = $1", [id]);
      if (!r.rows.length) return null;
      const a = r.rows[0];
      const bought = (await pool.query("SELECT COUNT(*) AS n FROM purchases WHERE account_id = $1", [id])).rows[0];
      const last = a.last_daily && (a.last_daily instanceof Date ? a.last_daily.toISOString() : String(a.last_daily)).slice(0, 10);
      return { id: a.id, username: a.username, GC: Number(a.gc), SC: Number(a.sc), dailyReady: last !== today(), firstPurchase: Number(bought.n) === 0 };
    },

    /* Free coins once per UTC day: the no-purchase way to get Sweeps Coins */
    async claimDaily(id) {
      await tx(async client => {
        const r = await client.query(
          "UPDATE accounts SET last_daily = $1 WHERE id = $2 AND (last_daily IS NULL OR last_daily < $1) RETURNING id",
          [today(), id]);
        if (!r.rows.length) throw playerError("You've had today's free coins. Come back tomorrow.");
        for (const c of CURRENCIES) await move(client, id, c, DAILY[c], "daily");
      });
      onChange(id);
      return DAILY;
    },

    /* Credits a Gold Coin pack once its SOL payment is confirmed. A signature only ever buys one pack. */
    async creditPack(id, packId, signature) {
      const pack = PACKS[packId];
      if (!pack) throw playerError("There is no such pack.");
      await tx(async client => {
        // Locking the account makes two payments at once count as a first purchase only once
        await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [id]);
        const first = Number((await client.query("SELECT COUNT(*) AS n FROM purchases WHERE account_id = $1", [id])).rows[0].n) === 0;
        if (pack.firstOnly && !first) throw playerError("The welcome offer is for your first purchase only.");
        await unique(client.query(
          "INSERT INTO purchases (signature, account_id, pack) VALUES ($1, $2, $3)",
          [signature, id, packId]), "That payment has already been used.");
        await move(client, id, "GC", pack.gc * UNIT.GC, "purchase", signature);
        await move(client, id, "SC", pack.sc * UNIT.SC, "purchase-bonus", signature);
      });
      onChange(id);
      return pack;
    },

    /* Whether this account may still buy a pack (the welcome offer only before any other purchase) */
    async mayBuy(id, packId) {
      const pack = PACKS[packId];
      if (!pack) return false;
      if (!pack.firstOnly) return true;
      return Number((await pool.query("SELECT COUNT(*) AS n FROM purchases WHERE account_id = $1", [id])).rows[0].n) === 0;
    },

    /* The account's packs, newest first */
    async purchases(id) {
      const r = await pool.query("SELECT pack, signature, created_at FROM purchases WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50", [id]);
      return r.rows.map(p => ({ pack: p.pack, name: PACKS[p.pack] ? PACKS[p.pack].name : p.pack, signature: p.signature, at: new Date(p.created_at).toISOString() }));
    },

    /* Takes a stake. Returns false when the balance is too low. */
    async take(id, currency, amount, ref) {
      const balance = await tx(client => move(client, id, currency, -amount, "stake", ref));
      if (balance === null) return false;
      onChange(id);
      return true;
    },

    /* The game's bank for one coin: the same pay() the SOL escrow has, paying into accounts. No network
       fee; Sweeps Coin pots keep the house cut (rake), which is the operator's margin on the prizes. */
    bank(currency) {
      return {
        fee: 0,
        rake: currency === "SC" ? SC_RAKE : 0,
        currency,
        async pay(transfers) {
          const ref = "match-" + crypto.randomBytes(6).toString("hex");
          await tx(async client => {
            for (const t of transfers) await move(client, t.to, currency, t.amount, t.reason || "win", ref);
          });
          transfers.forEach(t => onChange(t.to));
          return ref;
        },
        idle: () => Promise.resolve()
      };
    }
  };
  return api;
}

module.exports = { createCoins, PACKS, WELCOME, DAILY, UNIT, SC_RAKE };
