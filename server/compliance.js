/* Where a player is, and whether a wallet is on a sanctions list.

   Country: Render sits behind Cloudflare, which tells us the visitor's country in the cf-ipcountry header
   (only trusted with TRUST_PROXY set, as for the address). BLOCKED_COUNTRIES lists ISO codes that may not
   buy coins, play for Sweeps Coins or cash out. The default is the countries under comprehensive US
   sanctions; a lawyer's list of excluded places goes here. "T1" is Cloudflare's code for Tor.

   Wallets: data/sanctioned-wallets.txt holds wallet addresses from the US Treasury's sanctions list
   (OFAC SDN), refreshed with scripts/update-sanctions.js. */
const fs = require("fs");
const path = require("path");

const DEFAULT_BLOCKED = "CU,IR,KP,SY";
const LIST_FILE = path.join(__dirname, "..", "data", "sanctioned-wallets.txt");

/* The visitor's two-letter country, or null when unknown (not behind the proxy, or no header) */
function countryOf(req) {
  if (!process.env.TRUST_PROXY) return null;
  const c = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  return /^[A-Z][A-Z0-9]$/.test(c) && c !== "XX" ? c : null;
}

function blockedCountries() {
  return new Set((process.env.BLOCKED_COUNTRIES || DEFAULT_BLOCKED).split(",").map(c => c.trim().toUpperCase()).filter(Boolean).concat("T1"));
}

/* Whether this country may buy, play for prizes or cash out. Cash-outs also refuse an unknown country
   when the proxy should have told us one: we must know where a prize is going. */
function regionAllowed(country, { cashOut = false } = {}) {
  if (country && blockedCountries().has(country)) return false;
  if (cashOut && !country && process.env.TRUST_PROXY) return false;
  return true;
}

let listed = null, listedAt = 0;
function sanctionedWallets() {
  // Re-read at most once a minute, so a refreshed file is picked up without a restart
  if (listed && Date.now() - listedAt < 60000) return listed;
  listedAt = Date.now();
  try {
    listed = new Set(fs.readFileSync(LIST_FILE, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")));
  } catch { listed = listed || new Set(); }
  return listed;
}
const isSanctioned = wallet => Boolean(wallet) && sanctionedWallets().has(wallet);

module.exports = { countryOf, regionAllowed, isSanctioned, LIST_FILE };
