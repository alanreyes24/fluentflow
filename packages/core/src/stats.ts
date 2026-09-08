import type { Card, RatingName } from './types.js';
import { collectionDayKey, deckProgress, type DeckProgress } from './scheduler.js';

/**
 * Study statistics: streaks, history, retention and the forecast.
 *
 * Everything here is pure and takes its "now" as an argument, for the same
 * reason SM-2 does — a streak that depends on the wall clock cannot be tested,
 * and a streak is the one number in the app a user will argue with.
 *
 * Days are local, not UTC. A review at 00:30 belongs to the day the learner
 * thinks it does, and the alternative — bucketing by UTC — silently moves
 * evening reviews into tomorrow for anyone west of Greenwich. `DayKey` is a
 * plain `YYYY-MM-DD` string so the buckets sort lexicographically and compare
 * with `===`.
 */

/** A local calendar day, `YYYY-MM-DD`. */
export type DayKey = string;

/** One day of review activity. Days with no reviews may be omitted entirely. */
export interface StudyDay {
  day: DayKey;
  reviews: number;
  /** Reviews rated "again". The rest are what `retention` counts as kept. */
  lapses: number;
}

/** A count bucketed by day, used for the forecast and the history chart. */
export interface DayCount {
  day: DayKey;
  count: number;
}

export interface StreakSummary {
  /** Consecutive days ending today, or ending yesterday if today is untouched. */
  current: number;
  longest: number;
  studiedToday: boolean;
  /**
   * The streak is alive but ends at midnight — studied yesterday, not today.
   * This is the state worth putting on screen; `current` alone cannot say it.
   */
  atRisk: boolean;
  activeDays: number;
  lastStudied: DayKey | null;
}

export interface ReviewSummary {
  reviews: number;
  lapses: number;
  /**
   * Share of reviews not rated "again", 0..1. Defined as 1 for an empty
   * history: "you have forgotten nothing" is truer than "you have failed
   * everything", and it keeps the number off zero on a first launch.
   */
  retention: number;
  activeDays: number;
  bestDay: StudyDay | null;
  /** Mean reviews across days actually studied, not across the calendar. */
  perActiveDay: number;
}

export interface HeatmapCell {
  day: DayKey;
  reviews: number;
  /** 0 for an untouched day, then 1..4 scaled against the window's busiest. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Days after `today`, which the grid pads with to keep the weeks square. */
  future: boolean;
}

// --- day arithmetic ---------------------------------------------------------

/** The local calendar day a moment falls on (not the Anki collection day). */
export function dayKey(date: Date = new Date()): DayKey {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A day key back to a `Date`, at local midday.
 *
 * Two reasons it is built from components rather than parsed from a string.
 *
 * Midday rather than midnight: adding a day to a midnight local date lands on
 * 23:00 the day before across a spring-forward boundary, and the streak then
 * skips a day. Noon leaves twelve hours of slack either way.
 *
 * Components rather than `new Date("2026-09-03T12:00:00")`: a date-time with no
 * offset is specified to parse as local time, but Hermes has historically been
 * unreliable with anything short of a full ISO string, and reading it as UTC
 * would shift every weekday label and date by one for anyone west of
 * Greenwich. The constructor has no such ambiguity to get wrong.
 */
export function dayToDate(day: DayKey): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12);
}

export function addDays(day: DayKey, delta: number): DayKey {
  const date = dayToDate(day);
  date.setDate(date.getDate() + delta);
  return dayKey(date);
}

/** Whole days from `from` to `to`, negative when `to` is the earlier one. */
export function daysBetween(from: DayKey, to: DayKey): number {
  const ms = dayToDate(to).getTime() - dayToDate(from).getTime();
  return Math.round(ms / 86_400_000);
}

/** Every day from `from` to `to` inclusive. */
export function dayRange(from: DayKey, to: DayKey): DayKey[] {
  const days: DayKey[] = [];
  for (let day = from; daysBetween(day, to) >= 0; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > 4000) break; // A decade of study; never reached in practice.
  }
  return days;
}

/** Day of the week, 0 = Sunday, matching `Date.getDay`. */
export function weekday(day: DayKey): number {
  return dayToDate(day).getDay();
}

/** The start of `day`'s week. `weekStartsOn` is 1 (Monday) by default. */
export function startOfWeek(day: DayKey, weekStartsOn = 1): DayKey {
  const offset = (weekday(day) - weekStartsOn + 7) % 7;
  return addDays(day, -offset);
}

// --- streaks ----------------------------------------------------------------

export function studyStreak(
  days: readonly StudyDay[],
  today: DayKey = dayKey(),
): StreakSummary {
  const active = [
    ...new Set(days.filter((entry) => entry.reviews > 0).map((entry) => entry.day)),
  ].sort();

  if (active.length === 0) {
    return {
      current: 0,
      longest: 0,
      studiedToday: false,
      atRisk: false,
      activeDays: 0,
      lastStudied: null,
    };
  }

  let longest = 1;
  let run = 1;
  for (let i = 1; i < active.length; i++) {
    run = active[i] === addDays(active[i - 1]!, 1) ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // Counting back from yesterday when today is untouched is what stops a
  // streak from appearing to reset every morning before the first review.
  const studied = new Set(active);
  const studiedToday = studied.has(today);
  const yesterday = addDays(today, -1);

  let cursor: DayKey | null = studiedToday ? today : studied.has(yesterday) ? yesterday : null;
  let current = 0;
  while (cursor && studied.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  return {
    current,
    longest: Math.max(longest, current),
    studiedToday,
    atRisk: current > 0 && !studiedToday,
    activeDays: active.length,
    lastStudied: active[active.length - 1] ?? null,
  };
}

// --- summaries --------------------------------------------------------------

export function summariseReviews(days: readonly StudyDay[]): ReviewSummary {
  const active = days.filter((entry) => entry.reviews > 0);
  const reviews = active.reduce((total, entry) => total + entry.reviews, 0);
  const lapses = active.reduce((total, entry) => total + entry.lapses, 0);
  const bestDay = active.reduce<StudyDay | null>(
    (best, entry) => (best === null || entry.reviews > best.reviews ? entry : best),
    null,
  );

  return {
    reviews,
    lapses,
    retention: reviews === 0 ? 1 : (reviews - lapses) / reviews,
    activeDays: active.length,
    bestDay,
    perActiveDay: active.length === 0 ? 0 : reviews / active.length,
  };
}

/** Reviews per day across a window, with untouched days filled in as zero. */
export function fillDays(days: readonly StudyDay[], from: DayKey, to: DayKey): StudyDay[] {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  return dayRange(from, to).map((day) => byDay.get(day) ?? { day, reviews: 0, lapses: 0 });
}

/** The window a chart of the last `count` days covers, ending today. */
export function recentWindow(count: number, today: DayKey = dayKey()): [DayKey, DayKey] {
  return [addDays(today, -(count - 1)), today];
}

// --- heatmap ----------------------------------------------------------------

export interface HeatmapOptions {
  today?: DayKey;
  /** Columns in the grid. 17 weeks is roughly a phone width at 12px cells. */
  weeks?: number;
  weekStartsOn?: number;
}

/**
 * A contribution grid: one column per week, seven rows.
 *
 * Levels are relative to the busiest day in the window rather than to a fixed
 * threshold, so someone doing 15 reviews a day and someone doing 300 both get
 * a readable gradient instead of a flat wall.
 */
export function heatmap(days: readonly StudyDay[], options: HeatmapOptions = {}): HeatmapCell[][] {
  const today = options.today ?? dayKey();
  const weeks = Math.max(1, options.weeks ?? 17);
  const weekStartsOn = options.weekStartsOn ?? 1;

  const lastColumn = startOfWeek(today, weekStartsOn);
  const firstColumn = addDays(lastColumn, -(weeks - 1) * 7);
  const byDay = new Map(days.map((entry) => [entry.day, entry.reviews]));

  const busiest = Math.max(
    1,
    ...dayRange(firstColumn, addDays(lastColumn, 6)).map((day) => byDay.get(day) ?? 0),
  );

  const grid: HeatmapCell[][] = [];
  for (let column = 0; column < weeks; column++) {
    const start = addDays(firstColumn, column * 7);
    grid.push(
      Array.from({ length: 7 }, (_unused, row) => {
        const day = addDays(start, row);
        const reviews = byDay.get(day) ?? 0;
        return {
          day,
          reviews,
          level: intensity(reviews, busiest),
          future: daysBetween(today, day) > 0,
        };
      }),
    );
  }
  return grid;
}

export function intensity(reviews: number, busiest: number): 0 | 1 | 2 | 3 | 4 {
  if (reviews <= 0) return 0;
  const share = reviews / Math.max(busiest, 1);
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}

// --- forecast ---------------------------------------------------------------

/**
 * How many cards come due over the next `days` days.
 *
 * Anything already overdue is folded into today, which is where it will
 * actually be studied. Without that, a neglected deck shows an empty forecast
 * and a hundred cards waiting behind it.
 */
export function forecast(
  cards: readonly Card[],
  options: { days?: number; now?: Date } = {},
): DayCount[] {
  const days = Math.max(1, options.days ?? 14);
  const now = options.now ?? new Date();
  const today = collectionDayKey(now);
  const horizon = addDays(today, days - 1);

  const counts = new Map<DayKey, number>(dayRange(today, horizon).map((day) => [day, 0]));

  for (const card of cards) {
    if (card.deleted) continue;
    const due = card.dueDay ?? collectionDayKey(new Date(card.nextReview));
    const day = daysBetween(today, due) < 0 ? today : due;
    const current = counts.get(day);
    if (current !== undefined) counts.set(day, current + 1);
  }

  return [...counts.entries()].map(([day, count]) => ({ day, count }));
}

// --- collection-wide progress ----------------------------------------------

export interface CollectionSummary extends DeckProgress {
  decks: number;
  /** Mastered as a share of the collection, 0..1. */
  mastery: number;
}

export function collectionSummary(
  cards: readonly Card[],
  deckCount: number,
  now: Date = new Date(),
): CollectionSummary {
  const progress = deckProgress([...cards], now);
  return {
    ...progress,
    decks: deckCount,
    mastery: progress.total === 0 ? 0 : progress.mastered / progress.total,
  };
}

/** Rating tallies, always with every rating present so a chart has four bars. */
export type RatingCounts = Record<RatingName, number>;

export const EMPTY_RATING_COUNTS: RatingCounts = { again: 0, hard: 0, good: 0, easy: 0 };

export function totalRatings(counts: RatingCounts): number {
  return counts.again + counts.hard + counts.good + counts.easy;
}
