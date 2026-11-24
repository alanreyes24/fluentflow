import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FSRS_DEFAULT_PARAMETERS,
  MIN_OPTIMIZE_REVIEWS,
  countScoredReviews,
  evaluateFsrs,
  fsrsInterval,
  fsrsTrainingItems,
  nextMemoryState,
  optimizeFsrs,
  retrievability,
  review,
  newCardState,
  isSettingValue,
  mergeSettings,
  sameSettings,
} from '../dist/index.js';

const DAY = 86_400_000;
const START = Date.parse('2026-01-05T12:00:00Z');
const dayKey = (instant) => instant.toISOString().slice(0, 10);

/** Deterministic uniform [0, 1). */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

/**
 * A learner whose memory really follows `truth`: each card is reviewed when
 * the default model says recall is near 90%, and passes with the probability
 * `truth` predicts.
 */
function simulateHistories(truth, { cards = 500, reviews = 7, seed = 1 } = {}) {
  const random = rng(seed);
  const histories = [];
  for (let c = 0; c < cards; c++) {
    let at = START + Math.floor(random() * 20) * DAY;
    const history = [{ rating: random() < 0.15 ? 'again' : 'good', reviewedAt: new Date(at).toISOString() }];
    let truthMemory = nextMemoryState(undefined, 0, history[0].rating, truth);
    let scheduled = nextMemoryState(undefined, 0, history[0].rating);
    for (let r = 1; r < reviews; r++) {
      const wait = Math.max(1, Math.round(fsrsInterval(scheduled.stability, 0.9) * (0.7 + random() * 0.8)));
      at += wait * DAY;
      const passed = random() < retrievability(wait, truthMemory.stability, truth);
      const rating = passed ? (random() < 0.5 ? 'good' : 'hard') : 'again';
      history.push({ rating, reviewedAt: new Date(at).toISOString() });
      truthMemory = nextMemoryState(truthMemory, wait, rating, truth);
      scheduled = nextMemoryState(scheduled, wait, rating);
    }
    histories.push(history);
  }
  return histories;
}

test('training items count whole days between answers and need two answers', () => {
  const items = fsrsTrainingItems([
    [
      { rating: 'good', reviewedAt: '2026-01-05T09:00:00Z' },
      { rating: 'good', reviewedAt: '2026-01-05T09:10:00Z' },
      { rating: 'again', reviewedAt: '2026-01-08T20:00:00Z' },
    ],
    [{ rating: 'good', reviewedAt: '2026-01-05T09:00:00Z' }],
  ], dayKey);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].map((answer) => answer.elapsedDays), [0, 0, 3]);
  // Only the answer given days later is a prediction to score.
  assert.equal(countScoredReviews(items), 1);
});

test('the model that generated a history scores better on it than one that did not', () => {
  const truth = [...FSRS_DEFAULT_PARAMETERS];
  truth[8] = 1.2; // a learner whose memory grows far more slowly
  const items = fsrsTrainingItems(simulateHistories(truth), dayKey);
  assert.ok(evaluateFsrs(truth, items).logLoss < evaluateFsrs(FSRS_DEFAULT_PARAMETERS, items).logLoss);
});

test('optimizing a learner unlike the defaults finds weights that predict them better', async () => {
  const truth = [...FSRS_DEFAULT_PARAMETERS];
  truth[8] = 1.2;
  const items = fsrsTrainingItems(simulateHistories(truth), dayKey);
  assert.ok(countScoredReviews(items) >= MIN_OPTIMIZE_REVIEWS);

  const result = await optimizeFsrs(items, { iterations: 60 });
  assert.equal(result.improved, true);
  assert.ok(result.after.logLoss < result.before.logLoss);
  // The fit moves the weight that differs towards the truth.
  assert.ok(result.parameters[8] < FSRS_DEFAULT_PARAMETERS[8]);
  assert.equal(result.parameters.length, 21);
  // Initial stabilities stay ordered by grade.
  for (let i = 1; i < 4; i++) assert.ok(result.parameters[i] >= result.parameters[i - 1]);
});

test('too little history leaves the weights untouched', async () => {
  const items = fsrsTrainingItems(simulateHistories(FSRS_DEFAULT_PARAMETERS, { cards: 20 }), dayKey);
  const result = await optimizeFsrs(items);
  assert.equal(result.improved, false);
  assert.deepEqual(result.parameters, [...FSRS_DEFAULT_PARAMETERS]);
});

test('scoring can be restricted to a holdout window', () => {
  const items = fsrsTrainingItems(simulateHistories(FSRS_DEFAULT_PARAMETERS, { cards: 50 }), dayKey);
  const cutoff = new Date(START + 60 * DAY).toISOString();
  const early = evaluateFsrs(FSRS_DEFAULT_PARAMETERS, items, { before: cutoff });
  const late = evaluateFsrs(FSRS_DEFAULT_PARAMETERS, items, { from: cutoff });
  assert.equal(early.reviews + late.reviews, evaluateFsrs(FSRS_DEFAULT_PARAMETERS, items).reviews);
  assert.equal(countScoredReviews(items, cutoff), early.reviews);
});

test('the scheduler uses fitted weights when given them', () => {
  const now = new Date('2026-01-05T10:00:00');
  const slow = [...FSRS_DEFAULT_PARAMETERS];
  slow[3] = 3; // a much smaller head start for a first "easy"
  const withDefaults = review(newCardState(now), 'easy', { now, config: { fuzz: false } });
  const withFitted = review(newCardState(now), 'easy', { now, config: { fuzz: false }, parameters: slow });
  assert.ok(withFitted.interval < withDefaults.interval);
});

test('fitted weights are a valid, syncable account setting', () => {
  const fsrs = { parameters: [...FSRS_DEFAULT_PARAMETERS], reviews: 1700, logLoss: 0.43, defaultLogLoss: 0.44 };
  assert.equal(isSettingValue('fsrs', fsrs), true);
  assert.equal(isSettingValue('fsrs', { parameters: null, reviews: 12 }), true);
  assert.equal(isSettingValue('fsrs', { parameters: [1, 2, 3], reviews: 1 }), false);
  assert.equal(isSettingValue('fsrs', { parameters: null, reviews: -1 }), false);
  assert.equal(isSettingValue('fsrs', [1, 2]), false);

  const a = { fsrs: { value: fsrs, updatedAt: '2026-01-05T10:00:00.000Z' } };
  const b = { fsrs: { value: { ...fsrs, parameters: null }, updatedAt: '2026-01-06T10:00:00.000Z' } };
  // Object values compare by content, so an identical copy is not a change.
  assert.equal(sameSettings(a, { fsrs: { value: { ...fsrs }, updatedAt: a.fsrs.updatedAt } }), true);
  assert.equal(sameSettings(a, b), false);
  assert.deepEqual(mergeSettings(a, b), b);
});
