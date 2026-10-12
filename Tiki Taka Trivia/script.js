/* ---------- Question bank ---------- */
/* Tiered pools, in order of difficulty. Each match draws one question per tier,
   so the round always climbs Easy -> Medium -> Hard. `correct` indexes into `a`. */
const TIERS = [
  { name: "Easy", cls: "easy", questions: [      // broad, well-known football knowledge
    { q: "Which country won the 2022 FIFA World Cup?",
      a: ["France", "Argentina", "Brazil", "Croatia"], correct: 1 },
    { q: "Which superstar is nicknamed 'CR7'?",
      a: ["Cristiano Ronaldo", "Ronaldinho", "Cesc Fabregas", "Carlos Tevez"], correct: 0 },
    { q: "Which club plays its home games at Old Trafford?",
      a: ["Liverpool", "Manchester City", "Manchester United", "Everton"], correct: 2 },
    { q: "Which nation has won the most men's World Cups?",
      a: ["Germany", "Brazil", "Italy", "Argentina"], correct: 1 }
  ]},
  { name: "Medium", cls: "medium", questions: [  // histories, transfers, tournament milestones
    { q: "Which club did Neymar leave to join PSG in his 2017 world-record move?",
      a: ["Santos", "Real Madrid", "Barcelona", "Bayern Munich"], correct: 2 },
    { q: "Cristiano Ronaldo moved from Manchester United to which club in 2009?",
      a: ["Juventus", "Real Madrid", "Barcelona", "Sporting CP"], correct: 1 },
    { q: "Which club went the whole 2003-04 Premier League season unbeaten?",
      a: ["Chelsea", "Manchester United", "Arsenal", "Liverpool"], correct: 2 },
    { q: "Which nation won the delayed Euro 2020 tournament, played in 2021?",
      a: ["England", "Spain", "Italy", "Portugal"], correct: 2 }
  ]},
  { name: "Hard", cls: "hard", questions: [      // deep-cut records and statistics
    { q: "Who is the all-time top scorer in Champions League history?",
      a: ["Lionel Messi", "Robert Lewandowski", "Cristiano Ronaldo", "Karim Benzema"], correct: 2 },
    { q: "Which manager has won the most Champions League titles?",
      a: ["Pep Guardiola", "Carlo Ancelotti", "Alex Ferguson", "Bob Paisley"], correct: 1 },
    { q: "Who scored a record 13 goals at a single World Cup, in 1958?",
      a: ["Just Fontaine", "Gerd Muller", "Pele", "Ronaldo Nazario"], correct: 0 },
    { q: "How many goals did Cristiano Ronaldo score in the 2013-14 Champions League, a single-season record?",
      a: ["14", "15", "17", "19"], correct: 2 }
  ]}
];
const SECONDS_PER_Q = 10;

/* Fisher-Yates shuffle (returns a new array) */
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* Build a fresh round: one random question per tier, answers shuffled */
function buildRound() {
  return TIERS.map(tier => {
    const pick = tier.questions[Math.floor(Math.random() * tier.questions.length)];
    const answers = shuffle(pick.a.map((text, i) => ({ text, ok: i === pick.correct })));
    return { q: pick.q, a: answers.map(x => x.text), correct: answers.findIndex(x => x.ok), tier };
  });
}

/* ---------- App state ---------- */
const state = { wallet: null, currency: "SOL", stake: 0, index: 0, me: 0, rival: 0, timer: null, locked: false };
const $ = id => document.getElementById(id);

let currentScreen = "lobby", screenBeforeTerms = "lobby";

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
  currentScreen = id;
  // Footer links are hidden mid-match so nobody can pause the timer by opening the terms
  $("siteFooter").style.display = id === "arena" ? "none" : "";
  window.scrollTo(0, 0);
}

/* Terms page: open from any link, Back returns to where the player was */
document.querySelectorAll("[data-open-terms]").forEach(a => a.onclick = e => {
  e.preventDefault();
  if (currentScreen === "arena") return;
  if (currentScreen !== "terms") screenBeforeTerms = currentScreen;
  show("terms");
});
$("termsBack").onclick = () => show(screenBeforeTerms);
const fmt = n => (Math.round(n * 100) / 100).toString();
const fakeHash = () => Array.from({ length: 44 }, () => "0123456789abcdefghijkmnopqrstuvwxyz"[Math.floor(Math.random() * 35)]).join("");

/* ---------- Wallet (simulated) ---------- */
$("walletBtn").onclick = () => {
  if (state.wallet) return;
  const btn = $("walletBtn");
  btn.textContent = "Connecting…";
  setTimeout(() => {
    const addr = fakeHash();
    state.wallet = addr.slice(0, 4) + "…" + addr.slice(-4);
    btn.textContent = state.wallet;
    btn.classList.add("connected");
    setMsg("Wallet connected. Enter a stake to start.", true);
  }, 700);
};

/* ---------- Lobby ---------- */
document.querySelectorAll(".seg button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".seg button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  state.currency = b.dataset.cur;
});

function setMsg(text, ok) { const m = $("lobbyMsg"); m.textContent = text; m.className = "msg" + (ok ? " ok" : ""); }

$("lockBtn").onclick = () => {
  const stake = parseFloat($("stake").value);
  if (!state.wallet) return setMsg("Connect your Phantom wallet first.");
  if (!(stake > 0)) return setMsg("Enter a stake greater than 0.");
  if (!$("agree").checked) return setMsg("Confirm you are 18+ and accept the terms to continue.");
  $("lockBtn").disabled = true;
  setMsg("Signing transaction and locking stake in escrow…", true);
  setTimeout(() => {          // mock on-chain confirmation delay
    state.stake = stake;
    $("lockBtn").disabled = false;
    startMatch();
  }, 1200);
};

/* ---------- Game arena ---------- */
function startMatch() {
  Object.assign(state, { index: 0, me: 0, rival: 0, round: buildRound() });
  $("pot").textContent = fmt(state.stake * 2);       // your stake + matched rival stake
  $("potCur").textContent = state.currency;
  show("arena");
  renderQuestion();
}

function renderQuestion() {
  const item = state.round[state.index];
  state.locked = false;
  $("counter").textContent = `Question ${state.index + 1} of ${state.round.length}`;
  // Difficulty badge: swap colour class, label and number of filled pips
  $("badge").className = "badge " + item.tier.cls;
  $("badgeText").textContent = item.tier.name;
  [...$("pips").children].forEach((p, i) => p.classList.toggle("on", i <= state.index));
  $("liveScore").innerHTML = `You ${state.me}<br>Rival ${state.rival}`;
  $("question").textContent = item.q;
  const box = $("answers");
  box.innerHTML = "";
  item.a.forEach((text, i) => {
    const b = document.createElement("button");
    b.className = "ans"; b.textContent = text;
    b.onclick = () => answer(i);
    box.appendChild(b);
  });
  runTimer();
}

/* Countdown bar; running out of time counts as a miss */
function runTimer() {
  clearInterval(state.timer);
  const bar = $("timerBar"), start = Date.now();
  state.timer = setInterval(() => {
    const left = 1 - (Date.now() - start) / (SECONDS_PER_Q * 1000);
    bar.style.transform = `scaleX(${Math.max(left, 0)})`;
    if (left <= 0) answer(-1);
  }, 50);
}

function answer(choice) {
  if (state.locked) return;
  state.locked = true;
  clearInterval(state.timer);
  const item = state.round[state.index];
  const buttons = [...document.querySelectorAll(".ans")];
  buttons.forEach(b => b.disabled = true);
  buttons[item.correct].classList.add("right");
  if (choice === item.correct) state.me++;
  else if (choice >= 0) buttons[choice].classList.add("wrong");
  if (Math.random() < 0.6) state.rival++;            // mock rival gets ~60% right
  $("liveScore").innerHTML = `You ${state.me}<br>Rival ${state.rival}`;
  setTimeout(() => {
    state.index++;
    state.index < state.round.length ? renderQuestion() : showResults();
  }, 1200);
}

/* ---------- Results ---------- */
function showResults() {
  const { me, rival, stake, currency } = state;
  const pot = stake * 2, title = $("resTitle"), cur = currency;
  $("resSub").textContent = `Final score: You ${me} – ${rival} Rival`;
  title.className = "final";
  let text, ledger = `escrow.tx  ${fakeHash()}\n<br>`;

  if (me > rival) {
    title.textContent = "You win";
    text = `Smart contract verified your score and released ${fmt(pot)} ${cur} to your wallet.`;
    ledger += `release(winner=<em>${state.wallet}</em>, amount=<em>${fmt(pot)} ${cur}</em>)<br>status: <em>confirmed</em>`;
  } else if (me === rival) {
    title.textContent = "Draw"; title.classList.add("draw");
    text = `Scores level. The contract refunded your ${fmt(stake)} ${cur} stake.`;
    ledger += `refund(to=<em>${state.wallet}</em>, amount=<em>${fmt(stake)} ${cur}</em>)<br>status: <em>confirmed</em>`;
  } else {
    title.textContent = "You lose"; title.classList.add("lose");
    text = `Your rival took the pot. ${fmt(pot)} ${cur} was released to their wallet.`;
    ledger += `release(winner=rival, amount=${fmt(pot)} ${cur})<br>status: confirmed`;
  }
  $("resText").textContent = text;
  $("ledger").innerHTML = ledger;
  show("results");
}

$("againBtn").onclick = () => { setMsg(""); show("lobby"); };
