/**
 * FSRS-6, the memory model behind Anki's optional "FSRS" scheduler, ported
 * from `fsrs-rs` (the Rust crate Anki links).
 *
 * SM-2 moves a card's interval by fixed multipliers. FSRS instead keeps two
 * numbers per card and predicts recall from them:
 *
 *  - **Stability (S)**, in days: how long until the chance of recalling the
 *    card falls to 90%.
 *  - **Difficulty (D)**, from 1 to 10: how hard the card is to make stick. It
 *    decides how much a successful review grows stability.
 *
 * Every answer updates S and D. The next interval is then whatever wait brings
 * the predicted recall down to the deck's *desired retention*. That is the
 * whole trick: intervals follow the forgetting curve the model predicts for
 * the card rather than a fixed multiplier.
 *
 * The 21 weights below are FSRS-6's published defaults, fitted on millions of
 * Anki reviews. Anki can refit them on one user's history; this app uses the
 * defaults, which Anki's own benchmark still ranks well ahead of SM-2.
 */

import type { RatingName } from './types.js';

export const FSRS_DEFAULT_PARAMETERS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

/** Anki's default desired retention. */
export const DEFAULT_DESIRED_RETENTION = 0.9;
/** The range Anki's deck options allow for desired retention. */
export const MIN_DESIRED_RETENTION = 0.7;
export const MAX_DESIRED_RETENTION = 0.97;

export const FSRS_MIN_STABILITY = 0.001;
export const FSRS_MAX_STABILITY = 36_500;
export const FSRS_MIN_DIFFICULTY = 1;
export const FSRS_MAX_DIFFICULTY = 10;

/**
 * Anki's assumed retention under SM-2, used when converting a card that has
 * only SM-2 state. At 0.9 the conversion maps interval straight to stability.
 */
const SM2_RETENTION = 0.9;

export interface MemoryState {
  stability: number;
  difficulty: number;
}

const GRADE: Record<RatingName, 1 | 2 | 3 | 4> = { again: 1, hard: 2, good: 3, easy: 4 };

function w(index: number, params: readonly number[]): number {
  return params[index] ?? FSRS_DEFAULT_PARAMETERS[index] ?? 0;
}

function decay(params: readonly number[]): number {
  return -w(20, params);
}

/** Chosen so that R(S, S) = 90% whatever the decay. */
function curveFactor(params: readonly number[]): number {
  return Math.pow(0.9, 1 / decay(params)) - 1;
}

/** Predicted probability of recall `elapsedDays` after the last review. */
export function retrievability(
  elapsedDays: number,
  stability: number,
  params: readonly number[] = FSRS_DEFAULT_PARAMETERS,
): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (curveFactor(params) * Math.max(0, elapsedDays)) / stability, decay(params));
}

/**
 * The wait, in days, that brings recall down to `desiredRetention`. It is not
 * rounded and has no floor; the scheduler constrains and fuzzes it.
 */
export function fsrsInterval(
  stability: number,
  desiredRetention: number = DEFAULT_DESIRED_RETENTION,
  params: readonly number[] = FSRS_DEFAULT_PARAMETERS,
): number {
  const retention = clampRetention(desiredRetention);
  return (stability / curveFactor(params)) * (Math.pow(retention, 1 / decay(params)) - 1);
}

export function clampRetention(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DESIRED_RETENTION;
  return Math.min(MAX_DESIRED_RETENTION, Math.max(MIN_DESIRED_RETENTION, value));
}

function initialStability(grade: number, params: readonly number[]): number {
  return clampStability(w(grade - 1, params));
}

/** Not clamped: mean reversion targets the raw value for `easy`. */
function rawInitialDifficulty(grade: number, params: readonly number[]): number {
  return w(4, params) - Math.exp(w(5, params) * (grade - 1)) + 1;
}

function nextDifficulty(difficulty: number, grade: number, params: readonly number[]): number {
  const delta = -w(6, params) * (grade - 3);
  // Linear damping: changes shrink as difficulty approaches 10.
  const damped = difficulty + (delta * (10 - difficulty)) / 9;
  // Mean reversion towards the difficulty of a card first answered `easy`.
  const reverted = w(7, params) * (rawInitialDifficulty(4, params) - damped) + damped;
  return clampDifficulty(reverted);
}

function recallStability(
  { stability, difficulty }: MemoryState,
  recall: number,
  grade: number,
  params: readonly number[],
): number {
  const hardPenalty = grade === 2 ? w(15, params) : 1;
  const easyBonus = grade === 4 ? w(16, params) : 1;
  return stability * (
    Math.exp(w(8, params)) *
      (11 - difficulty) *
      Math.pow(stability, -w(9, params)) *
      (Math.exp(w(10, params) * (1 - recall)) - 1) *
      hardPenalty *
      easyBonus +
    1
  );
}

function forgetStability(
  { stability, difficulty }: MemoryState,
  recall: number,
  params: readonly number[],
): number {
  const next =
    w(11, params) *
    Math.pow(difficulty, -w(12, params)) *
    (Math.pow(stability + 1, w(13, params)) - 1) *
    Math.exp(w(14, params) * (1 - recall));
  // A lapse can never leave a card more stable than a same-day `again` would.
  return Math.min(next, stability / Math.exp(w(17, params) * w(18, params)));
}

/** Reviews on the same day as the last one: FSRS-6's short-term formula. */
function shortTermStability(stability: number, grade: number, params: readonly number[]): number {
  let increase = Math.exp(w(17, params) * (grade - 3 + w(18, params))) * Math.pow(stability, -w(19, params));
  if (grade >= 3) increase = Math.max(increase, 1);
  return stability * increase;
}

/**
 * The memory state after answering `rating`, `elapsedDays` whole days after
 * the previous answer. Pass no `memory` for a card's very first answer.
 */
export function nextMemoryState(
  memory: MemoryState | undefined,
  elapsedDays: number,
  rating: RatingName,
  params: readonly number[] = FSRS_DEFAULT_PARAMETERS,
): MemoryState {
  const grade = GRADE[rating];
  if (!memory) {
    return {
      stability: initialStability(grade, params),
      difficulty: clampDifficulty(rawInitialDifficulty(grade, params)),
    };
  }

  const current = {
    stability: clampStability(memory.stability),
    difficulty: clampDifficulty(memory.difficulty),
  };
  let stability: number;
  if (elapsedDays <= 0) {
    stability = shortTermStability(current.stability, grade, params);
  } else {
    const recall = retrievability(elapsedDays, current.stability, params);
    stability = grade === 1
      ? forgetStability(current, recall, params)
      : recallStability(current, recall, grade, params);
  }
  return {
    stability: clampStability(stability),
    difficulty: nextDifficulty(current.difficulty, grade, params),
  };
}

/**
 * Anki's conversion for a card that only has SM-2 state (`memory_state_from_sm2`
 * in fsrs-rs): treat the interval as the stability SM-2 aimed for at 90%
 * retention, and read difficulty back from how fast ease was growing it.
 */
export function memoryStateFromSm2(
  easeFactor: number,
  interval: number,
  params: readonly number[] = FSRS_DEFAULT_PARAMETERS,
): MemoryState {
  const stability = clampStability(
    (Math.max(FSRS_MIN_STABILITY, interval) * curveFactor(params)) /
      (Math.pow(SM2_RETENTION, 1 / decay(params)) - 1),
  );
  const growth =
    Math.exp(w(8, params)) *
    Math.pow(stability, -w(9, params)) *
    Math.expm1((1 - SM2_RETENTION) * w(10, params));
  const difficulty = 11 - (Math.max(1, easeFactor) - 1) / growth;
  return { stability, difficulty: clampDifficulty(difficulty) };
}

/**
 * Replay a card's answers from its first one. Each entry's `elapsedDays` is
 * whole collection days since the previous answer (ignored for the first).
 */
export function memoryStateFromHistory(
  answers: readonly { rating: RatingName; elapsedDays: number }[],
  params: readonly number[] = FSRS_DEFAULT_PARAMETERS,
): MemoryState | undefined {
  let memory: MemoryState | undefined;
  for (const answer of answers) {
    memory = nextMemoryState(memory, memory ? answer.elapsedDays : 0, answer.rating, params);
  }
  return memory;
}

function clampStability(value: number): number {
  if (!Number.isFinite(value)) return FSRS_MIN_STABILITY;
  return Math.min(FSRS_MAX_STABILITY, Math.max(FSRS_MIN_STABILITY, value));
}

function clampDifficulty(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(FSRS_MAX_DIFFICULTY, Math.max(FSRS_MIN_DIFFICULTY, value));
}
