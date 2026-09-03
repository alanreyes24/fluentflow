import test from 'node:test';
import assert from 'node:assert/strict';
import {
  review,
  reviewCard,
  updateEaseFactor,
  newCardState,
  dueCards,
  deckProgress,
  createCard,
  DEFAULT_EASE_FACTOR,
  MIN_EASE_FACTOR,
  MASTERED_INTERVAL_DAYS,
  LAPSE_MINUTES,
} from '../dist/index.js';

const NOW = new Date('2024-09-03T10:00:00.000Z');
const fresh = () => ({ interval: 0, easeFactor: DEFAULT_EASE_FACTOR, repetitions: 0 });

test('ease factor follows the SM-2 formula', () => {
  // EF' = EF + (0.1 - (5-q)(0.08 + (5-q)0.02))
  assert.equal(updateEaseFactor(2.5, 5), 2.6);
  assert.equal(updateEaseFactor(2.5, 4), 2.5);
  assert.equal(updateEaseFactor(2.5, 3), 2.36);
  assert.equal(updateEaseFactor(2.5, 0), 1.7);
});

test('ease factor never drops below 1.3', () => {
  let ease = DEFAULT_EASE_FACTOR;
  for (let i = 0; i < 20; i++) ease = updateEaseFactor(ease, 0);
  assert.equal(ease, MIN_EASE_FACTOR);
});

test('the good-rating ladder is 1 day, then 6, then interval times ease', () => {
  const first = review(fresh(), 'good', NOW);
  assert.equal(first.interval, 1);
  assert.equal(first.repetitions, 1);
  assert.equal(first.nextReview, '2024-09-04T10:00:00.000Z');

  const second = review(first, 'good', NOW);
  assert.equal(second.interval, 6);
  assert.equal(second.repetitions, 2);

  const third = review(second, 'good', NOW);
  // 6 * 2.5 = 15
  assert.equal(third.interval, 15);
  assert.equal(third.easeFactor, 2.5);
});

test('again re-queues the card in minutes and resets the repetition count', () => {
  const mature = { interval: 40, easeFactor: 2.6, repetitions: 6 };
  const lapsed = review(mature, 'again', NOW);

  assert.equal(lapsed.interval, 0);
  assert.equal(lapsed.repetitions, 0);
  assert.equal(lapsed.status, 'learning');
  assert.equal(
    lapsed.nextReview,
    new Date(NOW.getTime() + LAPSE_MINUTES * 60_000).toISOString(),
  );
  // The ease penalty is kept even though the interval resets.
  assert.equal(lapsed.easeFactor, updateEaseFactor(2.6, 0));
});

test('hard grows the interval more slowly than good and lowers ease', () => {
  const state = { interval: 10, easeFactor: 2.5, repetitions: 3 };
  const hard = review(state, 'hard', NOW);
  const good = review(state, 'good', NOW);

  assert.ok(hard.interval < good.interval, `${hard.interval} should be under ${good.interval}`);
  assert.ok(hard.interval > state.interval, 'hard still passes, so the interval must grow');
  assert.equal(hard.easeFactor, 2.36);
});

test('easy grows the interval faster than good and raises ease', () => {
  const state = { interval: 10, easeFactor: 2.5, repetitions: 3 };
  const easy = review(state, 'easy', NOW);
  const good = review(state, 'good', NOW);

  assert.ok(easy.interval > good.interval);
  assert.equal(easy.easeFactor, 2.6);
});

test('a card becomes mastered once its interval reaches the maturity threshold', () => {
  let state = newCardState(NOW);
  assert.equal(state.status, 'new');

  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    state = review(state, 'good', NOW);
    seen.add(state.status);
    if (state.status === 'mastered') break;
  }

  assert.ok(seen.has('learning'), 'card should pass through learning');
  assert.equal(state.status, 'mastered');
  assert.ok(state.interval >= MASTERED_INTERVAL_DAYS);
});

test('reviewCard marks the card dirty for sync', () => {
  const card = createCard({
    userId: 'u1',
    deckId: 'd1',
    front: 'hablar',
    back: 'to speak',
    language: 'es',
    now: NOW,
  });
  const synced = { ...card, syncStatus: 'synced' };

  const reviewed = reviewCard(synced, 'good', new Date('2024-09-03T11:00:00.000Z'));

  assert.equal(reviewed.syncStatus, 'pending');
  assert.equal(reviewed.lastModified, '2024-09-03T11:00:00.000Z');
  assert.equal(reviewed.interval, 1);
  assert.equal(reviewed.id, card.id, 'the identity must survive a review');
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
