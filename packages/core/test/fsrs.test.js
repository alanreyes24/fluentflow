import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FSRS_DEFAULT_PARAMETERS,
  DEFAULT_DESIRED_RETENTION,
  MIN_DESIRED_RETENTION,
  MAX_DESIRED_RETENTION,
  DEFAULT_EASE_FACTOR,
  convertCardToFsrs,
  createCard,
  deckScheduling,
  elapsedDaysFor,
  fsrsInterval,
  memoryStateFromHistory,
  memoryStateFromSm2,
  newCardState,
  nextMemoryState,
  retrievability,
  review,
  reviewCard,
  statusFor,
  addCollectionDays,
  collectionDayKey,
} from '../dist/index.js';

const NOW = new Date('2024-09-03T10:00:00');
const exact = { now: NOW, config: { fuzz: false } };
const close = (actual, expected, tolerance = 1e-3) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

/** A review card with FSRS memory, last answered `elapsed` days before NOW. */
const fsrsReviewState = (stability, difficulty, elapsed = Math.round(stability), extra = {}) => {
  const lastReviewed = new Date(NOW);
  lastReviewed.setDate(lastReviewed.getDate() - elapsed);
  return {
    phase: 'review',
    interval: Math.max(1, Math.round(stability)),
    easeFactor: DEFAULT_EASE_FACTOR,
    repetitions: 5,
    lapses: 0,
    learningStep: 0,
    nextReview: NOW.toISOString(),
    dueDay: collectionDayKey(NOW),
    leech: false,
    status: statusFor('review', Math.round(stability)),
    stability,
    difficulty,
    lastReviewedAt: lastReviewed.toISOString(),
    ...extra,
  };
};

// --- the memory model -----------------------------------------------------

test('stability is the wait until recall falls to 90%', () => {
  close(retrievability(10, 10), 0.9);
  close(fsrsInterval(10, 0.9), 10);
  assert.ok(retrievability(20, 10) < 0.9);
  assert.ok(retrievability(5, 10) > 0.9);
});

test('a higher desired retention schedules shorter waits', () => {
  const low = fsrsInterval(10, 0.8);
  const mid = fsrsInterval(10, 0.9);
  const high = fsrsInterval(10, 0.95);
  assert.ok(low > mid && mid > high, `${low} > ${mid} > ${high}`);
});

test('a first answer takes the initial stability for its grade', () => {
  const [again, hard, good, easy] = FSRS_DEFAULT_PARAMETERS;
  close(nextMemoryState(undefined, 0, 'again').stability, again);
  close(nextMemoryState(undefined, 0, 'hard').stability, hard);
  close(nextMemoryState(undefined, 0, 'good').stability, good);
  close(nextMemoryState(undefined, 0, 'easy').stability, easy);
  // Worse first answers mean harder cards.
  const d = ['again', 'hard', 'good', 'easy'].map((r) => nextMemoryState(undefined, 0, r).difficulty);
  assert.ok(d[0] > d[1] && d[1] > d[2] && d[2] >= d[3]);
  for (const value of d) assert.ok(value >= 1 && value <= 10);
});

test('remembering grows stability, forgetting shrinks it, and difficulty follows the grade', () => {
  const memory = { stability: 10, difficulty: 5 };
  const again = nextMemoryState(memory, 10, 'again');
  const hard = nextMemoryState(memory, 10, 'hard');
  const good = nextMemoryState(memory, 10, 'good');
  const easy = nextMemoryState(memory, 10, 'easy');
  assert.ok(again.stability < memory.stability);
  assert.ok(hard.stability > memory.stability);
  assert.ok(good.stability > hard.stability && easy.stability > good.stability);
  assert.ok(again.difficulty > memory.difficulty);
  assert.ok(easy.difficulty < memory.difficulty);
});

test('a late success is worth more than an on-time one', () => {
  const memory = { stability: 10, difficulty: 5 };
  assert.ok(nextMemoryState(memory, 30, 'good').stability > nextMemoryState(memory, 10, 'good').stability);
});

test('a same-day answer uses the short-term formula and never lowers stability on good', () => {
  const memory = { stability: 2.3, difficulty: 5 };
  assert.ok(nextMemoryState(memory, 0, 'good').stability >= memory.stability);
  assert.ok(nextMemoryState(memory, 0, 'again').stability < memory.stability);
});

test('SM-2 state converts the way Anki converts it', () => {
  // At Anki's assumed 90% retention the interval is the stability.
  close(memoryStateFromSm2(2.5, 10).stability, 10);
  // Faster-growing (higher-ease) cards are easier.
  const easy = memoryStateFromSm2(3.0, 10).difficulty;
  const normal = memoryStateFromSm2(2.5, 10).difficulty;
  const hard = memoryStateFromSm2(1.3, 10).difficulty;
  assert.ok(easy < normal && normal < hard);
  assert.ok(hard <= 10 && easy >= 1);
});

test('replaying a history equals answering it one step at a time', () => {
  const step1 = nextMemoryState(undefined, 0, 'good');
  const step2 = nextMemoryState(step1, 0, 'good');
  const step3 = nextMemoryState(step2, 3, 'hard');
  assert.deepEqual(
    memoryStateFromHistory([
      { rating: 'good', elapsedDays: 0 },
      { rating: 'good', elapsedDays: 0 },
      { rating: 'hard', elapsedDays: 3 },
    ]),
    step3,
  );
});

// --- the scheduler under FSRS ----------------------------------------------

test('decks run FSRS at 90% unless they choose otherwise', () => {
  assert.deepEqual(deckScheduling(undefined), { algorithm: 'fsrs', desiredRetention: DEFAULT_DESIRED_RETENTION });
  assert.deepEqual(deckScheduling({}), { algorithm: 'fsrs', desiredRetention: 0.9 });
  assert.deepEqual(deckScheduling({ scheduler: 'sm2' }).algorithm, 'sm2');
  assert.equal(deckScheduling({ desiredRetention: 0.85 }).desiredRetention, 0.85);
  assert.equal(deckScheduling({ desiredRetention: 0.2 }).desiredRetention, MIN_DESIRED_RETENTION);
  assert.equal(deckScheduling({ desiredRetention: 0.999 }).desiredRetention, MAX_DESIRED_RETENTION);
});

test('review() runs FSRS by default', () => {
  const answered = review(newCardState(NOW), 'good', exact);
  assert.ok(answered.stability > 0);
  assert.ok(answered.difficulty >= 1);
  assert.equal(answered.lastReviewedAt, NOW.toISOString());
});

test('a new card still walks the learning steps, then graduates on its stability', () => {
  const first = review(newCardState(NOW), 'good', exact);
  assert.equal(first.phase, 'learning');
  assert.equal(first.learningStep, 1);
  assert.equal(Date.parse(first.nextReview) - NOW.getTime(), 10 * 60_000);

  const later = new Date(NOW.getTime() + 10 * 60_000);
  const graduated = review(first, 'good', { ...exact, now: later });
  assert.equal(graduated.phase, 'review');
  // SM-2 would graduate onto a flat 1 day; FSRS reads it off stability.
  assert.equal(graduated.interval, Math.round(fsrsInterval(graduated.stability, 0.9)));
  assert.ok(graduated.interval >= 2);
});

test('easy on a new card skips the steps to its FSRS interval', () => {
  const easy = review(newCardState(NOW), 'easy', exact);
  assert.equal(easy.phase, 'review');
  assert.equal(easy.interval, Math.round(FSRS_DEFAULT_PARAMETERS[3]));
});

test('review grades order hard < good < easy, from each grade\'s own stability', () => {
  const state = fsrsReviewState(10, 5);
  const hard = review(state, 'hard', exact);
  const good = review(state, 'good', exact);
  const easy = review(state, 'easy', exact);
  assert.ok(hard.interval < good.interval && good.interval < easy.interval);
  assert.equal(good.interval, Math.round(fsrsInterval(good.stability, 0.9)));
  // Ease is SM-2's; FSRS leaves it where it was.
  assert.equal(good.easeFactor, DEFAULT_EASE_FACTOR);
  assert.equal(hard.easeFactor, DEFAULT_EASE_FACTOR);
});

test('desired retention changes the interval, not the memory', () => {
  const state = fsrsReviewState(10, 5);
  const relaxed = review(state, 'good', { ...exact, desiredRetention: 0.8 });
  const strict = review(state, 'good', { ...exact, desiredRetention: 0.95 });
  assert.equal(relaxed.stability, strict.stability);
  assert.ok(relaxed.interval > strict.interval);
});

test('a lapse relearns, then returns to the post-lapse stability', () => {
  const lapsed = review(fsrsReviewState(60, 5), 'again', exact);
  assert.equal(lapsed.phase, 'relearning');
  assert.equal(lapsed.lapses, 1);
  assert.ok(lapsed.stability < 60);
  assert.equal(lapsed.easeFactor, DEFAULT_EASE_FACTOR);
  assert.equal(Date.parse(lapsed.nextReview) - NOW.getTime(), 10 * 60_000);

  const relearned = review(lapsed, 'good', { ...exact, now: new Date(NOW.getTime() + 10 * 60_000) });
  assert.equal(relearned.phase, 'review');
  assert.equal(relearned.interval, Math.max(1, Math.round(fsrsInterval(relearned.stability, 0.9))));
});

test('a deck with no relearning steps sends a lapse straight back to review under FSRS', () => {
  const lapsed = review(fsrsReviewState(60, 5), 'again', { now: NOW, config: { fuzz: false, relearningSteps: [] } });
  assert.equal(lapsed.phase, 'review');
  assert.ok(lapsed.interval >= 1);
});

test('a card graduated under SM-2 is converted on its first FSRS answer', () => {
  const sm2Card = {
    phase: 'review',
    interval: 10,
    easeFactor: 2.5,
    repetitions: 6,
    lapses: 0,
    learningStep: 0,
    nextReview: NOW.toISOString(),
    dueDay: collectionDayKey(NOW),
    leech: false,
    status: 'learning',
  };
  // Last answered one interval before it fell due.
  assert.equal(elapsedDaysFor(sm2Card, NOW), 10);
  const answered = review(sm2Card, 'good', exact);
  const expected = nextMemoryState(memoryStateFromSm2(2.5, 10), 10, 'good');
  close(answered.stability, expected.stability);
  close(answered.difficulty, expected.difficulty);
});

test('the SM-2 scheduler is still there for a deck that picks it', () => {
  const sm2 = review(fsrsReviewState(10, 5), 'good', { ...exact, algorithm: 'sm2' });
  assert.equal(sm2.interval, 25); // 10 x 2.5
  assert.equal(sm2.easeFactor, DEFAULT_EASE_FACTOR);
});

test('reviewCard carries the FSRS memory onto the card', () => {
  const card = createCard({ userId: 'u', deckId: 'd', front: 'hola', back: 'hello', language: 'es', now: NOW });
  const answered = reviewCard(card, 'easy', exact);
  assert.ok(answered.stability > 0);
  assert.ok(answered.difficulty >= 1);
  assert.equal(answered.lastReviewedAt, NOW.toISOString());
  assert.equal(answered.phase, 'review');
  assert.equal(answered.syncStatus, 'pending');
});

// --- converting a collection ----------------------------------------------

const baseCard = (extra = {}) => ({
  ...createCard({ userId: 'u', deckId: 'd', front: 'perro', back: 'dog', language: 'es', now: NOW }),
  ...extra,
});

test('new cards and cards already on FSRS need no conversion', () => {
  assert.equal(convertCardToFsrs(baseCard()), null);
  assert.equal(convertCardToFsrs(baseCard({ phase: 'review', interval: 5, stability: 5, difficulty: 5 })), null);
});

test('a card whose whole history is logged is converted by replaying it', () => {
  const day = (offset, hour = 10) => {
    const date = new Date(NOW);
    date.setDate(date.getDate() + offset);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const history = [
    { rating: 'good', reviewedAt: day(0) },
    { rating: 'good', reviewedAt: day(0, 11) },
    { rating: 'again', reviewedAt: day(1) },
    { rating: 'good', reviewedAt: day(4) },
  ];
  const card = baseCard({ phase: 'review', interval: 3, repetitions: 4, dueDay: addCollectionDays(collectionDayKey(NOW), 7) });
  const converted = convertCardToFsrs(card, [...history].reverse());
  const replayed = memoryStateFromHistory([
    { rating: 'good', elapsedDays: 0 },
    { rating: 'good', elapsedDays: 0 },
    { rating: 'again', elapsedDays: 1 },
    { rating: 'good', elapsedDays: 3 },
  ]);
  assert.deepEqual(converted, { ...replayed, lastReviewedAt: day(4) });
});

test('a card with a partial history (an Anki import) converts from SM-2', () => {
  const card = baseCard({ phase: 'review', interval: 30, easeFactor: 2.3, repetitions: 12 });
  const converted = convertCardToFsrs(card, [{ rating: 'good', reviewedAt: NOW.toISOString() }]);
  assert.deepEqual(
    { stability: converted.stability, difficulty: converted.difficulty },
    memoryStateFromSm2(2.3, 30),
  );
  assert.equal(converted.lastReviewedAt, NOW.toISOString());
});

test('a card mid-learning with no history is left for its next answer', () => {
  assert.equal(convertCardToFsrs(baseCard({ phase: 'learning', interval: 0, repetitions: 1 })), null);
});
