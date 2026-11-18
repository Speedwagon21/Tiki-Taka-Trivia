#!/usr/bin/env node
/* Reviews Sweeps Coin cash-outs by hand. Needs DATABASE_URL.

     node scripts/redemptions.js list                     pending cash-outs
     node scripts/redemptions.js paid <id> <transaction>   after sending the USDC yourself
     node scripts/redemptions.js reject <id> <reason>      the coins go back to the player
     node scripts/redemptions.js verify <username>         after checking the player's identity and age
     node scripts/redemptions.js unverify <username>

   shortcut: payouts are sent by hand and identities checked by hand; switch to an identity provider
   and automatic USDC payouts once volumes justify it */
const { Pool } = require("pg");
const { createCoins } = require("../server/coins");

(async () => {
  const [cmd, a, ...rest] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL first.");
  const pool = new Pool({ connectionString: url, ssl: /render\.com/.test(url) ? { rejectUnauthorized: false } : undefined });
  const coins = await createCoins(pool);
  if (cmd === "list") {
    const r = await pool.query(`SELECT r.id, a.username, a.verified, r.amount, r.wallet, r.created_at
      FROM redemptions r JOIN accounts a ON a.id = r.account_id WHERE r.status = 'pending' ORDER BY r.id`);
    if (!r.rows.length) console.log("No pending cash-outs.");
    for (const x of r.rows) console.log(`#${x.id}  ${x.username}${x.verified ? "" : " (NOT VERIFIED)"}  ${(Number(x.amount) / 100).toFixed(2)} SC  to ${x.wallet}  asked ${x.created_at.toISOString()}`);
  } else if (cmd === "paid" || cmd === "reject") {
    if (!a || !rest.length) throw new Error(`Usage: ${cmd} <id> <${cmd === "paid" ? "transaction" : "reason"}>`);
    await coins.resolveRedemption(Number(a), cmd === "paid" ? "paid" : "rejected", rest.join(" "));
    console.log(`#${a} marked ${cmd === "paid" ? "paid" : "rejected (coins returned)"}.`);
  } else if (cmd === "verify" || cmd === "unverify") {
    if (!a) throw new Error(`Usage: ${cmd} <username>`);
    await coins.setVerified(a, cmd === "verify");
    console.log(`${a} is now ${cmd === "verify" ? "verified" : "not verified"}.`);
  } else {
    console.log("Commands: list | paid <id> <transaction> | reject <id> <reason> | verify <username> | unverify <username>");
  }
  await pool.end();
})().catch(err => { console.error(err.message); process.exit(1); });
