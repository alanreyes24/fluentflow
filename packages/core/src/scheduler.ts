import type { Card, CardPhase, CardStatus, IsoDate, RatingName } from './types.js';

/**
 * Anki's SM-2 scheduler (the "v3" scheduler shipped by Anki Desktop), ported
 * from `rslib/src/scheduler/states`.
 *
 * This is deliberately *not* the 1990 SM-2 paper. Anki keeps the ease factor
 * and the interval-times-ease idea and replaces everything else:
 *
 *  - A card is in one of four phases — new, learning, review, relearning —
 *    rather than on a repetition counter. Phase decides which branch runs.
 *  - New cards walk a list of **learning steps** (1m, 10m) before they earn a
 *    day-level interval; a lapse walks the **relearning steps** (10m).
 *  - Ease moves by fixed deltas (again -0.20, hard -0.15, good 0, easy +0.15),
 *    not by SM-2's quadratic in the quality grade.
 *  - `good` credits half the days a card was overdue, `easy` credits all of
 *    them; `hard` is a flat multiplier that ignores ease entirely.
 *  - Every day-level interval is fuzzed so cards reviewed together do not stay
 *    together forever, and is capped at `maximumInterval`.
 *  - A lapse multiplies the interval by `lapseMultiplier` (0 by default, so the
 *    card restarts at `minimumLapseInterval`) and counts toward leech status.
 *
 * `nextReview` remains an instant for intraday learning steps and ordering,
 * while `dueDay` carries Anki's collection-day semantics for day-level review
 * cards. Per-deck daily limits are enforced by the queue builder below.
 */

export const MS_PER_DAY = 86_400_000;
export const MS_PER_MINUTE = 60_000;
export const DEFAULT_DAY_START_HOUR = 4;

export const MIN_EASE_FACTOR = 1.3;
export const DEFAULT_EASE_FACTOR = 2.5;
/** Interval at which Anki calls a card "mature". This app calls it mastered. */
export const MASTERED_INTERVAL_DAYS = 21;

/** Anki's fixed ease adjustments, in ease-factor points. */
export const EASE_DELTA: Record<RatingName, number> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.15,
};

/**
 * One deck's scheduling options. The defaults are Anki's out-of-the-box preset;
 * everything is injectable so tests can pin behaviour and so per-deck options
 * can be added later without touching the algorithm.
 */
export interface SchedulerConfig {
  /** Learning steps for a new card, in minutes. Anki's default: 1m, 10m. */
  learningSteps: number[];
  /** Relearning steps after a lapse, in minutes. Anki's default: 10m. */
  relearningSteps: number[];
  /** Interval given when a card graduates from the learning steps. */
  graduatingInterval: number;
  /** Interval given when `easy` skips the remaining learning steps. */
  easyInterval: number;
  /** Ease a new card graduates with (Anki's "starting ease", 250%). */
  initialEase: number;
  /** Ease floor (130%). Below this a card would collapse into a review loop. */
  minimumEase: number;
  /** `hard` multiplies the current interval by this instead of by ease. */
  hardMultiplier: number;
  /** `easy` multiplies the good interval by this on top of ease. */
  easyBonus: number;
  /** What a lapse leaves of the interval. Anki's default is 0%. */
  lapseMultiplier: number;
  /** Floor for the interval a lapsed card returns to. */
  minimumLapseInterval: number;
  /** Deck-wide scaling applied to every day-level interval. */
  intervalMultiplier: number;
  /** Hard cap on any interval, in days. */
  maximumInterval: number;
  /** Lapses before a card is flagged as a leech. */
  leechThreshold: number;
  /** Whether day-level intervals are randomised. Off makes tests exact. */
  fuzz: boolean;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  learningSteps: [1, 10],
  relearningSteps: [10],
  graduatingInterval: 1,
  easyInterval: 4,
  initialEase: DEFAULT_EASE_FACTOR,
  minimumEase: MIN_EASE_FACTOR,
  hardMultiplier: 1.2,
  easyBonus: 1.3,
  lapseMultiplier: 0,
  minimumLapseInterval: 1,
  intervalMultiplier: 1,
  maximumInterval: 36_500,
  leechThreshold: 8,
  fuzz: true,
};

/** Everything the scheduler reads from, and writes back to, a card. */
export interface SchedulingState {
  phase: CardPhase;
  /**
   * Day-level interval. Zero while a new card is still on its learning steps;
   * on a relearning card it is the interval waiting for it on graduation.
   */
  interval: number;
  easeFactor: number;
  /** Total answers given, matching Anki's `reps`. */
  repetitions: number;
  /** Times a review card has been failed, matching Anki's `lapses`. */
  lapses: number;
  /** Position in the active step list; 0 outside a (re)learning phase. */
  learningStep: number;
  nextReview: IsoDate;
  leech: boolean;
  status: CardStatus;
}

/** The local calendar day Anki considers "today". */
export function collectionDayKey(
  date: Date = new Date(),
  dayStartHour = DEFAULT_DAY_START_HOUR,
): string {
  const adjusted = new Date(date);
  if (adjusted.getHours() < dayStartHour) adjusted.setDate(adjusted.getDate() - 1);
  return `${adjusted.getFullYear()}-${String(adjusted.getMonth() + 1).padStart(2, '0')}-${String(adjusted.getDate()).padStart(2, '0')}`;
}

/** Add collection days without going through UTC arithmetic. */
export function addCollectionDays(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const result = new Date(year || 1970, (month || 1) - 1, date || 1, 12);
  result.setDate(result.getDate() + delta);
  return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}-${String(result.getDate()).padStart(2, '0')}`;
}

/** Start of the current collection day in local time. */
export function collectionDayStart(
  date: Date = new Date(),
  dayStartHour = DEFAULT_DAY_START_HOUR,
): Date {
  const start = new Date(date);
  start.setHours(dayStartHour, 0, 0, 0);
  if (date.getHours() < dayStartHour) start.setDate(start.getDate() - 1);
  return start;
}

/** Whether a card belongs in the normal due queue right now. */
export function isCardDue(
  card: Pick<Card, 'phase' | 'nextReview' | 'dueDay' | 'suspended' | 'buriedUntil'>,
  now: Date = new Date(),
): boolean {
  if (card.suspended) return false;
  if (card.buriedUntil && collectionDayKey(now) < card.buriedUntil) return false;
  const phase = card.phase ?? 'new';
  if (phase === 'review' && card.dueDay) {
    return collectionDayKey(now) >= card.dueDay || Date.parse(card.nextReview) <= now.getTime();
  }
  if ((phase === 'learning' || phase === 'relearning') && card.dueDay) {
    return collectionDayKey(now) > card.dueDay || Date.parse(card.nextReview) <= now.getTime();
  }
  return Date.parse(card.nextReview) <= now.getTime();
}

export interface ReviewOptions {
  /** Review time; injected so scheduling is deterministic in tests. */
  now?: Date;
  /** Per-deck overrides on top of {@link DEFAULT_SCHEDULER_CONFIG}. */
  config?: Partial<SchedulerConfig>;
  /** Uniform [0, 1) source for interval fuzz. Injected to pin tests. */
  random?: () => number;
}

/** Apply a rating to a card's scheduling state. */
export function review(
  state: SchedulingState,
  rating: RatingName,
  options: ReviewOptions = {},
): SchedulingState {
  const config = { ...DEFAULT_SCHEDULER_CONFIG, ...options.config };
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;

  return state.phase === 'review'
    ? answerReview(state, rating, config, now, random)
    : answerLearning(state, rating, config, now, random);
}

/**
 * New, learning and relearning cards.
 *
 * The three share one code path in Anki too: the only differences are which
 * step list applies and what interval graduation lands on. A new card is a
 * learning card that has not been answered yet.
 */
function answerLearning(
  state: SchedulingState,
  rating: RatingName,
  config: SchedulerConfig,
  now: Date,
  random: () => number,
): SchedulingState {
  const relearning = state.phase === 'relearning';
  const steps = relearning ? config.relearningSteps : config.learningSteps;
  const repetitions = state.repetitions + 1;

  // Easy always leaves the steps immediately. A relearning card returns to a
  // day more than the interval its lapse left it with; a new one takes the
  // easy interval outright.
  if (rating === 'easy') {
    const target = relearning ? state.interval + 1 : config.easyInterval;
    const minimum = relearning ? config.minimumLapseInterval : 1;
    return graduate(state, repetitions, constrain(target, minimum, config, random), now);
  }

  const step = nextStep(state.learningStep, rating, steps.length);

  // Good past the last step graduates: a learning card onto the graduating
  // interval, a relearning card back onto the interval its lapse computed.
  if (step >= steps.length) {
    const target = relearning ? state.interval : config.graduatingInterval;
    const minimum = relearning ? config.minimumLapseInterval : 1;
    return graduate(state, repetitions, constrain(target, minimum, config, random), now);
  }

  const delay = rating === 'hard' ? hardDelay(steps, step) : stepAt(steps, step);
  return {
    ...state,
    phase: relearning ? 'relearning' : 'learning',
    learningStep: step,
    interval: relearning ? state.interval : 0,
    repetitions,
    nextReview: after(now, delay * MS_PER_MINUTE),
    status: statusFor(relearning ? 'relearning' : 'learning', state.interval),
  };
}

/**
 * Where the next answer leaves a (re)learning card.
 *
 * `again` restarts the list, `good` advances (past the end means graduate) and
 * `hard` repeats the current step. Empty step lists graduate on the first pass,
 * which is how Anki treats a deck configured with no steps.
 */
function nextStep(current: number, rating: RatingName, stepCount: number): number {
  if (stepCount === 0) return 0;
  if (rating === 'again') return 0;
  if (rating === 'hard') return Math.min(current, stepCount - 1);
  return current + 1;
}

/**
 * Anki delays `hard` by the average of the first two steps while a card is on
 * the first step, and repeats the current step's delay after that. Averaging is
 * what keeps `hard` from being identical to `again` on a two-step deck.
 */
function hardDelay(steps: number[], step: number): number {
  const current = stepAt(steps, step);
  if (step > 0) return current;
  const second = steps.length > 1 ? stepAt(steps, 1) : undefined;
  return second === undefined ? current * 1.5 : (current + second) / 2;
}

function graduate(
  state: SchedulingState,
  repetitions: number,
  interval: number,
  now: Date,
): SchedulingState {
  return {
    ...state,
    phase: 'review',
    learningStep: 0,
    interval,
    repetitions,
    nextReview: after(now, interval * MS_PER_DAY),
    status: statusFor('review', interval),
  };
}

/** Review cards: the interval-times-ease branch, plus lapses. */
function answerReview(
  state: SchedulingState,
  rating: RatingName,
  config: SchedulerConfig,
  now: Date,
  random: () => number,
): SchedulingState {
  const repetitions = state.repetitions + 1;
  const easeFactor = clampEase(state.easeFactor + EASE_DELTA[rating], config);

  if (rating === 'again') return lapse(state, repetitions, easeFactor, config, now, random);

  // Intervals are computed from the ease the card had *before* this answer;
  // Anki updates ease afterwards.
  const [target, minimum] = passingInterval(state, rating, config, now);

  const interval = constrain(target, minimum, config, random);
  return {
    ...state,
    phase: 'review',
    learningStep: 0,
    interval,
    easeFactor,
    repetitions,
    nextReview: after(now, interval * MS_PER_DAY),
    status: statusFor('review', interval),
  };
}

/**
 * The hard / good / easy interval for a passing review answer, with the
 * minimum Anki enforces for it.
 *
 * The minimums form a chain — good must beat hard, easy must beat good — so a
 * low ease factor can never make a better answer schedule a shorter interval.
 */
function passingInterval(
  state: SchedulingState,
  rating: RatingName,
  config: SchedulerConfig,
  now: Date,
): [target: number, minimum: number] {
  const current = Math.max(1, state.interval);
  const daysLate = (now.getTime() - Date.parse(state.nextReview)) / MS_PER_DAY;
  const ease = state.easeFactor;

  if (daysLate < 0) return earlyInterval(current, daysLate, ease, rating, config);

  const late = Math.floor(daysLate);
  const hardMinimum = config.hardMultiplier > 1 ? current + 1 : 0;
  const hard = constrain(current * config.hardMultiplier, hardMinimum, config);
  if (rating === 'hard') return [current * config.hardMultiplier, hardMinimum];

  const goodMinimum = config.hardMultiplier > 1 ? hard + 1 : current + 1;
  const goodTarget = (current + late / 2) * ease;
  if (rating === 'good') return [goodTarget, goodMinimum];

  const good = constrain(goodTarget, goodMinimum, config);
  return [(current + late) * ease * config.easyBonus, good + 1];
}

/**
 * Answering a card before it is due — this app's study-ahead path, and Anki's
 * filtered decks.
 *
 * The principle is Anki's: credit the time that actually elapsed instead of the
 * interval that was scheduled, so studying ahead never earns the full
 * multiplier and the next interval can come out shorter than the last. The card
 * was answered before it was at risk of being forgotten, and it has proved
 * correspondingly less. The multipliers and the minimum chain are the ordinary
 * ones; only the term they multiply changes.
 */
function earlyInterval(
  current: number,
  daysLate: number,
  ease: number,
  rating: RatingName,
  config: SchedulerConfig,
): [target: number, minimum: number] {
  // `daysLate` is negative here, so this is the interval minus the time left.
  const elapsed = Math.max(1, current + daysLate);

  if (rating === 'hard') return [elapsed * config.hardMultiplier, 1];

  const hard = constrain(elapsed * config.hardMultiplier, 1, config);
  if (rating === 'good') return [elapsed * ease, hard + 1];

  const good = constrain(elapsed * ease, hard + 1, config);
  return [elapsed * ease * config.easyBonus, good + 1];
}

/**
 * A failed review card.
 *
 * The interval it will come back to is decided here, at lapse time, and carried
 * through the relearning steps in `interval` — that is how Anki can send a
 * relearned card straight back to a multi-day interval.
 */
function lapse(
  state: SchedulingState,
  repetitions: number,
  easeFactor: number,
  config: SchedulerConfig,
  now: Date,
  random: () => number,
): SchedulingState {
  const lapses = state.lapses + 1;
  const interval = constrain(
    state.interval * config.lapseMultiplier,
    config.minimumLapseInterval,
    config,
    random,
  );
  const leech = state.leech || lapses >= config.leechThreshold;

  // A deck with no relearning steps sends the card straight back to review.
  if (config.relearningSteps.length === 0) {
    return {
      ...state,
      phase: 'review',
      learningStep: 0,
      interval,
      easeFactor,
      repetitions,
      lapses,
      leech,
      nextReview: after(now, interval * MS_PER_DAY),
      status: statusFor('review', interval),
    };
  }

  return {
    ...state,
    phase: 'relearning',
    learningStep: 0,
    interval,
    easeFactor,
    repetitions,
    lapses,
    leech,
    nextReview: after(now, stepAt(config.relearningSteps, 0) * MS_PER_MINUTE),
    status: statusFor('relearning', interval),
  };
}

/**
 * Turn a raw interval into the one that gets scheduled: apply the deck's
 * multiplier, fuzz it, then hold it inside [minimum, maximumInterval].
 *
 * Passing no `random` skips fuzz, which is what the minimum chain in
 * {@link passingInterval} needs — those bounds have to be stable.
 */
function constrain(
  days: number,
  minimum: number,
  config: SchedulerConfig,
  random?: () => number,
): number {
  const scaled = days * config.intervalMultiplier;
  const value = random && config.fuzz ? fuzzed(scaled, minimum, config, random) : Math.round(scaled);
  return Math.min(config.maximumInterval, Math.max(minimum, value));
}

/**
 * Anki's interval fuzz: pick uniformly from a window that widens with the
 * interval — ±15% of the first week, ±10% out to three weeks, ±5% beyond.
 * Intervals under 2.5 days are left alone; there is nowhere for them to go.
 */
function fuzzed(
  interval: number,
  minimum: number,
  config: SchedulerConfig,
  random: () => number,
): number {
  const delta = fuzzDelta(interval);
  if (delta === 0) return Math.round(interval);

  const lower = Math.max(minimum, Math.round(interval - delta));
  const upper = Math.max(lower, Math.min(config.maximumInterval, Math.round(interval + delta)));
  return lower + Math.floor(random() * (upper - lower + 1));
}

function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0;
  let delta = 1;
  delta += 0.15 * (Math.min(interval, 7) - 2.5);
  if (interval > 7) delta += 0.1 * (Math.min(interval, 20) - 7);
  if (interval > 20) delta += 0.05 * (interval - 20);
  return delta;
}

function clampEase(ease: number, config: SchedulerConfig): number {
  return Math.max(config.minimumEase, Math.round(ease * 100) / 100);
}

function stepAt(steps: number[], index: number): number {
  return steps[index] ?? steps[steps.length - 1] ?? 1;
}

function after(now: Date, ms: number): IsoDate {
  return new Date(now.getTime() + ms).toISOString();
}

/**
 * The three-way status the UI shows. Anki's four phases collapse into it:
 * anything short of a review card at maturity is still being learned.
 */
export function statusFor(phase: CardPhase, interval: number): CardStatus {
  if (phase === 'new') return 'new';
  return phase === 'review' && interval >= MASTERED_INTERVAL_DAYS ? 'mastered' : 'learning';
}

/** Scheduling state for a freshly created card. */
export function newCardState(now: Date = new Date()): SchedulingState {
  return {
    phase: 'new',
    interval: 0,
    easeFactor: DEFAULT_SCHEDULER_CONFIG.initialEase,
    repetitions: 0,
    lapses: 0,
    learningStep: 0,
    nextReview: now.toISOString(),
    leech: false,
    status: 'new',
  };
}

/** Read a card's scheduling state, tolerating records written before v3. */
export function schedulingStateFor(card: Card): SchedulingState {
  const phase = card.phase ?? inferPhase(card);
  return {
    phase,
    interval: card.interval,
    easeFactor: card.easeFactor,
    repetitions: card.repetitions,
    lapses: card.lapses ?? 0,
    learningStep: card.learningStep ?? 0,
    nextReview: card.nextReview,
    leech: card.leech ?? false,
    status: card.status,
  };
}

/**
 * Fill in the scheduler fields for a card that predates them — one restored
 * from a backup, or synced from a device still running the old build. The old
 * model had no phase, so it is reconstructed from status and interval: an
 * unseen card is new, a card with a day-level interval is in review, and
 * anything else was mid-lapse.
 */
export function normalizeCard(card: Card): Card {
  const phase = card.phase ?? inferPhase(card);
  if (card.phase && card.lapses !== undefined && card.learningStep !== undefined && card.dueDay) {
    return card;
  }
  return {
    ...card,
    phase,
    lapses: card.lapses ?? 0,
    learningStep: card.learningStep ?? 0,
    status: card.status ?? statusFor(phase, card.interval),
    ...(card.dueDay
      ? { dueDay: card.dueDay }
      : phase === 'review'
        ? { dueDay: collectionDayKey(new Date(card.nextReview)) }
        : {}),
  };
}

function inferPhase(card: Card): CardPhase {
  if (card.status === 'new' && card.repetitions === 0) return 'new';
  return card.interval >= 1 ? 'review' : 'learning';
}

/** Apply a rating directly to a card, returning the updated card. */
export function reviewCard(card: Card, rating: RatingName, options: ReviewOptions = {}): Card {
  const now = options.now ?? new Date();
  const result = review(schedulingStateFor(card), rating, { ...options, now });
  return {
    ...card,
    phase: result.phase,
    interval: result.interval,
    easeFactor: result.easeFactor,
    repetitions: result.repetitions,
    lapses: result.lapses,
    learningStep: result.learningStep,
    nextReview: result.nextReview,
    dueDay:
      result.phase === 'review'
        ? addCollectionDays(collectionDayKey(now), Math.max(1, Math.round(result.interval)))
        : collectionDayKey(new Date(result.nextReview)),
    status: result.status,
    ...(result.leech ? { leech: true } : {}),
    lastModified: now.toISOString(),
    syncStatus: 'pending',
  };
}

/** Cards whose `nextReview` has come due, hardest-overdue first. */
export function dueCards(cards: Card[], now: Date = new Date()): Card[] {
  return cards
    .filter((card) => !card.deleted && isCardDue(card, now))
    .sort((a, b) => Date.parse(a.nextReview) - Date.parse(b.nextReview));
}

export type QueueBucket = 'learning' | 'review' | 'new';

export interface StudyQueueOptions {
  now?: Date;
  limit?: number;
  newCardsPerDay?: number | null;
  maxReviewsPerDay?: number | null;
  newCardsIntroducedToday?: number;
  reviewsAnsweredToday?: number;
}

export interface StudyQueue {
  cards: Card[];
  learning: number;
  review: number;
  new: number;
}

/**
 * Gather a normal Anki-style queue: learning first, then reviews, then new
 * cards. Daily limits are applied after the cards are classified, so a large
 * backlog cannot hide learning cards behind a new-card query.
 */
export function buildStudyQueue(cards: readonly Card[], options: StudyQueueOptions = {}): StudyQueue {
  const now = options.now ?? new Date();
  const live = cards.filter((card) => !card.deleted && !card.suspended && (!card.buriedUntil || card.buriedUntil <= collectionDayKey(now)));
  const learning = live
    .filter((card) => (card.phase === 'learning' || card.phase === 'relearning') && isCardDue(card, now))
    .sort(compareDue);
  const reviews = live.filter((card) => card.phase === 'review' && isCardDue(card, now)).sort(compareDue);
  // The caller supplies new cards in insertion order, matching Anki's default
  // insertion order. Their timestamps are not a useful ordering signal because
  // several can be created in the same operation.
  const newCards = live.filter(
    (card) => (card.phase ?? 'new') === 'new' && isCardDue(card, now) && !card.introducedAt,
  );

  const reviewAllowance = options.maxReviewsPerDay === null
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, (options.maxReviewsPerDay ?? 200) - (options.reviewsAnsweredToday ?? 0));
  const reviewCards = [...learning, ...reviews].slice(0, reviewAllowance);
  const newAllowance = options.newCardsPerDay === null
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, (options.newCardsPerDay ?? 20) - (options.newCardsIntroducedToday ?? 0));
  const result = [...reviewCards, ...newCards.slice(0, newAllowance)].slice(0, options.limit ?? 200);

  return {
    cards: result,
    learning: result.filter((card) => card.phase === 'learning' || card.phase === 'relearning').length,
    review: result.filter((card) => card.phase === 'review').length,
    new: result.filter((card) => (card.phase ?? 'new') === 'new').length,
  };
}

function compareDue(a: Card, b: Card): number {
  const byTime = Date.parse(a.nextReview) - Date.parse(b.nextReview);
  return byTime || a.id.localeCompare(b.id);
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
