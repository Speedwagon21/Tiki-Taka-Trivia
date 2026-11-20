# Tiki-Taka Trivia

Live football trivia with two ways to play. Every match is three questions that climb from Easy to Hard. Right answers score 500 points plus up to 500 more for speed, and the top score takes the pot.

> **Prototype:** wallets connect on Solana **devnet** and the escrow is simulated. No real funds move.

## Modes

- **Group.** One person creates a room, sets the stake and shares the 5-character code or invite link (`/?room=MN695`) with up to 7 others. The creator starts the match. The top score takes the whole pot, a shared top score splits it, and if everyone is level everyone is refunded. The host can start rematches, and new players can join between matches.
- **Head to Head.** One on one, two ways in:
  - **Find an opponent:** you're paired automatically with someone who picked the same stake and currency. Your stake only locks once a match is found.
  - **Challenge a friend:** you get a code and link for a 1v1 room. The match starts the moment your friend accepts.

  A rematch needs both players to agree. "New opponent" puts you straight back into matchmaking at the same stake.

## Features

- **Server-authoritative game.** The server owns the questions, the clock and the scores, so answers never reach the browser before the reveal.
- **48-question bank**, 16 per tier. Questions you've seen recently are avoided.
- **Phantom wallet** on devnet, with balance display. If Phantom isn't installed there's a demo wallet, and on phones a link to open the page in the Phantom app.
- **Reconnects.** Refresh mid-match and you keep your seat. A player who drops for more than 30 seconds is removed, and in Group mode the host role moves to someone else if the host leaves.
- Sounds (with a mute switch), animations that respect reduced-motion, keyboard answers (1–4), screen-reader announcements and a phone-first layout.

## Accounts, Gold Coins and Sweeps Coins (optional)

Set `DATABASE_URL` to a Postgres database to switch on accounts and coin games. Without it there are no accounts and the GC and SC options are hidden.

- **Gold Coins (GC)** are bought in the coin store: packs from $4.99 to $49.99, plus a one-time $1.99 welcome offer for an account's first purchase. Prices are in dollars and charged in SOL through the escrow at the `SOL_USD` rate (default 35), so the store needs `ESCROW_SECRET` too. They are played for fun and never cash out. Pack sizes and prices are in `PACKS` in `server/coins.js`.
- **The house cut:** the house keeps 10% of every Sweeps Coin pot a player wins (`SC_RAKE`); a draw is refunded in full.
- **Units:** Sweeps Coins are stored in cents (1 SC = 100), so free amounts like 0.30 a day work. An older database with whole coins is converted once at start-up.
- **Sweeps Coins (SC)** are never sold. Players get them free (1 on sign-up, 0.30 a day, and a bonus with each Gold Coin pack) and win them from each other in SC rooms. Redemption for prizes is not built yet.
- Every balance change is a row in the `ledger` table, written in the same transaction as the balance.

Tests run on an in-memory Postgres. To run the coin tests on a real one: `TEST_DATABASE_URL=postgres://... node --test --test-concurrency=1 test/coins.test.js` (it drops the coin tables first).

## Gold Coin items

Gold Coins buy things everyone in a room sees. None of them help anyone win.

- **Player cards.** Everyone has a card (Bronze until they buy a design) showing a 45-99 rating and their accuracy, speed, win rate and matches played.
  - The rating comes from the player's real record. Every finished match adds to it, and it is smoothed so one lucky match doesn't make a 99.
  - Cards show in the room list (mini), in the account panel, and big for the winner on the results screen.
- **Celebrations.** When someone wins, their celebration takes over everyone's screen, with crowd noise. There are five: Confetti cannon, Fireworks, Trophy lift, Net buster and Golden rain.
- **Name styles.** Colours, plus animated On fire and Gold shimmer.
- **Rarity and limited items.** Each item is Common, Rare, Epic or Legendary. An item with `until` leaves the shop after that date; whoever bought it keeps it.

The catalogue is in `server/items.js`. A new card design also needs a `.d-<value>` style in `public/play/style.css`, and a new celebration needs a case in `celebrate()` in `public/play/script.js`. Each purchase is a ledger row (reason `item`), and owned items are in `owned_items`.

## Cashing out Sweeps Coins (off until legally cleared)

Built but switched off. Set `REDEMPTION=1` only once a lawyer has cleared cash-outs for the places you serve.

- 1 SC is meant to be worth $1, paid in USDC to a Solana wallet. The minimum is 50 SC (`REDEEM_MIN`).
- Free Sweeps Coins (sign-up, daily, pack bonus) must be staked in a match that ends with a winner before they can be cashed out. Winnings can be cashed out at once.
- A player must be marked verified (identity and age checked) before their first cash-out.
- Requests take the coins off the balance and wait for a person. Review them with `DATABASE_URL=... node scripts/redemptions.js list`, then `paid <id> <transaction>` after sending the USDC, or `reject <id> <reason>` to return the coins. `verify <username>` marks an identity as checked.

## Player protection and compliance

- **Terms and privacy.** Sign-up needs an 18+ and terms checkbox. Each acceptance is stored in `consents` with its version and time. To change the terms, edit them, then bump `TERMS_VERSION` in `server/coins.js`. Every player then has to accept again in their account before they can play or buy. The privacy notice is at `/play/#privacy`.
- **Your data.** From the account panel, a player can download everything held about them as JSON, or close their account with their password. Closing removes the username, password and sessions. Coin, purchase and cash-out records stay, without the name. Closing waits while a cash-out is pending.
- **Play safely.**
  - A monthly spending limit on coin packs. Lowering it applies at once; raising or removing it waits 24 hours.
  - Breaks of 24 hours, 7 days or 30 days, and self-exclusion for 6 months, 1 year or permanently. None of these can be shortened.
  - A paused account can't play, claim free coins or buy.
- **Blocked places.** Behind Cloudflare (`TRUST_PROXY=1`), the `cf-ipcountry` header gives the player's country. `BLOCKED_COUNTRIES` (ISO codes, comma-separated; default `CU,IR,KP,SY`) can't buy packs, play for Sweeps Coins or cash out. Tor is always blocked. A cash-out from an unknown country is refused.
- **Sanctioned wallets.** `data/sanctioned-wallets.txt` holds the US Treasury OFAC list of wallet addresses. Cash-outs to a listed wallet and payments from one are refused and logged. To refresh the list, run `node scripts/update-sanctions.js`, then commit and redeploy.

## Real stakes on devnet (optional)

By default every stake is simulated. Set `ESCROW_SECRET` to switch SOL rooms to real transfers of test SOL on Solana devnet:

- `ESCROW_SECRET`: the escrow wallet's secret key as a JSON array of numbers. Keep it in the host's secret settings, never in the repo.
- `SOLANA_RPC` (optional): the RPC address. Defaults to `https://api.devnet.solana.com`.

With it set, a player pays the stake from Phantom before taking a seat, the server confirms the payment on-chain, and the pot is paid to the winner when the match ends. Leaving a waiting room, cancelling a search or a room closing refunds the stake, less the network fee. Each rematch needs a new stake. USDC rooms stay simulated.

The escrow wallet needs a small float of SOL (about 0.01) so it never drops below Solana's minimum account balance. Deposits are tracked in memory only: if the process is killed without a clean shutdown, stakes it was holding stay in the escrow wallet. Do not point this at mainnet.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # game rules plus multiplayer over real WebSockets
```

To try it alone, open two browser windows (or one normal and one private). Create a room in one and join with the code in the other, or press "Find an opponent" at the same stake in both.

## Layout

```
server/index.js      HTTP static server + WebSocket endpoint at /ws
server/game.js       rooms, matchmaking, rounds, scoring, payouts
server/escrow.js     on-chain stake payments, payouts and refunds
server/coins.js      accounts, Gold and Sweeps Coin balances, the ledger, packs, cash-outs
scripts/redemptions.js  reviewing cash-outs and marking identities checked
server/questions.js  question bank (server-only)
public/index.html    the landing page (built with the design-taste-frontend skill)
public/play/         the game itself (index.html, script.js, style.css), at /play/
public/assets/       the landing page's design kit (MIT, see LICENSE-tasteskill.txt), photos and game captures
test/                node:test suites
render.yaml          one-click deploy on Render
```

## Deploy

Any Node 20+ host that supports WebSockets works. On Render, create a Blueprint from this repo, which uses `render.yaml`, or a Web Service with build command `npm ci` and start command `npm start`. Rooms and the matchmaking queue live in memory, so run a single instance.
