# Tiki-Taka Trivia

Live football trivia for 2 to 8 players. Create a room, send the 5-character code (or the invite link) to your friends, and play three questions that climb from Easy to Hard. Right answers score 500 points plus up to 500 more for speed. The top score takes the pot.

> **Prototype:** wallets connect on Solana **devnet** and the escrow is simulated. No real funds move.

## Features

- **Rooms with codes.** The host sets the stake and gets a code like `MN695`, plus a copyable invite link (`/?room=MN695`) and a native share button on phones. Joiners see the host, stake and player count before they lock in.
- **Server-authoritative game.** The server owns the questions, the clock and the scores, so answers never reach the browser before the reveal.
- **Practice mode.** A free match against a bot that plays like a person: quick and accurate on easy questions, slower and shakier on hard ones.
- **48-question bank**, 16 per tier. Questions you have seen recently are avoided.
- **Phantom wallet** on devnet, with balance display. If Phantom isn't installed there's a demo wallet, and on phones a link to open the page in the Phantom app.
- **Reconnects.** Refresh mid-match and you keep your seat. A player who drops for more than 30 seconds is removed, and if the host leaves the host role moves to someone else.
- **Rematches** in the same room. New players can join between matches.
- Sounds (with a mute switch), animations that respect reduced-motion, keyboard answers (1–4), screen-reader announcements and a phone-first layout.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # game rules plus multiplayer over real WebSockets
```

To play with yourself, open two browser windows (or one normal and one private), create a room in one and join with the code in the other.

## Layout

```
server/index.js      HTTP static server + WebSocket endpoint at /ws
server/game.js       rooms, rounds, scoring, payouts, bot
server/questions.js  question bank (server-only)
public/              the front end (index.html, script.js, style.css)
test/                node:test suites
render.yaml          one-click deploy on Render
```

## Deploy

Any Node 20+ host that supports WebSockets works. On Render, create a Blueprint from this repo, which uses `render.yaml`, or a Web Service with build command `npm ci` and start command `npm start`. Rooms live in memory, so run a single instance.
