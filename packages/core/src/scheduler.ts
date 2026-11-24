import type { Card, CardPhase, CardStatus, Deck, IsoDate, RatingName, SchedulerAlgorithm } from './types.js';
import {
  DEFAULT_DESIRED_RETENTION,
  clampRetention,
  fsrsInterval,
  memoryStateFromHistory,
  memoryStateFromSm2,
  nextMemoryState,
  type MemoryState,
} from './fsrs.js';

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
 *
 * Decks use **FSRS** by default, as Anki does once FSRS is switched on (see
 * `fsrs.ts`). The phases, learning steps, lapses, leeches, fuzz and queue are
 * the same; what changes is where a day-level interval comes from. Instead of
 * interval x ease, every answer updates the card's stability and difficulty,
 * and the interval is the wait that brings predicted recall down to the deck's
 * desired retention. Ease is left untouched under FSRS, as in Anki, so a deck
 * switched back to SM-2 carries on from where it was.
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
  dueDay?: string;
  leech: boolean;
  status: CardStatus;
  /** FSRS memory state. Absent until a card is first answered under FSRS. */
  stability?: number;
  difficulty?: number;
  /** When the card was last answered; FSRS measures elapsed time from it. */
  lastReviewedAt?: IsoDate;
}

/** Which scheduler a deck runs and, for FSRS, the retention it aims for. */
export interface DeckScheduling {
  algorithm: SchedulerAlgorithm;
  desiredRetention: number;
}

export const DEFAULT_SCHEDULER_ALGORITHM: SchedulerAlgorithm = 'fsrs';

/** A deck's scheduling choice, with defaults for decks that predate it. */
export function deckScheduling(
  deck?: Partial<Pick<Deck, 'scheduler' | 'desiredRetention'>> | null,
): DeckScheduling {
  return {
    algorithm: deck?.scheduler === 'sm2' ? 'sm2' : DEFAULT_SCHEDULER_ALGORITHM,
    desiredRetention: clampRetention(deck?.desiredRetention ?? DEFAULT_DESIRED_RETENTION),
  };
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
  /** Which scheduler to run. Defaults to FSRS, like every deck does. */
  algorithm?: SchedulerAlgorithm;
  /** FSRS's target probability of recall when a card comes due. */
  desiredRetention?: number;
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
  const fuzzFactor = config.fuzz ? random() : undefined;
  const algorithm = options.algorithm ?? DEFAULT_SCHEDULER_ALGORITHM;

  if (algorithm === 'fsrs') {
    return answerFsrs(
      state,
      rating,
      // FSRS intervals already aim at a retention; Anki hides the interval
      // multiplier under FSRS because scaling them would just miss the target.
      { ...config, intervalMultiplier: 1 },
      now,
      clampRetention(options.desiredRetention ?? DEFAULT_DESIRED_RETENTION),
      fuzzFactor,
    );
  }

  const answered = state.phase === 'review'
    ? answerReview(state, rating, config, now, fuzzFactor)
    : answerLearning(state, rating, config, now);
  return { ...answered, lastReviewedAt: now.toISOString() };
}

// --- FSRS --------------------------------------------------------------------

/**
 * One answer under FSRS.
 *
 * The memory state is updated on every answer, learning steps included — a
 * same-day answer goes through FSRS's short-term formula. Then the phase logic
 * is SM-2's, with every day-level interval read off the new stability.
 */
function answerFsrs(
  state: SchedulingState,
  rating: RatingName,
  config: SchedulerConfig,
  now: Date,
  retention: number,
  fuzzFactor?: number,
): SchedulingState {
  const memory = memoryStateFor(state);
  const elapsed = elapsedDaysFor(state, now);
  const next = nextMemoryState(memory, elapsed, rating);
  const remembered = {
    ...state,
    stability: next.stability,
    difficulty: next.difficulty,
    lastReviewedAt: now.toISOString(),
  };
  const intervalFor = (stability: number) => fsrsInterval(stability, retention);

  if (state.phase !== 'review') {
    return answerLearning(remembered, rating, config, now, {
      days: intervalFor(next.stability),
      fuzzFactor,
    });
  }

  const repetitions = state.repetitions + 1;
  if (rating === 'again') {
    const interval = constrain(intervalFor(next.stability), config.minimumLapseInterval, config, fuzzFactor);
    return lapseTo(remembered, repetitions, state.easeFactor, interval, config, now);
  }

  // Each passing grade gets the interval of its own memory state, then the
  // same chain SM-2 enforces: a better answer never schedules a shorter wait.
  const hardMemory = rating === 'hard' ? next : nextMemoryState(memory, elapsed, 'hard');
  const goodMemory = rating === 'good' ? next : nextMemoryState(memory, elapsed, 'good');
  const hard = constrain(intervalFor(hardMemory.stability), 1, config, fuzzFactor);
  const good = constrain(intervalFor(goodMemory.stability), hard + 1, config, fuzzFactor);
  const interval = rating === 'hard'
    ? hard
    : rating === 'good'
      ? good
      : constrain(intervalFor(next.stability), good + 1, config, fuzzFactor);

  return {
    ...remembered,
    phase: 'review',
    learningStep: 0,
    interval,
    repetitions,
    nextReview: reviewDueAt(now, interval),
    status: statusFor('review', interval),
  };
}

/**
 * A card's FSRS memory state, converting from SM-2 when it has none yet.
 *
 * New cards have no memory: their first answer initialises it. A card that
 * graduated under SM-2 gets Anki's interval-and-ease conversion. A card still
 * on its first learning steps has too little to convert and starts fresh.
 */
export function memoryStateFor(
  state: Pick<SchedulingState, 'phase' | 'stability' | 'difficulty' | 'easeFactor' | 'interval'>,
): MemoryState | undefined {
  if (isFiniteNumber(state.stability) && isFiniteNumber(state.difficulty)) {
    return { stability: state.stability, difficulty: state.difficulty };
  }
  if (state.phase === 'new') return undefined;
  if (state.interval >= 1) return memoryStateFromSm2(state.easeFactor, state.interval);
  return undefined;
}

/**
 * Whole collection days since the card was last answered, which is the unit
 * FSRS is fitted in. A card answered before this field existed is assumed to
 * have been answered one interval before it fell due, as Anki assumes.
 */
export function elapsedDaysFor(
  state: Pick<SchedulingState, 'phase' | 'lastReviewedAt' | 'dueDay' | 'interval' | 'nextReview'>,
  now: Date,
): number {
  const today = collectionDayKey(now);
  if (state.lastReviewedAt && Number.isFinite(Date.parse(state.lastReviewedAt))) {
    return Math.max(0, dayDiff(collectionDayKey(new Date(state.lastReviewedAt)), today));
  }
  if (state.phase === 'review' || state.phase === 'relearning') {
    const due = state.dueDay ?? collectionDayKey(new Date(state.nextReview));
    const reviewed = addCollectionDays(due, -Math.max(1, Math.round(state.interval)));
    return Math.max(0, dayDiff(reviewed, today));
  }
  return 0;
}

/** One past answer, as the review log records it. */
export interface ReviewHistoryEntry {
  rating: RatingName;
  reviewedAt: IsoDate;
}

/**
 * Give a card an FSRS memory state without rescheduling it.
 *
 * This is what Anki does when FSRS is switched on: due dates stay where SM-2
 * put them, and only the state the next answer builds on is filled in. When
 * the review log holds the card's whole history, it is replayed answer by
 * answer; otherwise (an Anki import, say) the SM-2 interval and ease are
 * converted. Returns null when there is nothing to convert: a new card, one
 * that already has a memory state, or one too early in learning to convert.
 */
export function convertCardToFsrs(
  card: Card,
  history: readonly ReviewHistoryEntry[] = [],
): Pick<Card, 'stability' | 'difficulty' | 'lastReviewedAt'> | null {
  if (isFiniteNumber(card.stability) && isFiniteNumber(card.difficulty)) return null;
  const phase = card.phase ?? schedulingStateFor(card).phase;
  if (phase === 'new') return null;

  const answers = history
    .filter((entry) => Number.isFinite(Date.parse(entry.reviewedAt)))
    .slice()
    .sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt));
  const last = answers[answers.length - 1];

  // A log at least as long as the card's answer count covers its whole life.
  if (last && answers.length >= card.repetitions) {
    const days = answers.map((entry) => collectionDayKey(new Date(entry.reviewedAt)));
    const memory = memoryStateFromHistory(
      answers.map((entry, index) => ({
        rating: entry.rating,
        elapsedDays: index === 0 ? 0 : Math.max(0, dayDiff(days[index - 1]!, days[index]!)),
      })),
    );
    if (memory) return { ...memory, lastReviewedAt: new Date(last.reviewedAt).toISOString() };
  }

  const memory = memoryStateFor({ ...schedulingStateFor(card), phase });
  if (!memory) return null;
  return {
    ...memory,
    ...(last ? { lastReviewedAt: new Date(last.reviewedAt).toISOString() } : {}),
  };
}

function dayDiff(from: string, to: string): number {
  return Math.round((dayForKey(to).getTime() - dayForKey(from).getTime()) / MS_PER_DAY);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
  /**
   * Under FSRS, the interval a graduating card gets — read off its updated
   * stability — in place of SM-2's graduating, easy and lapse intervals.
   */
  fsrsGraduation?: { days: number; fuzzFactor?: number },
): SchedulingState {
  const relearning = state.phase === 'relearning';
  const steps = relearning ? config.relearningSteps : config.learningSteps;
  const repetitions = state.repetitions + 1;
  const minimum = relearning ? config.minimumLapseInterval : 1;
  const fsrsDays = fsrsGraduation
    ? constrain(fsrsGraduation.days, minimum, config, fsrsGraduation.fuzzFactor)
    : undefined;

  // Easy always leaves the steps immediately. A relearning card returns to a
  // day more than the interval its lapse left it with; a new one takes the
  // easy interval outright.
  if (rating === 'easy') {
    const target = relearning ? state.interval + 1 : config.easyInterval;
    return graduate(state, repetitions, fsrsDays ?? constrain(target, minimum, config), now);
  }

  const step = nextStep(state.learningStep, rating, steps.length);

  // Good past the last step graduates: a learning card onto the graduating
  // interval, a relearning card back onto the interval its lapse computed.
  if (step >= steps.length) {
    const target = relearning ? state.interval : config.graduatingInterval;
    return graduate(state, repetitions, fsrsDays ?? constrain(target, minimum, config), now);
  }

  const delay = roundLearningDelay(rating === 'hard' ? hardDelay(steps, step) : stepAt(steps, step));
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
  return second === undefined ? Math.min(current * 1.5, current + 24 * 60) : (current + second) / 2;
}

function roundLearningDelay(minutes: number): number {
  return minutes > 24 * 60 ? Math.round(minutes / (24 * 60)) * 24 * 60 : minutes;
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
    nextReview: reviewDueAt(now, interval),
    status: statusFor('review', interval),
  };
}

/** Review cards: the interval-times-ease branch, plus lapses. */
function answerReview(
  state: SchedulingState,
  rating: RatingName,
  config: SchedulerConfig,
  now: Date,
  fuzzFactor?: number,
): SchedulingState {
  const repetitions = state.repetitions + 1;
  const easeFactor = clampEase(state.easeFactor + EASE_DELTA[rating], config);

  if (rating === 'again') return lapse(state, repetitions, easeFactor, config, now, fuzzFactor);

  // Intervals are computed from the ease the card had *before* this answer;
  // Anki updates ease afterwards.
  const [target, minimum, fuzz] = passingInterval(state, rating, config, now, fuzzFactor);

  const interval = constrain(target, minimum, config, fuzz);
  return {
    ...state,
    phase: 'review',
    learningStep: 0,
    interval,
    easeFactor,
    repetitions,
    nextReview: reviewDueAt(now, interval),
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
  fuzzFactor?: number,
): [target: number, minimum: number, fuzzFactor?: number] {
  const current = Math.max(1, state.interval);
  const daysLate = daysLateFor(state, now);
  const ease = state.easeFactor;

  if (daysLate < 0) return [...earlyInterval(current, daysLate, ease, rating, config), undefined];

  const late = Math.floor(daysLate);
  const hardMinimum = config.hardMultiplier > 1 ? current + 1 : 0;
  const hard = constrain(current * config.hardMultiplier, hardMinimum, config, fuzzFactor);
  // `hard` is already constrained/fuzzed because good/easy use it as their
  // lower bound. Do not fuzz it a second time in answerReview.
  if (rating === 'hard') return [hard, hard, undefined];

  const goodMinimum = config.hardMultiplier > 1 ? hard + 1 : current + 1;
  const goodTarget = (current + late / 2) * ease;
  if (rating === 'good') return [goodTarget, goodMinimum, fuzzFactor];

  const good = constrain(goodTarget, goodMinimum, config, fuzzFactor);
  return [(current + late) * ease * config.easyBonus, good + 1, fuzzFactor];
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
  const hardTarget = Math.max(elapsed * config.hardMultiplier, current * (config.hardMultiplier / 2));

  if (rating === 'hard') return [hardTarget, 1];

  const hard = constrain(hardTarget, 1, config);
  const goodTarget = Math.max(elapsed * ease, current);
  if (rating === 'good') return [goodTarget, hard + 1];

  const good = constrain(goodTarget, hard + 1, config);
  const reducedEasyBonus = config.easyBonus - (config.easyBonus - 1) / 2;
  return [goodTarget * reducedEasyBonus, good + 1];
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
  fuzzFactor?: number,
): SchedulingState {
  const interval = constrain(
    state.interval * config.lapseMultiplier,
    config.minimumLapseInterval,
    config,
    fuzzFactor,
  );
  return lapseTo(state, repetitions, easeFactor, interval, config, now);
}

/**
 * Put a failed review card into relearning, waiting to return to `interval`.
 * Shared by SM-2 and FSRS, which differ only in how that interval is decided.
 */
function lapseTo(
  state: SchedulingState,
  repetitions: number,
  easeFactor: number,
  interval: number,
  config: SchedulerConfig,
  now: Date,
): SchedulingState {
  const lapses = state.lapses + 1;
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
      nextReview: reviewDueAt(now, interval),
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
 * Passing no `fuzzFactor` skips fuzz, which is what the minimum chain in
 * {@link passingInterval} needs — those bounds have to be stable.
 */
function constrain(
  days: number,
  minimum: number,
  config: SchedulerConfig,
  fuzzFactor?: number,
): number {
  const scaled = days * config.intervalMultiplier;
  const value = fuzzFactor !== undefined && config.fuzz
    ? fuzzed(scaled, minimum, config, fuzzFactor)
    : Math.round(scaled);
  return Math.min(config.maximumInterval, Math.max(1, minimum, value));
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
  fuzzFactor: number,
): number {
  const delta = fuzzDelta(interval);
  if (delta === 0) return Math.round(interval);

  const lower = Math.max(1, minimum, Math.round(interval - delta));
  let upper = Math.max(lower, Math.min(config.maximumInterval, Math.round(interval + delta)));
  if (upper === lower && upper > 2 && upper < config.maximumInterval) upper = lower + 1;
  return lower + Math.floor(fuzzFactor * (upper - lower + 1));
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

function reviewDueAt(now: Date, interval: number): IsoDate {
  const dueDay = addCollectionDays(collectionDayKey(now), Math.max(1, Math.round(interval)));
  return collectionDayStart(dayForKey(dueDay)).toISOString();
}

function dayForKey(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year || 1970, (month || 1) - 1, date || 1, 12);
}

function daysLateFor(state: SchedulingState, now: Date): number {
  const timestampDelta = (now.getTime() - Date.parse(state.nextReview)) / MS_PER_DAY;
  if (timestampDelta < 0) return timestampDelta;
  if (!state.dueDay) return timestampDelta;
  const current = dayForKey(collectionDayKey(now)).getTime();
  const scheduled = dayForKey(state.dueDay).getTime();
  return Math.round((current - scheduled) / MS_PER_DAY);
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
    dueDay: collectionDayKey(now),
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
    dueDay: card.dueDay,
    leech: card.leech ?? false,
    status: card.status,
    ...(card.stability !== undefined ? { stability: card.stability } : {}),
    ...(card.difficulty !== undefined ? { difficulty: card.difficulty } : {}),
    ...(card.lastReviewedAt ? { lastReviewedAt: card.lastReviewedAt } : {}),
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
  if (
    card.phase &&
    card.lapses !== undefined &&
    card.learningStep !== undefined &&
    card.dueDay &&
    card.grammarNotes !== undefined &&
    card.relatedWords !== undefined &&
    card.tags !== undefined
  ) {
    return card;
  }
  return {
    ...card,
    grammarNotes: card.grammarNotes ?? [],
    relatedWords: card.relatedWords ?? [],
    tags: card.tags ?? [],
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
  const result = review(schedulingStateFor(card), rating, {
    ...options,
    now,
    random: options.random ?? fuzzRandomForCard(card.id),
  });
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
    ...(result.stability !== undefined ? { stability: result.stability } : {}),
    ...(result.difficulty !== undefined ? { difficulty: result.difficulty } : {}),
    ...(result.lastReviewedAt ? { lastReviewedAt: result.lastReviewedAt } : {}),
    lastModified: now.toISOString(),
    syncStatus: 'pending',
  };
}

/** Stable per-card fuzz source so the interval preview and saved answer agree. */
export function fuzzRandomForCard(cardId: string): () => number {
  cardId = String(cardId ?? '');
  let hash = 2166136261;
  for (let i = 0; i < cardId.length; i++) {
    hash ^= cardId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return () => (hash >>> 0) / 4_294_967_296;
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
  newCardsIgnoreReviewLimit?: boolean;
}

export interface StudyQueue {
  cards: Card[];
  learning: number;
  review: number;
  new: number;
  /** Learning/relearning cards whose next-step timer has not elapsed yet. */
  pendingLearning: number;
  /** Earliest pending learning step, when one exists. */
  nextLearningAt?: IsoDate;
}

/**
 * Gather a normal Anki-style queue: intraday learning first, then interday
 * learning/reviews sharing the review allowance, then new cards. New-card and
 * review limits are independent, so a full review queue does not suppress the
 * day's new-card allowance.
 */
export function buildStudyQueue(cards: readonly Card[], options: StudyQueueOptions = {}): StudyQueue {
  const now = options.now ?? new Date();
  const live = cards.filter((card) => !card.deleted && !card.suspended && (!card.buriedUntil || card.buriedUntil <= collectionDayKey(now)));
  const learning = live
    .filter((card) => (card.phase === 'learning' || card.phase === 'relearning') && isCardDue(card, now))
    .sort(compareDue);
  const reviews = live.filter((card) => card.phase === 'review' && isCardDue(card, now)).sort(compareDue);
  const interdayLearning = learning.filter((card) => isInterdayLearningCard(card, now));
  const intradayLearning = learning.filter((card) => !isInterdayLearningCard(card, now));
  // The caller supplies new cards in insertion order, matching Anki's default
  // insertion order. Their timestamps are not a useful ordering signal because
  // several can be created in the same operation.
  const newCards = live.filter(
    (card) => (card.phase ?? 'new') === 'new' && isCardDue(card, now) && !card.introducedAt,
  );
  const pendingLearningCards = live
    .filter(
      (card) =>
        (card.phase === 'learning' || card.phase === 'relearning') &&
        !isCardDue(card, now),
    )
    .sort(compareDue);

  const reviewAllowance = options.maxReviewsPerDay === null
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, (options.maxReviewsPerDay ?? 50) - (options.reviewsAnsweredToday ?? 0));
  const reviewCards = [...interdayLearning, ...reviews].slice(0, reviewAllowance);
  const newAllowance = options.newCardsPerDay === null
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, (options.newCardsPerDay ?? 20) - (options.newCardsIntroducedToday ?? 0));
  const newCapacity = newAllowance;
  const result = [...intradayLearning, ...reviewCards, ...newCards.slice(0, newCapacity)].slice(0, options.limit ?? 200);

  return {
    cards: result,
    learning: result.filter((card) => card.phase === 'learning' || card.phase === 'relearning').length,
    review: result.filter((card) => card.phase === 'review').length,
    new: result.filter((card) => (card.phase ?? 'new') === 'new').length,
    pendingLearning: pendingLearningCards.length,
    ...(pendingLearningCards[0] ? { nextLearningAt: pendingLearningCards[0].nextReview } : {}),
  };
}

export function isInterdayLearningCard(
  card: Pick<Card, 'phase' | 'nextReview' | 'dueDay'>,
  now: Date,
): boolean {
  return (card.phase === 'learning' || card.phase === 'relearning') &&
    Boolean(card.dueDay && collectionDayKey(now) > card.dueDay);
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
