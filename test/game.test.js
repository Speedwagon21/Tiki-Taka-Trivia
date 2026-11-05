const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRound, scoreAnswer, settle } = require("../server/game");
const { TIERS } = require("../server/questions");

test("question bank is well formed", () => {
  const seen = new Set();
  TIERS.forEach(tier => {
    assert.ok(tier.questions.length >= 12, `${tier.name} needs a deep pool`);
    tier.questions.forEach(item => {
      assert.equal(item.a.length, 4, item.q);
      assert.equal(new Set(item.a).size, 4, `duplicate answers: ${item.q}`);
      assert.ok(item.correct >= 0 && item.correct < 4, item.q);
      assert.ok(!seen.has(item.q), `duplicate question: ${item.q}`);
      seen.add(item.q);
    });
  });
});

test("a round climbs Easy -> Medium -> Hard and keeps the right answer after shuffling", () => {
  for (let n = 0; n < 50; n++) {
    const round = buildRound();
    assert.deepEqual(round.map(r => r.tier.name), ["Easy", "Medium", "Hard"]);
    round.forEach(r => {
      const original = TIERS[r.tier.level].questions.find(q => q.id === r.id);
      assert.equal(r.a[r.correct], original.a[original.correct]);
    });
  }
});

test("a round avoids recently seen questions while fresh ones remain", () => {
  const avoid = new Set(TIERS.flatMap(t => t.questions.slice(1).map(q => q.id)));
  const round = buildRound(avoid);
  round.forEach((r, level) => assert.equal(r.id, TIERS[level].questions[0].id));
  // Once everything has been seen, it falls back to the full pool instead of failing
  const all = new Set(TIERS.flatMap(t => t.questions.map(q => q.id)));
  assert.equal(buildRound(all).length, 3);
});

test("scoring rewards correct and fast answers", () => {
  assert.equal(scoreAnswer(false, 100, 10000), 0);
  assert.equal(scoreAnswer(true, 0, 10000), 1000);
  assert.equal(scoreAnswer(true, 5000, 10000), 750);
  assert.equal(scoreAnswer(true, 10000, 10000), 500);
  assert.equal(scoreAnswer(true, 12000, 10000), 500);
});

const P = (id, score) => ({ id, name: id, score, wallet: null, left: false });

test("settle: the top score takes the whole pot", () => {
  const r = settle([P("a", 1800), P("b", 900), P("c", 0)], 2);
  assert.equal(r.pot, 6);
  assert.equal(r.outcome, "win");
  assert.deepEqual(r.winnerIds, ["a"]);
  assert.deepEqual(r.standings.map(s => [s.id, s.rank, s.payout, s.net]), [["a", 1, 6, 4], ["b", 2, 0, -2], ["c", 3, 0, -2]]);
});

test("settle: a shared top score splits the pot", () => {
  const r = settle([P("a", 1500), P("b", 1500), P("c", 200)], 1);
  assert.equal(r.outcome, "split");
  assert.deepEqual(r.standings.map(s => s.payout), [1.5, 1.5, 0]);
  assert.deepEqual(r.standings.map(s => s.rank), [1, 1, 3]);
});

test("settle: everyone level means everyone is refunded", () => {
  const r = settle([P("a", 0), P("b", 0)], 0.5);
  assert.equal(r.outcome, "refund");
  assert.deepEqual(r.winnerIds, []);
  assert.deepEqual(r.standings.map(s => [s.payout, s.net]), [[0.5, 0], [0.5, 0]]);
});
