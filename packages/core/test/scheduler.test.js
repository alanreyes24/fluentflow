import test from 'node:test';
import assert from 'node:assert/strict';
import {
  review,
  reviewCard,
  newCardState,
  normalizeCard,
  schedulingStateFor,
  statusFor,
  dueCards,
  deckProgress,
  createCard,
  DEFAULT_SCHEDULER_CONFIG,
  DEFAULT_EASE_FACTOR,
  MIN_EASE_FACTOR,
  MASTERED_INTERVAL_DAYS,
  MS_PER_DAY,
  MS_PER_MINUTE,
  collectionDayKey,
  addCollectionDays,
  buildStudyQueue,
} from '../dist/index.js';

const NOW = new Date('2024-09-03T10:00:00.000Z');

/** Fuzz is what makes Anki's intervals non-deterministic; pin it off. */
const exact = { now: NOW, config: { fuzz: false } };

/** A review card that came due exactly now. */
const reviewState = (interval, easeFactor = DEFAULT_EASE_FACTOR, extra = {}) => ({
  phase: 'review',
  interval,
  easeFactor,
  repetitions: 5,
  lapses: 0,
  learningStep: 0,
  nextReview: NOW.toISOString(),
  leech: false,
  status: statusFor('review', interval),
  ...extra,
});

const minutesAfter = (minutes) => new Date(NOW.getTime() + minutes * MS_PER_MINUTE).toISOString();
const daysAfter = (days) => new Date(NOW.getTime() + days * MS_PER_DAY).toISOString();

// --- learning steps --------------------------------------------------------

test('a new card walks the learning steps instead of jumping to a day', () => {
  const fresh = newCardState(NOW);
  assert.equal(fresh.phase, 'new');

  // Anki's default steps are 1m then 10m.
  const first = review(fresh, 'good', exact);
  assert.equal(first.phase, 'learning');
  assert.equal(first.learningStep, 1);
  assert.equal(first.interval, 0);
  assert.equal(first.nextReview, minutesAfter(10));

  const graduated = review(first, 'good', exact);
  assert.equal(graduated.phase, 'review');
  assert.equal(graduated.interval, DEFAULT_SCHEDULER_CONFIG.graduatingInterval);
  assert.equal(graduated.nextReview, daysAfter(1));
  assert.equal(graduated.easeFactor, DEFAULT_EASE_FACTOR, 'graduating does not move ease');
});

test('again on a learning card restarts the step list', () => {
  const second = review(newCardState(NOW), 'good', exact);
  const restarted = review(second, 'again', exact);

  assert.equal(restarted.phase, 'learning');
  assert.equal(restarted.learningStep, 0);
  assert.equal(restarted.nextReview, minutesAfter(1));
  assert.equal(restarted.lapses, 0, 'only review cards can lapse');
});

test('hard on the first learning step waits the average of the first two steps', () => {
  const hard = review(newCardState(NOW), 'hard', exact);

  assert.equal(hard.learningStep, 0, 'hard repeats the step rather than advancing');
  assert.equal(hard.nextReview, minutesAfter(5.5)); // (1 + 10) / 2

  // On a single-step list there is nothing to average with, so Anki uses 1.5x.
  const single = review(newCardState(NOW), 'hard', {
    ...exact,
    config: { ...exact.config, learningSteps: [10] },
  });
  assert.equal(single.nextReview, minutesAfter(15));
});

test('easy skips the remaining learning steps for the easy interval', () => {
  const easy = review(newCardState(NOW), 'easy', exact);

  assert.equal(easy.phase, 'review');
  assert.equal(easy.interval, DEFAULT_SCHEDULER_CONFIG.easyInterval);
  assert.equal(easy.nextReview, daysAfter(4));
});

// --- review intervals ------------------------------------------------------

test('hard multiplies the interval by 1.2 and ignores ease', () => {
  const low = review(reviewState(10, 1.5), 'hard', exact);
  const high = review(reviewState(10, 2.8), 'hard', exact);

  assert.equal(low.interval, 12);
  assert.equal(high.interval, 12);
  assert.equal(high.easeFactor, 2.65, 'hard still costs 0.15 of ease');
});

test('good multiplies the interval by ease, easy adds the easy bonus', () => {
  const good = review(reviewState(10), 'good', exact);
  const easy = review(reviewState(10), 'easy', exact);

  assert.equal(good.interval, 25); // 10 * 2.5
  assert.equal(good.easeFactor, DEFAULT_EASE_FACTOR, 'good leaves ease alone');

  assert.equal(easy.interval, 33); // 10 * 2.5 * 1.3
  assert.equal(easy.easeFactor, 2.65);
});

test('an overdue card is credited half the delay on good and all of it on easy', () => {
  const fiveDaysLate = reviewState(10, DEFAULT_EASE_FACTOR, {
    nextReview: new Date(NOW.getTime() - 5 * MS_PER_DAY).toISOString(),
  });

  assert.equal(review(fiveDaysLate, 'good', exact).interval, 31); // (10 + 2.5) * 2.5
  assert.equal(review(fiveDaysLate, 'easy', exact).interval, 49); // (10 + 5) * 2.5 * 1.3
  assert.equal(review(fiveDaysLate, 'hard', exact).interval, 12, 'hard ignores the delay');
});

test('studying ahead is credited elapsed time, not the whole interval', () => {
  const fourDaysEarly = reviewState(10, DEFAULT_EASE_FACTOR, {
    nextReview: new Date(NOW.getTime() + 4 * MS_PER_DAY).toISOString(),
  });

  const good = review(fourDaysEarly, 'good', exact);
  assert.equal(good.interval, 15, '6 elapsed days * 2.5, not 10 * 2.5');
  assert.ok(good.interval < review(reviewState(10), 'good', exact).interval);
});

test('a better answer always schedules further out than a worse one', () => {
  // A card at the ease floor is where the minimum chain earns its keep: good
  // would otherwise land under hard.
  const state = reviewState(10, MIN_EASE_FACTOR);
  const hard = review(state, 'hard', exact);
  const good = review(state, 'good', exact);
  const easy = review(state, 'easy', exact);

  assert.ok(hard.interval > state.interval, `${hard.interval} must beat ${state.interval}`);
  assert.ok(good.interval > hard.interval, `${good.interval} must beat ${hard.interval}`);
  assert.ok(easy.interval > good.interval, `${easy.interval} must beat ${good.interval}`);
});

test('intervals are capped at the configured maximum', () => {
  const huge = review(reviewState(30_000), 'easy', exact);
  assert.equal(huge.interval, DEFAULT_SCHEDULER_CONFIG.maximumInterval);
});

// --- ease ------------------------------------------------------------------

test('ease moves by Anki fixed deltas, not by the SM-2 formula', () => {
  assert.equal(review(reviewState(10), 'again', exact).easeFactor, 2.3);
  assert.equal(review(reviewState(10), 'hard', exact).easeFactor, 2.35);
  assert.equal(review(reviewState(10), 'good', exact).easeFactor, 2.5);
  assert.equal(review(reviewState(10), 'easy', exact).easeFactor, 2.65);
});

test('ease never drops below the floor', () => {
  let state = reviewState(10);
  for (let i = 0; i < 20; i++) state = review({ ...state, phase: 'review' }, 'again', exact);
  assert.equal(state.easeFactor, MIN_EASE_FACTOR);
});

// --- lapses and relearning -------------------------------------------------

test('a failed review card enters relearning and loses its interval', () => {
  const lapsed = review(reviewState(40), 'again', exact);

  assert.equal(lapsed.phase, 'relearning');
  assert.equal(lapsed.learningStep, 0);
  assert.equal(lapsed.lapses, 1);
  assert.equal(lapsed.nextReview, minutesAfter(10), 'the relearning step is 10m');
  // The default lapse multiplier is 0%, so the card comes back at the floor.
  assert.equal(lapsed.interval, DEFAULT_SCHEDULER_CONFIG.minimumLapseInterval);
  assert.equal(lapsed.status, 'learning');
});

test('a lapse multiplier keeps part of the interval for after relearning', () => {
  const options = { now: NOW, config: { fuzz: false, lapseMultiplier: 0.5 } };
  const lapsed = review(reviewState(40), 'again', options);
  assert.equal(lapsed.interval, 20, 'the interval waits out the relearning steps');

  const relearned = review(lapsed, 'good', options);
  assert.equal(relearned.phase, 'review');
  assert.equal(relearned.interval, 20);
  assert.equal(relearned.nextReview, daysAfter(20));
});

test('relearning answers walk their own step list', () => {
  const lapsed = review(reviewState(40), 'again', exact);

  const again = review(lapsed, 'again', exact);
  assert.equal(again.phase, 'relearning');
  assert.equal(again.nextReview, minutesAfter(10));
  assert.equal(again.lapses, 1, 'failing during relearning is not a second lapse');

  const hard = review(lapsed, 'hard', exact);
  assert.equal(hard.nextReview, minutesAfter(15), 'one step, so hard waits 1.5x');

  const easy = review(lapsed, 'easy', exact);
  assert.equal(easy.phase, 'review');
  assert.equal(easy.interval, 2, 'easy leaves relearning a day past the lapse interval');
});

test('a deck with no relearning steps sends a lapse straight back to review', () => {
  const lapsed = review(reviewState(40), 'again', {
    now: NOW,
    config: { fuzz: false, relearningSteps: [] },
  });

  assert.equal(lapsed.phase, 'review');
  assert.equal(lapsed.nextReview, daysAfter(1));
});

test('a card is flagged as a leech once it hits the lapse threshold', () => {
  let state = reviewState(10, DEFAULT_EASE_FACTOR, { lapses: 6 });
  state = review(state, 'again', exact);
  assert.equal(state.lapses, 7);
  assert.equal(state.leech, false);

  state = review({ ...state, phase: 'review', interval: 10 }, 'again', exact);
  assert.equal(state.lapses, 8);
  assert.equal(state.leech, true, 'the default threshold is 8 lapses');
});

// --- fuzz ------------------------------------------------------------------

test('fuzz spreads an interval over a widening window and respects the minimum', () => {
  const state = reviewState(10);
  // 25 days: 1 + 0.15*4.5 + 0.1*13 + 0.05*5 = 3.225 days of slack either way.
  const lowest = review(state, 'good', { now: NOW, random: () => 0 });
  const highest = review(state, 'good', { now: NOW, random: () => 0.999999 });

  assert.equal(lowest.interval, 22);
  assert.equal(highest.interval, 28);

  // Short intervals have nowhere to go, so Anki leaves them alone.
  const graduating = review(newCardState(NOW), 'easy', {
    now: NOW,
    config: { easyInterval: 1 },
    random: () => 0,
  });
  assert.equal(graduating.interval, 1);
});

// --- card plumbing ---------------------------------------------------------

test('reviewCard carries the scheduler fields onto the card and marks it dirty', () => {
  const card = createCard({
    userId: 'u1',
    deckId: 'd1',
    front: 'hablar',
    back: 'to speak',
    language: 'es',
    now: NOW,
  });
  assert.equal(card.phase, 'new');

  const synced = { ...card, syncStatus: 'synced' };
  const reviewed = reviewCard(synced, 'easy', exact);

  assert.equal(reviewed.id, card.id, 'the identity must survive a review');
  assert.equal(reviewed.phase, 'review');
  assert.equal(reviewed.interval, 4);
  assert.equal(reviewed.lapses, 0);
  assert.equal(reviewed.syncStatus, 'pending');
  assert.equal(reviewed.lastModified, NOW.toISOString());
});

test('a card written before the Anki scheduler is given a phase', () => {
  const legacy = {
    id: 'c1',
    deckId: 'd1',
    userId: 'u1',
    front: 'x',
    back: 'y',
    language: 'es',
    examples: [],
    interval: 15,
    easeFactor: 2.5,
    repetitions: 3,
    nextReview: NOW.toISOString(),
    status: 'learning',
    lastModified: NOW.toISOString(),
    syncStatus: 'synced',
  };

  const migrated = normalizeCard(legacy);
  assert.equal(migrated.phase, 'review', 'a day-level interval means it graduated');
  assert.equal(migrated.lapses, 0);
  assert.equal(migrated.learningStep, 0);

  // Unseen cards keep their place at the front of the queue.
  const unseen = normalizeCard({ ...legacy, interval: 0, repetitions: 0, status: 'new' });
  assert.equal(unseen.phase, 'new');

  // Reading a legacy card straight into the scheduler works without the migration.
  assert.equal(schedulingStateFor(legacy).phase, 'review');
  assert.equal(review(schedulingStateFor(legacy), 'good', exact).interval, 38);
});

test('a card becomes mastered once its interval reaches the maturity threshold', () => {
  let state = newCardState(NOW);
  assert.equal(state.status, 'new');

  // Answered on time every round: 1d, 3d, 8d, 19d, 48d with the default ease.
  const seen = new Set();
  for (let i = 0; i < 10 && state.status !== 'mastered'; i++) {
    state = review(state, 'good', { now: new Date(state.nextReview), config: { fuzz: false } });
    seen.add(state.status);
  }

  assert.ok(seen.has('learning'), 'card should pass through learning');
  assert.equal(state.status, 'mastered');
  assert.ok(state.interval >= MASTERED_INTERVAL_DAYS);
});

test('due cards exclude future and deleted cards, most overdue first', () => {
  const base = {
    deckId: 'd1',
    userId: 'u1',
    front: 'x',
    back: 'y',
    language: 'es',
    examples: [],
    interval: 1,
    easeFactor: 2.5,
    repetitions: 1,
    phase: 'review',
    lapses: 0,
    learningStep: 0,
    status: 'learning',
    lastModified: NOW.toISOString(),
    syncStatus: 'synced',
  };
  const cards = [
    { ...base, id: 'future', nextReview: '2024-09-10T10:00:00.000Z' },
    { ...base, id: 'overdue', nextReview: '2024-08-01T10:00:00.000Z' },
    { ...base, id: 'just-due', nextReview: '2024-09-03T09:59:00.000Z' },
    { ...base, id: 'gone', nextReview: '2024-08-01T10:00:00.000Z', deleted: true },
  ];

  assert.deepEqual(
    dueCards(cards, NOW).map((c) => c.id),
    ['overdue', 'just-due'],
  );

  assert.deepEqual(deckProgress(cards, NOW), {
    total: 3,
    new: 0,
    learning: 3,
    mastered: 0,
    due: 2,
  });
});

test('collection days roll over at 4am and review due days ignore timestamps', () => {
  const beforeBoundary = new Date(2024, 8, 4, 3, 59);
  const afterBoundary = new Date(2024, 8, 4, 4, 0);
  assert.equal(collectionDayKey(beforeBoundary), '2024-09-03');
  assert.equal(collectionDayKey(afterBoundary), '2024-09-04');
  assert.equal(addCollectionDays('2024-09-30', 1), '2024-10-01');

  const card = reviewCard(
    { ...reviewState(10), nextReview: NOW.toISOString() },
    'good',
    { now: afterBoundary, config: { fuzz: false } },
  );
  assert.equal(card.dueDay, addCollectionDays(collectionDayKey(afterBoundary), Math.round(card.interval)));
});

test('study queue applies review limits, new limits, and manual hiding', () => {
  const learning = { ...reviewState(1), id: 'learning', phase: 'learning', nextReview: NOW.toISOString() };
  const review = { ...reviewState(1), id: 'review', phase: 'review', nextReview: NOW.toISOString(), dueDay: collectionDayKey(NOW) };
  const newOne = { ...reviewState(0), id: 'new-1', phase: 'new', interval: 0, nextReview: NOW.toISOString(), status: 'new' };
  const newTwo = { ...newOne, id: 'new-2' };
  const hidden = { ...newOne, id: 'suspended', suspended: true };
  const buried = { ...newOne, id: 'buried', buriedUntil: addCollectionDays(collectionDayKey(NOW), 1) };

  const queue = buildStudyQueue([learning, review, newOne, newTwo, hidden, buried], {
    now: NOW,
    newCardsPerDay: 1,
    maxReviewsPerDay: 1,
  });
  assert.deepEqual(queue.cards.map((card) => card.id), ['learning', 'review', 'new-1']);
  assert.equal(queue.learning, 1);
  assert.equal(queue.review, 1);
  assert.equal(queue.new, 1);
});
