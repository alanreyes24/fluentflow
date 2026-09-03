/**
 * Core domain types. These shapes are the contract shared by the Expo app,
 * the Express sync server and the Firestore documents.
 */

/** Languages the app ships packs for. `en` is the built-in UI fallback. */
export const SUPPORTED_LANGUAGES = ['en', 'es', 'bs'] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

/** Languages a deck can *teach* (the UI can also be shown in English). */
export const TARGET_LANGUAGES = ['es', 'bs'] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

export type CardStatus = 'new' | 'learning' | 'mastered';
export type SyncStatus = 'synced' | 'pending';

/** ISO-8601 UTC string, e.g. `2024-09-05T10:00:00.000Z`. */
export type IsoDate = string;

export interface Card {
  id: string;
  deckId: string;
  userId: string;
  /** Prompt side — the word or phrase in the target language. */
  front: string;
  /** Answer side — definition or translation. */
  back: string;
  language: TargetLanguage;
  /** Cached AI-generated example sentences, always in `language`. */
  examples: string[];
  /** SM-2 inter-repetition interval, in days. */
  interval: number;
  /** SM-2 ease factor, clamped to >= 1.3. */
  easeFactor: number;
  /** Number of consecutive successful reviews. Drives SM-2's I(1)/I(2) cases. */
  repetitions: number;
  nextReview: IsoDate;
  status: CardStatus;
  lastModified: IsoDate;
  syncStatus: SyncStatus;
  /** Soft-delete marker so deletions can propagate through last-write-wins. */
  deleted?: boolean;
}

export interface Deck {
  id: string;
  userId: string;
  name: string;
  language: TargetLanguage;
  cardCount: number;
  createdAt: IsoDate;
  lastModified: IsoDate;
  syncStatus: SyncStatus;
  deleted?: boolean;
}

/** A rating given during review. The numbers double as keyboard shortcuts. */
export const RATINGS = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
} as const;
export type RatingName = keyof typeof RATINGS;
export type RatingValue = (typeof RATINGS)[RatingName];

export const RATING_NAMES = Object.keys(RATINGS) as RatingName[];

export function ratingFromValue(value: number): RatingName | undefined {
  return RATING_NAMES.find((name) => RATINGS[name] === value);
}

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && (TARGET_LANGUAGES as readonly string[]).includes(value);
}

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Human-readable names, used in deck creation and settings. */
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: 'English',
  es: 'Español',
  bs: 'Bosanski',
};

/** English names, used inside AI prompts. */
export const LANGUAGE_NAMES_EN: Record<LanguageCode, string> = {
  en: 'English',
  es: 'Spanish',
  bs: 'Bosnian',
};
