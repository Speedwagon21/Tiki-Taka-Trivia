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
server/questions.js  question bank (server-only)
public/              the front end (index.html, script.js, style.css)
test/                node:test suites
render.yaml          one-click deploy on Render
```

## Deploy

Any Node 20+ host that supports WebSockets works. On Render, create a Blueprint from this repo, which uses `render.yaml`, or a Web Service with build command `npm ci` and start command `npm start`. Rooms and the matchmaking queue live in memory, so run a single instance.
