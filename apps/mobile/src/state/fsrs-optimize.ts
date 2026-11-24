import {
  FSRS_DEFAULT_PARAMETERS,
  MIN_OPTIMIZE_REVIEWS,
  collectionDayKey,
  countScoredReviews,
  evaluateFsrs,
  fsrsTrainingItems,
  optimizeFsrs,
  type FsrsOptimization,
  type FsrsTrainingItem,
} from '@fluentflow/core';
import type { Repository } from '../db/repository';

/** Re-optimize once the scored history has grown by this much. */
const REOPTIMIZE_GROWTH = 1.25;
/** The newest share of scored reviews held out to judge a fit. */
const HOLDOUT_SHARE = 0.2;

export type FsrsOptimizeOutcome =
  | { status: 'skipped'; reason: 'not-enough-reviews' | 'up-to-date'; reviews: number }
  | { status: 'kept' | 'updated'; result: FsrsOptimization };

/**
 * Fit FSRS to this account's review history and save the weights if they
 * predict better than the ones in use.
 *
 * The bar is prediction of the *future*: weights are fitted on all but the
 * newest fifth of scored reviews, then scored on that fifth against the
 * weights in use. Only a fit that wins there is refitted on everything and
 * saved; otherwise the current weights (often the defaults) stay. A short
 * history overfits easily, and this is what stops that from making the
 * schedule worse.
 *
 * Without `force`, it runs only when the history has grown enough since the
 * last attempt, so calling it on every launch is cheap.
 */
export async function optimizeFsrsForAccount(
  repository: Repository,
  userId: string,
  options: { force?: boolean; onProgress?: (fraction: number) => void } = {},
): Promise<FsrsOptimizeOutcome> {
  const items = fsrsTrainingItems(await repository.fsrsHistories(userId), (instant) => collectionDayKey(instant));
  const reviews = countScoredReviews(items);
  const current = (await repository.getSettings(userId)).fsrs?.value;

  if (reviews < MIN_OPTIMIZE_REVIEWS) return { status: 'skipped', reason: 'not-enough-reviews', reviews };
  if (!options.force && current && reviews < current.reviews * REOPTIMIZE_GROWTH) {
    return { status: 'skipped', reason: 'up-to-date', reviews };
  }

  const inUse = current?.parameters ?? [...FSRS_DEFAULT_PARAMETERS];
  const cutoff = holdoutCutoff(items);
  // Two fits share the progress bar: the held-out check, then the final one.
  const progress = (offset: number) => async (done: number, total: number) => {
    options.onProgress?.((offset + done / total) / 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const trial = await optimizeFsrs(items, { trainBefore: cutoff, onProgress: progress(0) });
  const holdout = { from: cutoff };
  const trialLoss = evaluateFsrs(trial.parameters, items, holdout).logLoss;
  const inUseLoss = evaluateFsrs(inUse, items, holdout).logLoss;
  const defaultLoss = evaluateFsrs(FSRS_DEFAULT_PARAMETERS, items, holdout).logLoss;

  let result: FsrsOptimization;
  let status: 'kept' | 'updated';
  if (trial.improved && trialLoss < inUseLoss) {
    const final = await optimizeFsrs(items, { onProgress: progress(1) });
    result = { parameters: final.parameters, reviews, logLoss: round(trialLoss), defaultLogLoss: round(defaultLoss) };
    status = 'updated';
  } else {
    result = {
      parameters: current?.parameters ?? null,
      reviews,
      logLoss: round(inUseLoss),
      defaultLogLoss: round(defaultLoss),
    };
    status = 'kept';
  }
  options.onProgress?.(1);
  await repository.saveSettings(userId, { fsrs: result });
  if (status === 'updated' && result.parameters) {
    await repository.recomputeFsrsMemory(userId, result.parameters);
  }
  return { status, result };
}

/** The instant before which all but the newest fifth of scored reviews fall. */
function holdoutCutoff(items: readonly FsrsTrainingItem[]): string {
  const scored: number[] = [];
  for (const item of items) {
    for (let i = 1; i < item.length; i++) {
      if (item[i]!.elapsedDays > 0) scored.push(Date.parse(item[i]!.reviewedAt));
    }
  }
  scored.sort((a, b) => a - b);
  const index = Math.min(scored.length - 1, Math.floor(scored.length * (1 - HOLDOUT_SHARE)));
  return new Date(scored[index] ?? Date.now()).toISOString();
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
