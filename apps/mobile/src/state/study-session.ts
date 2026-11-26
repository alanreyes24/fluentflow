import type { Card, Deck } from '@fluentflow/core';
import type { Repository } from '../db/repository';

/** Anki's learn-ahead limit: how early a learning card may be shown again. */
export const LEARN_AHEAD_MS = 20 * 60 * 1000;

/**
 * True while a card is still on its (re)learning steps and comes back within
 * the learn-ahead window, so it belongs at the end of the open session.
 */
export function dueWithinSession(card: Pick<Card, 'phase' | 'nextReview'>, now: Date = new Date()): boolean {
  if (card.phase !== 'learning' && card.phase !== 'relearning') return false;
  return Date.parse(card.nextReview) - now.getTime() <= LEARN_AHEAD_MS;
}

/**
 * Bring the unanswered part of a study queue up to date with SQLite.
 *
 * A study queue is held in memory from the moment the session starts. Cards
 * answered since then on another device arrive through sync, and without this
 * the open session would keep showing them: it would replay cards already
 * done today, and rating one again would schedule it from the stale copy and
 * overwrite the other device's review.
 *
 * The answered part (`queue[0..index)`) is kept as it is, so the session's
 * position and progress read the same. From `index` on, each card is re-read;
 * it stays only while it is still in the deck's study queue — the same one
 * Home counts — or is on a learning step inside the learn-ahead window, and
 * stays as the fresh row, not the snapshot. Without that second rule, a card
 * rated "again" here and re-queued for later in the session would be dropped
 * as soon as sync echoed this device's own answer back. The card on
 * screen is kept when `keepCurrent` is set, so an answer being read is not
 * pulled away mid-thought.
 *
 * Returns the new queue, or null when nothing changed.
 */
export async function reconcileStudyQueue(
  repository: Repository,
  deck: Pick<Deck, 'id' | 'newCardsPerDay' | 'maxReviewsPerDay'>,
  queue: readonly Card[],
  index: number,
  options: { keepCurrent?: boolean; now?: Date } = {},
): Promise<Card[] | null> {
  const remaining = queue.slice(index);
  if (remaining.length === 0) return null;
  const now = options.now ?? new Date();

  const [latestRows, due] = await Promise.all([
    Promise.all(remaining.map((card) => repository.getCard(card.id))),
    repository.dueCards(
      deck.id,
      now,
      Math.max(200, remaining.length),
      deck.newCardsPerDay,
      deck.maxReviewsPerDay,
    ),
  ]);
  const dueIds = new Set(due.map((card) => card.id));

  let changed = false;
  const kept: Card[] = [];
  remaining.forEach((card, offset) => {
    const latest = latestRows[offset];
    const live = latest && !latest.deleted && !latest.suspended ? latest : null;
    const isCurrent = offset === 0;
    const belongs = live && (dueIds.has(live.id) || dueWithinSession(live, now));
    if (live && (belongs || (isCurrent && options.keepCurrent))) {
      if (live.lastModified !== card.lastModified) changed = true;
      kept.push(live);
    } else {
      changed = true;
    }
  });

  return changed ? [...queue.slice(0, index), ...kept] : null;
}
