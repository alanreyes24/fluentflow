import type { StringKey, TranslateValues } from '../i18n';

/**
 * Formatting shared between the card list and the study screen's interval
 * preview, so "6 d" on a rating button and "6 d" beside a card are produced by
 * the same rounding.
 */

export type Translate = (key: StringKey, values?: TranslateValues) => string;

/**
 * An SM-2 interval as the shortest honest unit.
 *
 * Anything under a day is a lapse, which SM-2 re-queues `LAPSE_MINUTES` out
 * rather than scheduling in days — so it is shown in minutes rather than
 * rounded up to "1 d", which would be a promise the queue does not keep.
 */
export function formatInterval(days: number, lapseMinutes: number, t: Translate): string {
  if (days < 1) return t('intervalMinutes', { count: lapseMinutes });
  if (days < 30) return t('intervalDays', { count: Math.round(days) });
  if (days < 365) return t('intervalMonths', { count: Math.round(days / 30) });
  return t('intervalYears', { count: Math.round((days / 365) * 10) / 10 });
}

/** A percentage for display: no decimals, and never "100%" until it is. */
export function percent(value: number): string {
  const share = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const rounded = Math.round(share * 100);
  if (rounded === 100 && share < 1) return '99%';
  return `${rounded}%`;
}
