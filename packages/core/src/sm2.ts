import type { Card, CardStatus, IsoDate, RatingName } from './types.js';

/**
 * SM-2 spaced repetition (Wozniak & Gorzelanczyk, 1990) adapted to the
 * four-button Again/Hard/Good/Easy interface.
 *
 * Faithful to the original for the ease-factor update; the deviations below
 * are the ones every Anki-style client makes so the buttons feel right:
 *
 *  - `again` does not schedule a full day out. It resets the repetition
 *    counter and re-queues the card in `LAPSE_MINUTES`, which is what
 *    "I forgot, show me again this session" has to mean in practice.
 *  - `hard` passes (it does not reset repetitions) but grows the interval by
 *    `HARD_MULTIPLIER` rather than by the full ease factor.
 *  - `easy` gets an extra `EASY_BONUS` on top of the ease factor.
 */

/** SM-2 quality grades for each button. Below 3 counts as a failure. */
export const RATING_QUALITY: Record<RatingName, number> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

export const MIN_EASE_FACTOR = 1.3;
export const DEFAULT_EASE_FACTOR = 2.5;
export const FIRST_INTERVAL_DAYS = 1;
export const SECOND_INTERVAL_DAYS = 6;
export const HARD_MULTIPLIER = 1.2;
export const EASY_BONUS = 1.3;
export const LAPSE_MINUTES = 10;
/** Interval at which a card is considered mastered (Anki calls this "mature"). */
export const MASTERED_INTERVAL_DAYS = 21;

export const MS_PER_DAY = 86_400_000;
export const MS_PER_MINUTE = 60_000;

export interface Sm2State {
  interval: number;
  easeFactor: number;
  repetitions: number;
}

export interface Sm2Result extends Sm2State {
  nextReview: IsoDate;
  status: CardStatus;
}

/** Standard SM-2 ease update: EF' = EF + (0.1 - (5-q)(0.08 + (5-q)0.02)). */
export function updateEaseFactor(easeFactor: number, quality: number): number {
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  return Math.max(MIN_EASE_FACTOR, round2(easeFactor + delta));
}

/**
 * Apply a rating to a card's scheduling state.
 *
 * @param state  current interval / ease / repetition count
 * @param rating which button the learner pressed
 * @param now    review time; injected so scheduling is deterministic in tests
 */
export function review(state: Sm2State, rating: RatingName, now: Date = new Date()): Sm2Result {
  const quality = RATING_QUALITY[rating];
  const easeFactor = updateEaseFactor(state.easeFactor, quality);

  if (quality < 3) {
    // Lapse: drop back to the start of the ladder and re-queue shortly.
    return {
      interval: 0,
      easeFactor,
      repetitions: 0,
      nextReview: new Date(now.getTime() + LAPSE_MINUTES * MS_PER_MINUTE).toISOString(),
      status: 'learning',
    };
  }

  const repetitions = state.repetitions + 1;
  let interval: number;

  if (repetitions === 1) {
    interval = FIRST_INTERVAL_DAYS;
  } else if (repetitions === 2) {
    interval = SECOND_INTERVAL_DAYS;
  } else {
    const base = state.interval > 0 ? state.interval : FIRST_INTERVAL_DAYS;
    interval = base * easeFactor;
  }

  if (rating === 'hard') {
    const base = state.interval > 0 ? state.interval : FIRST_INTERVAL_DAYS;
    interval = repetitions === 1 ? FIRST_INTERVAL_DAYS : Math.max(base * HARD_MULTIPLIER, base + 1);
  } else if (rating === 'easy' && repetitions > 2) {
    interval *= EASY_BONUS;
  }

  interval = Math.max(1, Math.round(interval));

  return {
    interval,
    easeFactor,
    repetitions,
    nextReview: new Date(now.getTime() + interval * MS_PER_DAY).toISOString(),
    status: statusFor(interval, repetitions),
  };
}

export function statusFor(interval: number, repetitions: number): CardStatus {
  if (repetitions === 0) return interval === 0 ? 'learning' : 'new';
  return interval >= MASTERED_INTERVAL_DAYS ? 'mastered' : 'learning';
}

/** Scheduling state for a freshly created card. */
export function newCardState(now: Date = new Date()): Sm2Result {
  return {
    interval: 0,
    easeFactor: DEFAULT_EASE_FACTOR,
    repetitions: 0,
    nextReview: now.toISOString(),
    status: 'new',
  };
}

/** Apply a rating directly to a card, returning the updated card. */
export function reviewCard(card: Card, rating: RatingName, now: Date = new Date()): Card {
  const result = review(
    { interval: card.interval, easeFactor: card.easeFactor, repetitions: card.repetitions },
    rating,
    now,
  );
  return {
    ...card,
    interval: result.interval,
    easeFactor: result.easeFactor,
    repetitions: result.repetitions,
    nextReview: result.nextReview,
    status: result.status,
    lastModified: now.toISOString(),
    syncStatus: 'pending',
  };
}

/** Cards whose `nextReview` has come due, hardest-overdue first. */
export function dueCards(cards: Card[], now: Date = new Date()): Card[] {
  const cutoff = now.getTime();
  return cards
    .filter((card) => !card.deleted && Date.parse(card.nextReview) <= cutoff)
    .sort((a, b) => Date.parse(a.nextReview) - Date.parse(b.nextReview));
}

export interface DeckProgress {
  total: number;
  new: number;
  learning: number;
  mastered: number;
  due: number;
}

export function deckProgress(cards: Card[], now: Date = new Date()): DeckProgress {
  const live = cards.filter((c) => !c.deleted);
  return {
    total: live.length,
    new: live.filter((c) => c.status === 'new').length,
    learning: live.filter((c) => c.status === 'learning').length,
    mastered: live.filter((c) => c.status === 'mastered').length,
    due: dueCards(live, now).length,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
