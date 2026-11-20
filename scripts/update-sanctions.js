#!/usr/bin/env node
/* Refreshes data/sanctioned-wallets.txt from the US Treasury's sanctions list (OFAC SDN).
   The list notes each sanctioned digital-currency address as "Digital Currency Address - <chain> <address>".
   Every address is kept, whatever its chain: the game only ever checks exact matches.

     node scripts/update-sanctions.js            then commit the file and redeploy

   shortcut: OFAC only, refreshed by hand; add the EU and UK lists, or a screening service, once cash-outs open */
const fs = require("fs");
const { LIST_FILE } = require("../server/compliance");

const SOURCE = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";

(async () => {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`OFAC list download failed: ${res.status}`);
  const text = await res.text();
  if (text.length < 100000) throw new Error("The OFAC list looks too short; not replacing the current file.");
  const found = new Map();
  for (const m of text.matchAll(/Digital Currency Address - ([A-Za-z0-9]+)\s+([A-Za-z0-9:]+)/g)) found.set(m[2], m[1]);
  const lines = [...found].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  fs.writeFileSync(LIST_FILE, [
    "# Wallet addresses on the US Treasury OFAC SDN list. One address per line; lines starting with # are notes.",
    `# Source: ${SOURCE}`,
    `# Updated: ${new Date().toISOString()} (${lines.length} addresses) by scripts/update-sanctions.js`,
    ...lines.map(([address, chain]) => `# ${chain}\n${address}`)
  ].join("\n") + "\n");
  console.log(`Wrote ${lines.length} addresses to ${LIST_FILE}.`);
})().catch(err => { console.error(err.message); process.exit(1); });
