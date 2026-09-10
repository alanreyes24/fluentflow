import {
  TARGET_LANGUAGES,
  normalizeCard,
  type Card,
  type CardPhase,
  type Deck,
  type TargetLanguage,
} from '@fluentflow/core';

/**
 * Request-body validation.
 *
 * Everything a client uploads is untrusted, including `userId`: a caller could
 * otherwise write records into somebody else's namespace, or store a card whose
 * `interval` is a string and quietly corrupt the scheduler on every device that
 * later syncs it down. Validation is strict and total — unknown fields are
 * dropped rather than passed through.
 */

export class ValidationError extends Error {
  readonly details: string[];
  constructor(details: string[]) {
    super(details[0] ?? 'Invalid request body.');
    this.name = 'ValidationError';
    this.details = details;
  }
}

const MAX_TEXT = 4000;
const MAX_EXAMPLES = 10;
const MAX_BATCH = 5000;

export function parseDecks(input: unknown, userId: string): Deck[] {
  return parseArray(input, 'decks', (value, path) => parseDeck(value, userId, path));
}

export function parseCards(input: unknown, userId: string): Card[] {
  return parseArray(input, 'cards', (value, path) => parseCard(value, userId, path));
}

function parseDeck(value: unknown, userId: string, path: string): Deck {
  const raw = asObject(value, path);
  return {
    id: id(raw.id, `${path}.id`),
    // The token decides the owner, never the payload.
    userId,
    name: text(raw.name, `${path}.name`, 1),
    language: language(raw.language, `${path}.language`),
    newCardsPerDay:
      raw.newCardsPerDay === null
        ? null
        : integer(raw.newCardsPerDay ?? 20, `${path}.newCardsPerDay`, 1),
    maxReviewsPerDay:
      raw.maxReviewsPerDay === null
        ? null
        : integer(raw.maxReviewsPerDay ?? 50, `${path}.maxReviewsPerDay`, 1),
    reverseCards: raw.reverseCards === true,
    showExamples: raw.showExamples !== false,
    showGrammarNotes: raw.showGrammarNotes !== false,
    showRelatedWords: raw.showRelatedWords !== false,
    cardCount: integer(raw.cardCount ?? 0, `${path}.cardCount`, 0),
    createdAt: isoDate(raw.createdAt, `${path}.createdAt`),
    lastModified: isoDate(raw.lastModified, `${path}.lastModified`),
    syncStatus: 'synced',
    ...(raw.deleted === true ? { deleted: true } : {}),
  };
}

function parseCard(value: unknown, userId: string, path: string): Card {
  const raw = asObject(value, path);
  return normalizeCard({
    id: id(raw.id, `${path}.id`),
    deckId: id(raw.deckId, `${path}.deckId`),
    userId,
    front: text(raw.front, `${path}.front`, 1),
    back: text(raw.back, `${path}.back`, 1),
    language: language(raw.language, `${path}.language`),
    examples: examples(raw.examples, `${path}.examples`),
    grammarNotes: stringList(raw.grammarNotes, `${path}.grammarNotes`, 20, 300),
    relatedWords: stringList(raw.relatedWords, `${path}.relatedWords`, 20, 120),
    tags: stringList(raw.tags, `${path}.tags`, 20, 80),
    interval: number(raw.interval, `${path}.interval`, 0, 36500),
    easeFactor: number(raw.easeFactor, `${path}.easeFactor`, 1.3, 10),
    repetitions: integer(raw.repetitions ?? 0, `${path}.repetitions`, 0),
    // The scheduler fields are optional on the wire: a client that predates
    // them still syncs, and the normalizeCard() wrapper reconstructs the phase
    // it left out.
    ...(raw.phase === undefined
      ? {}
      : {
          phase: oneOf<CardPhase>(
            raw.phase,
            ['new', 'learning', 'review', 'relearning'],
            `${path}.phase`,
          ),
        }),
    lapses: integer(raw.lapses ?? 0, `${path}.lapses`, 0),
    learningStep: integer(raw.learningStep ?? 0, `${path}.learningStep`, 0),
    ...(raw.leech === true ? { leech: true } : {}),
    ...(raw.introducedAt === undefined
      ? {}
      : { introducedAt: isoDate(raw.introducedAt, `${path}.introducedAt`) }),
    ...(raw.dueDay === undefined ? {} : { dueDay: text(raw.dueDay, `${path}.dueDay`, 10, 10) }),
    ...(raw.buriedUntil === undefined
      ? {}
      : { buriedUntil: text(raw.buriedUntil, `${path}.buriedUntil`, 10, 10) }),
    starred: raw.starred === true,
    ...(raw.suspended === true ? { suspended: true } : {}),
    nextReview: isoDate(raw.nextReview, `${path}.nextReview`),
    status: oneOf(raw.status, ['new', 'learning', 'mastered'], `${path}.status`),
    lastModified: isoDate(raw.lastModified, `${path}.lastModified`),
    syncStatus: 'synced',
    ...(raw.deleted === true ? { deleted: true } : {}),
  });
}

function parseArray<T>(input: unknown, field: string, parse: (v: unknown, path: string) => T): T[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ValidationError([`${field} must be an array.`]);
  if (input.length > MAX_BATCH) {
    throw new ValidationError([`${field} may not exceed ${MAX_BATCH} records per request.`]);
  }

  const errors: string[] = [];
  const parsed: T[] = [];
  input.forEach((value, index) => {
    try {
      parsed.push(parse(value, `${field}[${index}]`));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });

  // Report several problems at once; fixing them one round-trip at a time is
  // miserable when a client is uploading thousands of imported cards.
  if (errors.length > 0) throw new ValidationError(errors.slice(0, 10));
  return parsed;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError([`${path} must be an object.`]);
  }
  return value as Record<string, unknown>;
}

function id(value: unknown, path: string): string {
  const parsed = text(value, path, 1, 200);
  if (!/^[\w:.-]+$/.test(parsed)) {
    throw new ValidationError([`${path} may only contain letters, digits, "-", "_", "." and ":".`]);
  }
  return parsed;
}

function text(value: unknown, path: string, min = 0, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new ValidationError([`${path} must be a string.`]);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ValidationError([`${path} must not be empty.`]);
  if (trimmed.length > max) {
    throw new ValidationError([`${path} must be at most ${max} characters.`]);
  }
  return trimmed;
}

function language(value: unknown, path: string): TargetLanguage {
  return oneOf(value, TARGET_LANGUAGES as readonly string[], path) as TargetLanguage;
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError([`${path} must be one of: ${allowed.join(', ')}.`]);
  }
  return value as T;
}

function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError([`${path} must be a finite number.`]);
  }
  if (value < min || value > max) {
    throw new ValidationError([`${path} must be between ${min} and ${max}.`]);
  }
  return value;
}

function integer(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ValidationError([`${path} must be an integer of at least ${min}.`]);
  }
  return value;
}

function isoDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError([`${path} must be an ISO-8601 date string.`]);
  }
  return new Date(value).toISOString();
}

function examples(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError([`${path} must be an array of strings.`]);
  return value.slice(0, MAX_EXAMPLES).map((item, index) => text(item, `${path}[${index}]`, 0, 500));
}

function stringList(value: unknown, path: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError([`${path} must be an array of strings.`]);
  return value.slice(0, maxItems).map((item, index) => text(item, `${path}[${index}]`, 0, maxLength));
}
