import { isLanguageCode, type LanguageCode } from '../types.js';

/**
 * Account settings: the choices that follow the learner from device to device.
 *
 * Like cards, they live on the sync server and every device keeps a copy. Each
 * setting carries the time it was last changed, and two copies merge one
 * setting at a time, newest wins. Changing the theme on the laptop and the
 * daily goal on the phone before either has synced therefore keeps both
 * changes, rather than one device's whole record beating the other's.
 */

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreferenceSetting = (typeof THEME_PREFERENCES)[number];

export const DAILY_GOAL_MIN = 1;
export const DAILY_GOAL_MAX = 1000;

export interface SettingValues {
  /** Reviews per day the streak card measures against. */
  dailyGoal: number;
  theme: ThemePreferenceSetting;
  /** Interface language — not a deck's target language. */
  uiLanguage: LanguageCode;
}

export type SettingKey = keyof SettingValues;
export const SETTING_KEYS: readonly SettingKey[] = ['dailyGoal', 'theme', 'uiLanguage'];

export interface SettingEntry<T> {
  value: T;
  /** ISO-8601 time the value was chosen. */
  updatedAt: string;
}

/** Only the settings someone has actually chosen; the rest use defaults. */
export type UserSettings = { [K in SettingKey]?: SettingEntry<SettingValues[K]> };

/** Whether `value` is an acceptable value for `key`. */
export function isSettingValue<K extends SettingKey>(key: K, value: unknown): value is SettingValues[K] {
  switch (key) {
    case 'dailyGoal':
      return typeof value === 'number' && Number.isInteger(value) &&
        value >= DAILY_GOAL_MIN && value <= DAILY_GOAL_MAX;
    case 'theme':
      return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
    case 'uiLanguage':
      return isLanguageCode(value);
    default:
      return false;
  }
}

/**
 * Merge two copies setting by setting; the later `updatedAt` wins. A tie
 * between different values is settled by the value itself, so every device
 * and the server reach the same answer without talking to each other.
 */
export function mergeSettings(a: UserSettings, b: UserSettings): UserSettings {
  const merged: Partial<Record<SettingKey, SettingEntry<unknown>>> = {};
  for (const key of SETTING_KEYS) {
    const winner = newer<unknown>(a[key], b[key]);
    if (winner) merged[key] = winner;
  }
  return merged as UserSettings;
}

/** Whether two copies hold the same values and times. */
export function sameSettings(a: UserSettings, b: UserSettings): boolean {
  return SETTING_KEYS.every((key) => {
    const left = a[key];
    const right = b[key];
    if (!left || !right) return left === right;
    return left.value === right.value && left.updatedAt === right.updatedAt;
  });
}

function newer<T>(a: SettingEntry<T> | undefined, b: SettingEntry<T> | undefined): SettingEntry<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  if (at !== bt) return at > bt ? a : b;
  return String(a.value) >= String(b.value) ? a : b;
}
