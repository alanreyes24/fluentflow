import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  collectionSummary,
  createCard,
  dayKey,
  dayRange,
  dayToDate,
  daysBetween,
  fillDays,
  forecast,
  heatmap,
  intensity,
  recentWindow,
  startOfWeek,
  studyStreak,
  summariseReviews,
  weekday,
} from '../dist/index.js';

/**
 * Statistics, and the streak in particular.
 *
 * The streak is the number a user will argue with, so the cases below are the
 * arguments: a gap breaks it, yesterday keeps it alive, today extends it, and
 * a long-past run is remembered as the longest without being claimed as the
 * current one.
 */

const days = (...entries) => entries.map(([d, reviews, lapses = 0]) => ({ day: d, reviews, lapses }));

// --- day arithmetic ---------------------------------------------------------

test('a day key is the local calendar day, not the UTC one', () => {
  // Local midday: every timezone agrees on the date, so this is stable in CI.
  assert.equal(dayKey(new Date(2026, 8, 3, 12, 0)), '2026-09-03');
  assert.equal(dayKey(new Date(2026, 0, 1, 12, 0)), '2026-01-01');
  assert.equal(dayKey(new Date(2026, 11, 31, 12, 0)), '2026-12-31');
});

test('day arithmetic crosses months, years and leap days', () => {
  assert.equal(addDays('2026-09-03', 1), '2026-09-04');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(daysBetween('2026-09-01', '2026-09-03'), 2);
  assert.equal(daysBetween('2026-09-03', '2026-09-01'), -2);
});

test('a day range is inclusive at both ends', () => {
  assert.deepEqual(dayRange('2026-09-01', '2026-09-04'), [
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
    '2026-09-04',
  ]);
  assert.deepEqual(dayRange('2026-09-01', '2026-09-01'), ['2026-09-01']);
  assert.deepEqual(dayRange('2026-09-02', '2026-09-01'), []);
});

test('a day key becomes a local date, not a UTC one', () => {
  // The guard is against `new Date('2026-09-03T12:00:00')`, which is specified
  // to mean local time but is not reliably read that way by Hermes. Reading it
  // as UTC would move the date by one for anyone west of Greenwich, and the
  // statistics screen labels its chart axis from this.
  const date = dayToDate('2026-09-03');

  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 8); // September, zero-based
  assert.equal(date.getDate(), 3);
  // Midday, so adding days cannot fall through a daylight-saving boundary.
  assert.equal(date.getHours(), 12);
});

test('a day key round-trips through a date', () => {
  for (const day of ['2026-01-01', '2026-03-29', '2026-11-01', '2024-02-29']) {
    assert.equal(dayKey(dayToDate(day)), day);
  }
});

test('weekday reads the local day of the week', () => {
  // 2026-09-03 is a Thursday: 4 with Sunday as 0.
  assert.equal(weekday('2026-09-03'), 4);
  assert.equal(weekday('2026-08-30'), 0); // Sunday
  assert.equal(weekday('2026-08-31'), 1); // Monday
});

test('a week starts on Monday by default', () => {
  // 2026-09-03 is a Thursday.
  assert.equal(startOfWeek('2026-09-03'), '2026-08-31');
  assert.equal(startOfWeek('2026-08-31'), '2026-08-31');
  assert.equal(startOfWeek('2026-09-03', 0), '2026-08-30');
});

test('the recent window ends today and counts backwards', () => {
  assert.deepEqual(recentWindow(7, '2026-09-03'), ['2026-08-28', '2026-09-03']);
  assert.deepEqual(recentWindow(1, '2026-09-03'), ['2026-09-03', '2026-09-03']);
});

// --- streaks ----------------------------------------------------------------

test('no history is a streak of zero, not a crash', () => {
  const streak = studyStreak([], '2026-09-03');
  assert.equal(streak.current, 0);
  assert.equal(streak.longest, 0);
  assert.equal(streak.studiedToday, false);
  assert.equal(streak.atRisk, false);
  assert.equal(streak.lastStudied, null);
});

test('consecutive days ending today count as the current streak', () => {
  const streak = studyStreak(
    days(['2026-09-01', 10], ['2026-09-02', 4], ['2026-09-03', 7]),
    '2026-09-03',
  );
  assert.equal(streak.current, 3);
  assert.equal(streak.studiedToday, true);
  assert.equal(streak.atRisk, false);
  assert.equal(streak.lastStudied, '2026-09-03');
});

test('a streak survives an untouched today, and says it is at risk', () => {
  // The failure this guards against: the streak appearing to reset every
  // morning, before the day's first review.
  const streak = studyStreak(days(['2026-09-01', 3], ['2026-09-02', 3]), '2026-09-03');
  assert.equal(streak.current, 2);
  assert.equal(streak.studiedToday, false);
  assert.equal(streak.atRisk, true);
});

test('a missed day ends the streak', () => {
  const streak = studyStreak(
    days(['2026-08-30', 5], ['2026-08-31', 5], ['2026-09-03', 1]),
    '2026-09-03',
  );
  assert.equal(streak.current, 1);
  assert.equal(streak.longest, 2);
});

test('two days missed leaves no current streak at all', () => {
  const streak = studyStreak(days(['2026-08-31', 5], ['2026-09-01', 5]), '2026-09-03');
  assert.equal(streak.current, 0);
  assert.equal(streak.longest, 2);
  assert.equal(streak.atRisk, false);
  assert.equal(streak.lastStudied, '2026-09-01');
});

test('the longest streak is remembered after it is broken', () => {
  const streak = studyStreak(
    days(
      ['2026-08-01', 1],
      ['2026-08-02', 1],
      ['2026-08-03', 1],
      ['2026-08-04', 1],
      ['2026-09-02', 1],
      ['2026-09-03', 1],
    ),
    '2026-09-03',
  );
  assert.equal(streak.current, 2);
  assert.equal(streak.longest, 4);
  assert.equal(streak.activeDays, 6);
});

test('a day logged with no reviews does not hold a streak together', () => {
  const streak = studyStreak(
    days(['2026-09-01', 4], ['2026-09-02', 0], ['2026-09-03', 4]),
    '2026-09-03',
  );
  assert.equal(streak.current, 1);
  assert.equal(streak.longest, 1);
});

test('the streak survives a month boundary', () => {
  const streak = studyStreak(
    days(['2026-08-30', 2], ['2026-08-31', 2], ['2026-09-01', 2]),
    '2026-09-01',
  );
  assert.equal(streak.current, 3);
});

// --- summaries --------------------------------------------------------------

test('retention is the share of reviews not failed', () => {
  const summary = summariseReviews(days(['2026-09-01', 10, 2], ['2026-09-02', 10, 0]));
  assert.equal(summary.reviews, 20);
  assert.equal(summary.lapses, 2);
  assert.equal(summary.retention, 0.9);
  assert.equal(summary.activeDays, 2);
  assert.equal(summary.perActiveDay, 10);
  assert.equal(summary.bestDay.day, '2026-09-01');
});

test('an empty history reports full retention rather than zero', () => {
  const summary = summariseReviews([]);
  assert.equal(summary.reviews, 0);
  assert.equal(summary.retention, 1);
  assert.equal(summary.bestDay, null);
  assert.equal(summary.perActiveDay, 0);
});

test('filling a window inserts the days nothing happened on', () => {
  const filled = fillDays(days(['2026-09-02', 5, 1]), '2026-09-01', '2026-09-03');
  assert.deepEqual(filled, [
    { day: '2026-09-01', reviews: 0, lapses: 0 },
    { day: '2026-09-02', reviews: 5, lapses: 1 },
    { day: '2026-09-03', reviews: 0, lapses: 0 },
  ]);
});

// --- heatmap ----------------------------------------------------------------

test('the heatmap is a square grid of whole weeks ending this week', () => {
  const grid = heatmap(days(['2026-09-03', 20]), { today: '2026-09-03', weeks: 4 });
  assert.equal(grid.length, 4);
  for (const week of grid) assert.equal(week.length, 7);
  // Columns are Monday-first, and the last column contains today.
  assert.equal(grid[3][0].day, '2026-08-31');
  assert.equal(grid[3][3].day, '2026-09-03');
  assert.equal(grid[3][3].reviews, 20);
});

test('days after today are marked as future so they can be drawn empty', () => {
  const grid = heatmap([], { today: '2026-09-03', weeks: 1 });
  assert.equal(grid[0][3].future, false); // Thursday, today
  assert.equal(grid[0][4].future, true); // Friday
  assert.equal(grid[0][6].future, true); // Sunday
});

test('intensity scales against the busiest day, not a fixed threshold', () => {
  assert.equal(intensity(0, 100), 0);
  assert.equal(intensity(10, 100), 1);
  assert.equal(intensity(40, 100), 2);
  assert.equal(intensity(60, 100), 3);
  assert.equal(intensity(100, 100), 4);
  // A quiet week still gets a full gradient.
  assert.equal(intensity(4, 4), 4);
  assert.equal(intensity(1, 4), 1);
});

// --- forecast ---------------------------------------------------------------

test('the forecast counts cards by the day they come due', () => {
  const now = new Date(2026, 8, 3, 12, 0);
  const cards = [
    cardDue(now, 0),
    cardDue(now, 1),
    cardDue(now, 1),
    cardDue(now, 3),
  ];
  const rows = forecast(cards, { days: 5, now });

  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => row.count),
    [1, 2, 0, 1, 0],
  );
  assert.equal(rows[0].day, dayKey(now));
});

test('overdue cards are folded into today rather than dropped', () => {
  const now = new Date(2026, 8, 3, 12, 0);
  const rows = forecast([cardDue(now, -9), cardDue(now, -1)], { days: 3, now });
  assert.equal(rows[0].count, 2);
});

test('cards beyond the horizon are left out of the forecast', () => {
  const now = new Date(2026, 8, 3, 12, 0);
  const rows = forecast([cardDue(now, 40)], { days: 7, now });
  assert.equal(
    rows.reduce((total, row) => total + row.count, 0),
    0,
  );
});

test('deleted cards are not forecast', () => {
  const now = new Date(2026, 8, 3, 12, 0);
  const rows = forecast([{ ...cardDue(now, 1), deleted: true }], { days: 3, now });
  assert.equal(rows[1].count, 0);
});

// --- collection -------------------------------------------------------------

test('the collection summary reports mastery as a share of the whole', () => {
  const now = new Date(2026, 8, 3, 12, 0);
  const cards = [
    { ...cardDue(now, 1), status: 'mastered' },
    { ...cardDue(now, 1), status: 'mastered' },
    { ...cardDue(now, 1), status: 'learning' },
    { ...cardDue(now, -1), status: 'new' },
  ];
  const summary = collectionSummary(cards, 2, now);

  assert.equal(summary.decks, 2);
  assert.equal(summary.total, 4);
  assert.equal(summary.mastered, 2);
  assert.equal(summary.due, 1);
  assert.equal(summary.mastery, 0.5);
});

test('an empty collection has zero mastery rather than a division by zero', () => {
  const summary = collectionSummary([], 0);
  assert.equal(summary.mastery, 0);
  assert.equal(summary.total, 0);
});

function cardDue(now, inDays) {
  const card = createCard({
    userId: 'u1',
    deckId: 'd1',
    front: 'hablar',
    back: 'to speak',
    language: 'es',
    now,
  });
  return { ...card, nextReview: new Date(now.getTime() + inDays * 86_400_000).toISOString() };
}
