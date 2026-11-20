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
const REDEEM_MIN = 5000;                        // in units: 50 SC is the least a player can cash out
/* Free Sweeps Coins (sign-up, daily, pack bonus) must be staked in a finished match once before they can be
   cashed out; this tracks how much of a balance is still waiting for that. */
const FREE_REASONS = ["welcome", "daily", "purchase-bonus"];
/* The terms and privacy notice a player accepts. Change it whenever either page changes: every player is
   then asked to accept again before they can play for coins, buy or cash out. */
const TERMS_VERSION = "2026-11-20";
const LIMIT_RAISE_DELAY_MS = 24 * 3600 * 1000;   // raising or removing a spending limit waits a day; lowering is at once
const PAUSES = {                                 // breaks and self-exclusion; none can be shortened once set
  "break-1": { kind: "break", days: 1 }, "break-7": { kind: "break", days: 7 }, "break-30": { kind: "break", days: 30 },
  "exclude-182": { kind: "exclusion", days: 182 }, "exclude-365": { kind: "exclusion", days: 365 },
  "exclude-forever": { kind: "exclusion", days: 365 * 100 }
};
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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sc_locked BIGINT NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pause_kind TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS spend_limit BIGINT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS spend_limit_next BIGINT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS spend_limit_next_at TIMESTAMPTZ;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS usd_cents BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS consents (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  wallet TEXT NOT NULL,
  country TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS country TEXT;`;

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
  // Coins held before play-through existed count as free coins not yet played
  await tx(async client => {
    const done = await client.query("SELECT value FROM meta WHERE key = 'playthrough'");
    if (done.rows.length) return;
    await client.query("UPDATE accounts SET sc_locked = sc");
    await client.query("INSERT INTO meta (key, value) VALUES ('playthrough', 'on')");
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
    if (currency === "SC" && FREE_REASONS.includes(reason)) {
      await client.query("UPDATE accounts SET sc_locked = sc_locked + $1 WHERE id = $2", [delta, accountId]);
    }
    return balance;
  }

  async function newSession(accountId) {
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)",
      [sha256(token), accountId, new Date(Date.now() + SESSION_DAYS * 864e5)]);
    return token;
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
  const ms = v => (v ? new Date(v).getTime() : 0);

  /* The spending limit in force now (cents a month, or null for none): a raise or removal applies once its day has passed */
  const limitNow = a => (a.spend_limit_next_at && ms(a.spend_limit_next_at) <= Date.now() ? a.spend_limit_next : a.spend_limit);

  /* Why this account can't play for coins, claim free coins or buy right now, or null */
  async function blockReason(id) {
    const a = (await pool.query("SELECT deleted_at, paused_until, pause_kind FROM accounts WHERE id = $1", [id])).rows[0];
    if (!a || a.deleted_at) return "This account is closed.";
    if (ms(a.paused_until) > Date.now()) {
      const until = new Date(a.paused_until).toISOString().slice(0, 10);
      return a.pause_kind === "exclusion" ? `You've excluded yourself until ${until}.` : `You're taking a break until ${until}.`;
    }
    const c = await pool.query("SELECT id FROM consents WHERE account_id = $1 AND kind = 'terms' AND version = $2", [id, TERMS_VERSION]);
    if (!c.rows.length) return "Accept the updated terms and privacy notice first (in your account).";
    return null;
  }

  const api = {
    packs: PACKS,
    unit: UNIT,
    onChange: () => {},

    termsVersion: TERMS_VERSION,
    pauses: PAUSES,
    blockReason,

    async register(username, password, acceptedTerms) {
      if (acceptedTerms !== true) throw playerError("Confirm you are 18 or older and accept the terms and privacy notice.");
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username || "")) throw playerError("Pick a username of 3 to 20 letters, numbers or _.");
      if (typeof password !== "string" || password.length < 8 || password.length > 200) throw playerError("Use a password of at least 8 characters.");
      const passHash = await hashPassword(password);
      const id = await tx(async client => {
        const r = await unique(client.query(
          "INSERT INTO accounts (username, pass_hash) VALUES ($1, $2) RETURNING id",
          [username.toLowerCase(), passHash]), "That username is taken.");
        const accountId = r.rows[0].id;
        await client.query("INSERT INTO consents (account_id, kind, version) VALUES ($1, 'terms', $2)", [accountId, TERMS_VERSION]);
        for (const c of CURRENCIES) await move(client, accountId, c, WELCOME[c], "welcome");
        return accountId;
      });
      return { token: await newSession(id), account: await api.account(id) };
    },

    async login(username, password) {
      const r = await pool.query("SELECT id, pass_hash FROM accounts WHERE username = $1 AND deleted_at IS NULL", [String(username || "").toLowerCase()]);
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
      const r = await pool.query(`SELECT id, username, gc, sc, sc_locked, verified, last_daily, paused_until, pause_kind,
        spend_limit, spend_limit_next, spend_limit_next_at FROM accounts WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!r.rows.length) return null;
      const a = r.rows[0];
      const bought = (await pool.query("SELECT COUNT(*) AS n FROM purchases WHERE account_id = $1", [id])).rows[0];
      const last = a.last_daily && (a.last_daily instanceof Date ? a.last_daily.toISOString() : String(a.last_daily)).slice(0, 10);
      return {
        id: a.id, username: a.username, GC: Number(a.gc), SC: Number(a.sc), dailyReady: last !== today(), firstPurchase: Number(bought.n) === 0,
        redeemable: Math.max(0, Number(a.sc) - Number(a.sc_locked)), verified: Boolean(a.verified),
        termsCurrent: (await pool.query("SELECT id FROM consents WHERE account_id = $1 AND kind = 'terms' AND version = $2", [id, TERMS_VERSION])).rows.length > 0,
        pausedUntil: ms(a.paused_until) > Date.now() ? new Date(a.paused_until).toISOString() : null, pauseKind: a.pause_kind,
        spendLimit: limitNow(a) == null ? null : Number(limitNow(a)),
        pendingLimit: a.spend_limit_next_at && ms(a.spend_limit_next_at) > Date.now()
          ? { cents: a.spend_limit_next == null ? null : Number(a.spend_limit_next), at: new Date(a.spend_limit_next_at).toISOString() } : null,
        spentThisMonth: Number((await pool.query("SELECT COALESCE(SUM(usd_cents), 0) AS s FROM purchases WHERE account_id = $1 AND created_at >= $2", [id, monthStart()])).rows[0].s)
      };
    },

    async acceptTerms(id) {
      await pool.query("INSERT INTO consents (account_id, kind, version) VALUES ($1, 'terms', $2)", [id, TERMS_VERSION]);
      onChange(id);
    },

    /* A monthly spending limit in US cents, or null for none. Lowering takes effect now; raising or removing in a day. */
    async setSpendLimit(id, cents) {
      if (cents !== null && !(Number.isInteger(cents) && cents >= 0 && cents <= 10000000)) throw playerError("Enter a monthly limit in dollars.");
      await tx(async client => {
        const a = (await client.query("SELECT spend_limit, spend_limit_next, spend_limit_next_at FROM accounts WHERE id = $1 FOR UPDATE", [id])).rows[0];
        const now = limitNow(a);
        const lower = cents !== null && (now == null || cents <= Number(now));
        if (lower) await client.query("UPDATE accounts SET spend_limit = $1, spend_limit_next = NULL, spend_limit_next_at = NULL WHERE id = $2", [cents, id]);
        else await client.query("UPDATE accounts SET spend_limit = $1, spend_limit_next = $2, spend_limit_next_at = $3 WHERE id = $4",
          [now, cents, new Date(Date.now() + LIMIT_RAISE_DELAY_MS), id]);
      });
      onChange(id);
    },

    /* A break or self-exclusion. It can be made longer, never shorter. */
    async pause(id, choice) {
      const p = PAUSES[choice];
      if (!p) throw playerError("Pick how long to stop for.");
      const until = new Date(Date.now() + p.days * 864e5);
      await tx(async client => {
        const a = (await client.query("SELECT paused_until FROM accounts WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (ms(a.paused_until) >= until.getTime()) return;
        await client.query("UPDATE accounts SET paused_until = $1, pause_kind = $2 WHERE id = $3", [until, p.kind, id]);
      });
      onChange(id);
    },

    /* Why a pack can't be bought now (paused, terms, the welcome offer, the spending limit), or null */
    async checkPurchase(id, packId) {
      const pack = PACKS[packId];
      if (!pack) return "There is no such pack.";
      const block = await blockReason(id);
      if (block) return block;
      if (!(await api.mayBuy(id, packId))) return "The welcome offer is for your first purchase only.";
      const a = await api.account(id);
      const cents = Math.round(pack.usd * 100);
      if (a.spendLimit != null && a.spentThisMonth + cents > a.spendLimit) {
        return `That would pass your monthly spending limit of $${(a.spendLimit / 100).toFixed(2)} ($${(a.spentThisMonth / 100).toFixed(2)} spent this month).`;
      }
      return null;
    },

    /* Everything held about the account, for the player to download */
    async exportData(id) {
      const q = async (sql) => (await pool.query(sql, [id])).rows;
      const [account] = await q("SELECT id, username, gc, sc, sc_locked, verified, last_daily, paused_until, pause_kind, spend_limit, spend_limit_next, spend_limit_next_at, created_at FROM accounts WHERE id = $1");
      return {
        exportedAt: new Date().toISOString(),
        note: "Sweeps Coin amounts are in cents (100 = 1 SC).",
        account,
        consents: await q("SELECT kind, version, accepted_at FROM consents WHERE account_id = $1 ORDER BY id"),
        ledger: await q("SELECT currency, delta, balance, reason, ref, created_at FROM ledger WHERE account_id = $1 ORDER BY id"),
        purchases: await q("SELECT pack, signature, usd_cents, created_at FROM purchases WHERE account_id = $1 ORDER BY created_at"),
        cashOuts: await q("SELECT id, amount, wallet, country, status, note, created_at, updated_at FROM redemptions WHERE account_id = $1 ORDER BY id"),
        activeSessions: Number((await q("SELECT COUNT(*) AS n FROM sessions WHERE account_id = $1"))[0].n)
      };
    },

    /* Closes the account: the name and password go, sessions end and balances are given up. Payment, coin and
       consent records are kept, because the law requires them for several years (anti-money-laundering, tax). */
    async deleteAccount(id, password) {
      const a = (await pool.query("SELECT pass_hash FROM accounts WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
      if (!a || typeof password !== "string" || !(await passwordMatches(password, a.pass_hash))) throw playerError("That password isn't right.");
      const pending = await pool.query("SELECT id FROM redemptions WHERE account_id = $1 AND status = 'pending'", [id]);
      if (pending.rows.length) throw playerError("Wait for your cash-out to be paid or returned before closing the account.");
      await tx(async client => {
        const b = (await client.query("SELECT gc, sc FROM accounts WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (Number(b.gc)) await move(client, id, "GC", -Number(b.gc), "account-closed");
        if (Number(b.sc)) await move(client, id, "SC", -Number(b.sc), "account-closed");
        await client.query("UPDATE accounts SET username = $1, pass_hash = '!', sc_locked = 0, verified = false, deleted_at = now() WHERE id = $2", ["deleted-" + id, id]);
        await client.query("DELETE FROM sessions WHERE account_id = $1", [id]);
      });
    },

    /* Players staked these Sweeps Coins in a match that finished with a winner: that counts as playing them through.
       stakes: [{ to: accountId, amount: units }] */
    async played(stakes) {
      for (const s of stakes) {
        await tx(async client => {
          const r = await client.query("SELECT sc_locked FROM accounts WHERE id = $1 FOR UPDATE", [s.to]);
          await client.query("UPDATE accounts SET sc_locked = $1 WHERE id = $2", [Math.max(0, Number(r.rows[0].sc_locked) - s.amount), s.to]);
        });
        onChange(s.to);
      }
    },

    /* Asks to cash out Sweeps Coins. The coins leave the balance now and wait for a person to pay or reject
       the request (scripts/redemptions.js). Amount in units (cents). */
    async requestRedemption(id, amount, wallet, country = null) {
      if (!Number.isInteger(amount) || amount < REDEEM_MIN) throw playerError(`The least you can cash out is ${REDEEM_MIN / UNIT.SC} Sweeps Coins.`);
      const rid = await tx(async client => {
        const r = await client.query("SELECT sc, sc_locked, verified FROM accounts WHERE id = $1 FOR UPDATE", [id]);
        const a = r.rows[0];
        const c = await client.query("SELECT id FROM consents WHERE account_id = $1 AND kind = 'terms' AND version = $2", [id, TERMS_VERSION]);
        if (!c.rows.length) throw playerError("Accept the updated terms and privacy notice first (in your account).");
        if (!a.verified) throw playerError("Verify your identity before cashing out.");
        if (amount > Number(a.sc) - Number(a.sc_locked)) throw playerError("That's more than you can cash out. Free coins must be played in a match first.");
        const ins = await client.query("INSERT INTO redemptions (account_id, amount, wallet, country) VALUES ($1, $2, $3, $4) RETURNING id", [id, amount, wallet, country]);
        await move(client, id, "SC", -amount, "redeem", "redeem-" + ins.rows[0].id);
        return ins.rows[0].id;
      });
      onChange(id);
      return rid;
    },

    async redemptions(id) {
      const r = await pool.query("SELECT id, amount, wallet, status, note, created_at FROM redemptions WHERE account_id = $1 ORDER BY id DESC LIMIT 20", [id]);
      return r.rows.map(x => ({ id: x.id, amount: Number(x.amount), wallet: x.wallet, status: x.status, note: x.note, at: new Date(x.created_at).toISOString() }));
    },

    /* For whoever reviews cash-outs: mark one paid (note: the payout's transaction), or reject it (the coins go back) */
    async resolveRedemption(rid, status, note) {
      if (!["paid", "rejected"].includes(status)) throw new Error("status must be paid or rejected");
      const accountId = await tx(async client => {
        const r = await client.query("SELECT account_id, amount, status FROM redemptions WHERE id = $1 FOR UPDATE", [rid]);
        if (!r.rows.length || r.rows[0].status !== "pending") throw new Error(`redemption ${rid} is not pending`);
        await client.query("UPDATE redemptions SET status = $1, note = $2, updated_at = now() WHERE id = $3", [status, note || null, rid]);
        if (status === "rejected") await move(client, r.rows[0].account_id, "SC", Number(r.rows[0].amount), "redeem-rejected", "redeem-" + rid);
        return r.rows[0].account_id;
      });
      onChange(accountId);
    },

    /* For whoever checks identities: marks an account verified, or not */
    async setVerified(username, verified) {
      const r = await pool.query("UPDATE accounts SET verified = $1 WHERE username = $2 RETURNING id", [verified, String(username).toLowerCase()]);
      if (!r.rows.length) throw new Error(`no account ${username}`);
      onChange(r.rows[0].id);
    },

    /* Free coins once per UTC day: the no-purchase way to get Sweeps Coins */
    async claimDaily(id) {
      const block = await blockReason(id);
      if (block) throw playerError(block);
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
          "INSERT INTO purchases (signature, account_id, pack, usd_cents) VALUES ($1, $2, $3, $4)",
          [signature, id, packId, Math.round(pack.usd * 100)]), "That payment has already been used.");
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
      const block = await blockReason(id);
      if (block) throw playerError(block);
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
        played: currency === "SC" ? stakes => api.played(stakes) : null,
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

module.exports = { createCoins, PACKS, WELCOME, DAILY, UNIT, SC_RAKE, REDEEM_MIN, TERMS_VERSION, PAUSES };
