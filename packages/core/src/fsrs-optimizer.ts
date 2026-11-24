/**
 * Fit FSRS-6's 21 weights to one learner's review history.
 *
 * This follows what Anki's "Optimize" button does through fsrs-rs, simplified
 * to fit a review log of a few thousand answers:
 *
 *  - Each card's answers are replayed in order. Every answer given at least a
 *    day after the previous one is a prediction to score: the model's
 *    probability of recall then, against whether the answer was a pass
 *    (anything but `again`). Same-day answers are not scored, but they still
 *    move the memory state, which is how the short-term weights get trained.
 *  - The loss is mean log loss, plus a pull towards the default weights scaled
 *    by each weight's spread across Anki users. With little history the
 *    defaults dominate; with a lot, the learner's own data does.
 *  - Weights are fitted by Adam with a cosine-decayed learning rate of 0.04
 *    (fsrs-rs's own) on finite-difference gradients, and clipped to fsrs-rs's
 *    bounds after every step.
 *  - New weights are only kept when they predict the learner's reviews better
 *    than the weights in use, measured on the whole history — again as Anki
 *    does.
 *
 * Only cards whose whole history is in the log are used: a card whose early
 * answers are missing (an Anki import) would be replayed from the wrong state.
 */

import type { IsoDate, RatingName } from './types.js';
import { FSRS_DEFAULT_PARAMETERS, nextMemoryState, retrievability, type MemoryState } from './fsrs.js';

/** One card's answers in order, with whole days since the previous answer. */
export type FsrsTrainingItem = { rating: RatingName; elapsedDays: number; reviewedAt: IsoDate }[];

/** Fewer scored answers than this and the defaults are kept untouched. */
export const MIN_OPTIMIZE_REVIEWS = 400;

/** Spread of each weight across Anki users (fsrs-rs), for the pull to the defaults. */
const PARAMETER_SPREAD: readonly number[] = [
  6.43, 9.66, 17.58, 27.85, 0.57, 0.28, 0.6, 0.12, 0.39, 0.18, 0.33,
  0.3, 0.09, 0.16, 0.57, 0.25, 1.03, 0.31, 0.32, 0.14, 0.27,
];

/** fsrs-rs's clipping bounds for FSRS-6. */
const BOUNDS: readonly (readonly [number, number])[] = [
  [0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100],
  [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75],
  [0, 4.5], [0, 0.8], [0.001, 3.5],
  [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4],
  [0, 1], [1, 6],
  [0, 2], [0, 2], [0, 0.8], [0.1, 0.8],
];

export interface FsrsEvaluation {
  /** Mean log loss over scored answers. Lower is better. */
  logLoss: number;
  /** Calibration error: predicted vs actual recall, in 20 bins of prediction. */
  rmse: number;
  /** How many answers were scored. */
  reviews: number;
}

export interface OptimizeOptions {
  /** Weights to start from and to compare against. Defaults to FSRS-6's. */
  initial?: readonly number[];
  /** Adam steps over the whole history. */
  iterations?: number;
  /** Only score answers before this instant (for a time-split holdout). */
  trainBefore?: IsoDate;
  /** Multiplier on the pull towards the default weights. */
  regularization?: number;
  /** Called after each step; return a promise to yield to the event loop. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export interface OptimizeResult {
  parameters: number[];
  /** True when the fitted weights beat `initial` and are worth saving. */
  improved: boolean;
  before: FsrsEvaluation;
  after: FsrsEvaluation;
}

/**
 * Turn review-log entries into per-card training items. `dayKey` maps an
 * instant to its collection day (YYYY-MM-DD), so elapsed time is counted in
 * the same days the scheduler uses.
 */
export function fsrsTrainingItems(
  histories: Iterable<readonly { rating: RatingName; reviewedAt: IsoDate }[]>,
  dayKey: (instant: Date) => string,
): FsrsTrainingItem[] {
  const items: FsrsTrainingItem[] = [];
  for (const history of histories) {
    const answers = history
      .filter((entry) => Number.isFinite(Date.parse(entry.reviewedAt)))
      .slice()
      .sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt));
    if (answers.length < 2) continue;
    let previousDay: string | undefined;
    items.push(answers.map((entry) => {
      const day = dayKey(new Date(entry.reviewedAt));
      const elapsedDays = previousDay ? Math.max(0, daysBetween(previousDay, day)) : 0;
      previousDay = day;
      return { rating: entry.rating, elapsedDays, reviewedAt: entry.reviewedAt };
    }));
  }
  return items;
}

/** How many answers an optimization would score. */
export function countScoredReviews(items: readonly FsrsTrainingItem[], before?: IsoDate): number {
  const cutoff = before ? Date.parse(before) : Infinity;
  let count = 0;
  for (const item of items) {
    for (let i = 1; i < item.length; i++) {
      const answer = item[i]!;
      if (answer.elapsedDays > 0 && Date.parse(answer.reviewedAt) < cutoff) count++;
    }
  }
  return count;
}

/**
 * Score weights against a history. `from`/`before` restrict which answers are
 * scored (by instant); memory states are always built from the full sequence.
 */
export function evaluateFsrs(
  parameters: readonly number[],
  items: readonly FsrsTrainingItem[],
  window: { from?: IsoDate; before?: IsoDate } = {},
): FsrsEvaluation {
  const from = window.from ? Date.parse(window.from) : -Infinity;
  const before = window.before ? Date.parse(window.before) : Infinity;
  let loss = 0;
  let reviews = 0;
  const bins = Array.from({ length: 20 }, () => ({ predicted: 0, actual: 0, count: 0 }));

  forEachPrediction(parameters, items, (recall, passed, at) => {
    if (at < from || at >= before) return;
    loss += logLoss(recall, passed);
    reviews++;
    const bin = bins[Math.min(19, Math.floor(recall * 20))]!;
    bin.predicted += recall;
    bin.actual += passed ? 1 : 0;
    bin.count++;
  });

  let squared = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    squared += bin.count * ((bin.predicted - bin.actual) / bin.count) ** 2;
  }
  return {
    logLoss: reviews ? loss / reviews : 0,
    rmse: reviews ? Math.sqrt(squared / reviews) : 0,
    reviews,
  };
}

/** Fit weights to `items`. Resolves with the defaults when there is too little data. */
export async function optimizeFsrs(
  items: readonly FsrsTrainingItem[],
  options: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const initial = clip([...(options.initial ?? FSRS_DEFAULT_PARAMETERS)]);
  const window = options.trainBefore ? { before: options.trainBefore } : {};
  const before = evaluateFsrs(initial, items, window);
  if (before.reviews < MIN_OPTIMIZE_REVIEWS) {
    return { parameters: initial, improved: false, before, after: before };
  }

  const total = options.iterations ?? 250;
  const cutoff = options.trainBefore ? Date.parse(options.trainBefore) : Infinity;
  const strength = options.regularization ?? 1;
  const objective = (w: readonly number[]) =>
    trainingLoss(w, items, cutoff, before.reviews / strength);

  let w = [...initial];
  const m = new Array<number>(w.length).fill(0);
  const v = new Array<number>(w.length).fill(0);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;

  for (let step = 1; step <= total; step++) {
    const gradient = finiteDifference(objective, w);
    const rate = 0.04 * 0.5 * (1 + Math.cos((Math.PI * (step - 1)) / total));
    for (let i = 0; i < w.length; i++) {
      const g = gradient[i]!;
      m[i] = beta1 * m[i]! + (1 - beta1) * g;
      v[i] = beta2 * v[i]! + (1 - beta2) * g * g;
      const mHat = m[i]! / (1 - beta1 ** step);
      const vHat = v[i]! / (1 - beta2 ** step);
      w[i] = w[i]! - (rate * mHat) / (Math.sqrt(vHat) + epsilon);
    }
    w = clip(w);
    await options.onProgress?.(step, total);
  }

  const parameters = w.map((value) => Math.round(value * 10_000) / 10_000);
  const after = evaluateFsrs(parameters, items, window);
  return { parameters, improved: after.logLoss < before.logLoss, before, after };
}

// --- internals -------------------------------------------------------------

function forEachPrediction(
  parameters: readonly number[],
  items: readonly FsrsTrainingItem[],
  visit: (recall: number, passed: boolean, at: number) => void,
): void {
  for (const item of items) {
    let memory: MemoryState | undefined;
    for (const answer of item) {
      if (memory && answer.elapsedDays > 0) {
        visit(
          retrievability(answer.elapsedDays, memory.stability, parameters),
          answer.rating !== 'again',
          Date.parse(answer.reviewedAt),
        );
      }
      memory = nextMemoryState(memory, memory ? answer.elapsedDays : 0, answer.rating, parameters);
    }
  }
}

function trainingLoss(
  w: readonly number[],
  items: readonly FsrsTrainingItem[],
  cutoff: number,
  reviews: number,
): number {
  let loss = 0;
  let count = 0;
  forEachPrediction(w, items, (recall, passed, at) => {
    if (at >= cutoff) return;
    loss += logLoss(recall, passed);
    count++;
  });
  let penalty = 0;
  for (let i = 0; i < w.length; i++) {
    const spread = PARAMETER_SPREAD[i] ?? 1;
    penalty += ((w[i]! - FSRS_DEFAULT_PARAMETERS[i]!) / spread) ** 2;
  }
  return (count ? loss / count : 0) + penalty / Math.max(1, reviews);
}

function finiteDifference(f: (w: readonly number[]) => number, w: readonly number[]): number[] {
  const gradient = new Array<number>(w.length).fill(0);
  const probe = [...w];
  for (let i = 0; i < w.length; i++) {
    const [low, high] = BOUNDS[i]!;
    const h = Math.max(1e-5, Math.abs(w[i]!) * 1e-4);
    const up = Math.min(high, w[i]! + h);
    const down = Math.max(low, w[i]! - h);
    if (up === down) continue;
    probe[i] = up;
    const fUp = f(probe);
    probe[i] = down;
    const fDown = f(probe);
    probe[i] = w[i]!;
    gradient[i] = (fUp - fDown) / (up - down);
  }
  return gradient;
}

function clip(w: number[]): number[] {
  const clipped = w.map((value, i) => {
    const [low, high] = BOUNDS[i] ?? [-Infinity, Infinity];
    return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : FSRS_DEFAULT_PARAMETERS[i]!;
  });
  // Initial stability must not fall as the first answer gets better.
  for (let i = 1; i < 4; i++) clipped[i] = Math.max(clipped[i]!, clipped[i - 1]!);
  return clipped;
}

function logLoss(recall: number, passed: boolean): number {
  const p = Math.min(1 - 1e-7, Math.max(1e-7, recall));
  return -(passed ? Math.log(p) : Math.log(1 - p));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}
