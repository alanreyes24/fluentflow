import type { TargetLanguage } from '../types.js';
import type { InferenceFn } from './generate.js';
import {
  BATCH_TRANSLATION_SCHEMA,
  buildTranslateBatchPrompt,
  parseTranslationBatch,
  sanitizeWord,
  wordKey,
} from './translate.js';

/**
 * Where a word's meaning comes from: the dictionary first, the model only for
 * what the dictionary does not have.
 *
 * That order is the whole point, and it is the opposite of what this started
 * as. Measured on the same twelve Spanish words: a Wiktionary-derived
 * dictionary answered all twelve correctly in 2 ms — including saying "I don't
 * know" to a Bosnian word and a typo that had wandered into a Spanish list —
 * while Qwen2.5-1.5B answered about seven, took 21 seconds, and invented
 * confident nonsense for the rest ("lodazal" as "lodestar").
 *
 * So the model is the fallback, not the engine, and its answers are marked as
 * needing review while the dictionary's are not. It has two jobs here:
 *
 *  - **Figure it out.** A word the dictionary missed may still be a real word —
 *    a rare form, a phrase, a compound — and the model gets one attempt at it.
 *  - **Throw it out.** An answer that fails validation is dropped rather than
 *    guessed at, and the word comes back with no meaning and a reason.
 *
 * Neither the dictionary nor the model is imported here. The lookup is
 * injected, the same seam `parseApkg` uses for SQLite, so this file can be
 * tested without a 79 MB dictionary or a 1.2 GB model anywhere near it.
 */

/** One row from the dictionary: a gloss for a headword. */
export interface DictionaryEntry {
  /** The headword this row belongs to. */
  word: string;
  gloss: string;
  pos?: string | null;
  /**
   * Set when the headword is an inflected form, naming the word it inflects.
   * `molim` carries `moliti`; `comieron` carries `comer`.
   */
  lemma?: string | null;
}

/** Looks a headword up. Platform-supplied: SQLite here, anything in tests. */
export type DictionaryLookup = (word: string) => DictionaryEntry[] | Promise<DictionaryEntry[]>;

export type MeaningSource = 'dictionary' | 'model' | 'none';

export type MeaningRejection =
  /** Neither the dictionary nor the model produced anything usable. */
  | 'not-found'
  /** The model answered, and the answer failed validation. */
  | 'model-rejected'
  /** The model request or structured response failed and may be retried. */
  | 'model-failed'
  /** There was no dictionary and no model to ask. */
  | 'nothing-to-ask';

export interface ResolvedMeaning {
  word: string;
  /** Empty when nothing usable was found. */
  meaning: string;
  source: MeaningSource;
  /** The headword the meaning came from, when it is not the word itself. */
  lemma?: string;
  /** A dictionary-supplied infinitive or model-supplied spelling correction. */
  correctedWord?: string;
  /**
   * Whether a person should check this before it becomes a card.
   *
   * False for the dictionary, true for the model. This is what lets the review
   * list point attention at the handful of rows that need it instead of
   * spreading it evenly over answers of wildly different reliability.
   */
  needsReview: boolean;
  rejected?: MeaningRejection;
}

export interface ResolveDeps {
  dictionary?: DictionaryLookup | null;
  infer?: InferenceFn | null;
  maxTokens?: number;
  /** Deadline for the model half of the work. The dictionary is never slow. */
  budgetMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
}

/** Glosses to keep on a card back. More than this is an essay, not a card. */
const MAX_GLOSSES = 3;
const MAX_MEANING_LENGTH = 120;
/** Keep structured responses comfortably below even conservative output limits. */
const MAX_TRANSLATION_BATCH_SIZE = 100;
const TRANSLATION_BATCH_MAX_TOKENS = 4096;

/**
 * Resolve a meaning for every word.
 *
 * The dictionary pass runs first and completely: it costs a millisecond per
 * word, so there is no reason to interleave it with anything. Only what it
 * misses reaches the model, which is where the time goes.
 */
export async function resolveMeanings(
  words: string[],
  language: TargetLanguage,
  deps: ResolveDeps,
): Promise<ResolvedMeaning[]> {
  const now = deps.now ?? (() => Date.now());
  const results: ResolvedMeaning[] = [];
  const unresolved: number[] = [];

  // --- the dictionary -------------------------------------------------------
  for (const originalWord of words) {
    const word = sanitizeWord(originalWord);
    if (!word) {
      unresolved.push(results.length);
      results.push({
        word: originalWord,
        meaning: '',
        source: 'none',
        needsReview: false,
        rejected: deps.infer ? 'model-rejected' : deps.dictionary ? 'not-found' : 'nothing-to-ask',
      });
      deps.onProgress?.(results.length, words.length);
      continue;
    }
    const found = deps.dictionary ? await lookUp(deps.dictionary, word, language) : null;
    if (found) {
      // Sanitizing is for lookup and prompting only. The renderer keys state by
      // the exact pasted front, so changing the identity here strands results.
      results.push({ ...found, word: originalWord });
    } else {
      unresolved.push(results.length);
      results.push({
        word: originalWord,
        meaning: '',
        source: 'none',
        needsReview: false,
        rejected: deps.infer ? 'not-found' : deps.dictionary ? 'not-found' : 'nothing-to-ask',
      });
    }
    deps.onProgress?.(results.length, words.length);
  }

  if (!deps.infer || unresolved.length === 0) return results;

  // --- the model, for the leftovers ----------------------------------------
  const deadline = deps.budgetMs ? now() + deps.budgetMs : Infinity;
  let modelDone = 0;

  // Duplicate and sanitize before spending a model request. Results are still
  // copied back to every original position, so card order remains unchanged.
  const requested = [...new Map(
    unresolved
      .map((index) => sanitizeWord(results[index]?.word ?? ''))
      .filter(Boolean)
      .map((word) => [wordKey(word), word] as const),
  ).values()];

  const indexesByKey = new Map<string, number[]>();
  for (const index of unresolved) {
    const key = wordKey(results[index]?.word ?? '');
    if (!key) continue;
    const indexes = indexesByKey.get(key) ?? [];
    indexes.push(index);
    indexesByKey.set(key, indexes);
  }

  for (let offset = 0; offset < requested.length; offset += MAX_TRANSLATION_BATCH_SIZE) {
    if (deps.signal?.aborted || now() >= deadline) break;
    const batch = requested.slice(offset, offset + MAX_TRANSLATION_BATCH_SIZE);
    const batchKeys = new Set(batch.map(wordKey));

    try {
      const raw = await deps.infer({
        prompt: buildTranslateBatchPrompt(batch, language),
        stop: [],
        maxTokens: deps.maxTokens ?? TRANSLATION_BATCH_MAX_TOKENS,
        responseSchema: BATCH_TRANSLATION_SCHEMA,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });

      const parsed = new Map(
        parseTranslationBatch(raw, batch).map((entry) => [wordKey(entry.word), entry]),
      );
      for (const key of batchKeys) {
        const answer = parsed.get(key);
        for (const index of indexesByKey.get(key) ?? []) {
          const entry = results[index];
          if (!entry) continue;
          if (!answer) {
            results[index] = { ...entry, rejected: 'model-failed' };
          } else if (answer.meaning) {
            results[index] = {
              ...entry,
              meaning: answer.meaning,
              source: 'model',
              needsReview: true,
              ...(answer.correctedWord ? { correctedWord: answer.correctedWord } : {}),
              rejected: undefined,
            };
          } else {
            results[index] = { ...entry, rejected: 'model-rejected' };
          }
        }
      }
    } catch {
      // A failed request is retryable and affects only its bounded batch.
      for (const key of batchKeys) {
        for (const index of indexesByKey.get(key) ?? []) {
          const entry = results[index];
          if (entry) results[index] = { ...entry, rejected: 'model-failed' };
        }
      }
    }

    modelDone += [...batchKeys]
      .reduce((count, key) => count + (indexesByKey.get(key)?.length ?? 0), 0);
    deps.onProgress?.(words.length - unresolved.length + modelDone, words.length);
  }

  return results;
}

/**
 * One word, through the dictionary.
 *
 * Three attempts, cheapest first: the word as written, then lower-cased, then
 * the lemma an inflected form points at. The last is what makes a word list
 * usable at all — `comieron` is in the dictionary only as "the third-person
 * plural preterite of comer", and the meaning lives under `comer`.
 */
async function lookUp(
  dictionary: DictionaryLookup,
  word: string,
  language: TargetLanguage,
): Promise<ResolvedMeaning | null> {
  const trimmed = word.trim();
  if (!trimmed) return null;

  const rows = await dictionaryRows(dictionary, trimmed);
  if (rows.length === 0) return null;

  // An inflected form: follow it to the word it inflects. Pointer-only lemma
  // entries get one additional bounded hop below.
  const explicitLemma = rows[0]?.lemma ?? null;
  const lemma = explicitLemma ?? rows.map((row) => referencedLemma(row.gloss)).find(Boolean) ?? null;
  if (lemma && lemma !== trimmed) {
    let lemmaRows = await dictionaryRows(dictionary, lemma);
    let resolvedLemma = lemmaRows[0]?.word ?? lemma;
    let meaning = joinGlosses(lemmaRows);

    // Some distilled entries need two hops: `imanes` -> `imanar` ->
    // `imantar`. Keep the bound explicit so malformed pointer cycles cannot
    // turn a card import into an infinite lookup.
    if (!meaning) {
      const nextLemma = lemmaRows.map((row) => referencedLemma(row.gloss)).find(Boolean);
      if (nextLemma && wordKey(nextLemma) !== wordKey(resolvedLemma)) {
        const nextRows = await dictionaryRows(dictionary, nextLemma);
        const nextMeaning = joinGlosses(nextRows);
        if (nextMeaning) {
          lemmaRows = nextRows;
          resolvedLemma = nextRows[0]?.word ?? nextLemma;
          meaning = nextMeaning;
        }
      }
    }

    if (meaning) {
      // Alternate spellings are dereferenced for their English meaning, but
      // they are not conjugations. Spanish reflexive infinitives such as
      // `acordarse` are also already infinitives even when the form table
      // points them at a non-reflexive headword.
      const conjugatedVerb = Boolean(
        explicitLemma &&
        lemmaRows.some((row) => row.pos === 'verb') &&
        !isInfinitive(trimmed, language),
      );
      return {
        word: trimmed,
        meaning,
        source: 'dictionary',
        lemma: resolvedLemma,
        needsReview: false,
        ...(conjugatedVerb && wordKey(resolvedLemma) !== wordKey(trimmed)
          ? { correctedWord: resolvedLemma }
          : {}),
      };
    }

    // An explicit inflection or an alternate-form gloss is a pointer, not a
    // usable meaning. Let the model handle it if the referenced headword is
    // missing instead of treating the pointer text as an English translation.
    return null;
  }

  const meaning = joinGlosses(rows);
  if (!meaning) return null;
  return { word: trimmed, meaning, source: 'dictionary', needsReview: false };
}

/** Exact spelling first, then lowercase and an accentless dictionary fallback. */
async function dictionaryRows(
  dictionary: DictionaryLookup,
  word: string,
): Promise<DictionaryEntry[]> {
  const lower = word.toLowerCase();
  const accentless = word.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
  const forms = [word, lower, accentless, accentless.toLowerCase()];
  for (const form of [...new Set(forms)]) {
    const rows = await dictionary(form);
    if (rows.length > 0) return rows;
  }
  return [];
}

/** Whether a single-word card front is already a verb infinitive. */
function isInfinitive(word: string, language: TargetLanguage): boolean {
  const normalized = word.trim().toLowerCase();
  return language === 'es'
    ? /(?:ar|er|ir)(?:se)?$/.test(normalized)
    : /(?:ti|ći)$/.test(normalized);
}

/** The first few glosses, as one card back. */
function joinGlosses(rows: DictionaryEntry[]): string {
  const glosses: string[] = [];
  for (const row of rows) {
    const gloss = row.gloss?.trim();
    if (!gloss) continue;
    // A "form of" gloss is a signpost, not a meaning. Alternate forms are
    // sometimes encoded in the gloss rather than Wiktionary's form_of field.
    if (referencedLemma(gloss)) continue;
    if (!glosses.includes(gloss)) glosses.push(gloss);
    if (glosses.length >= MAX_GLOSSES) break;
  }

  return glosses.join(', ').slice(0, MAX_MEANING_LENGTH).trim();
}

/** Extract a headword from Wiktionary's alternate-form glosses. */
function referencedLemma(gloss: string): string | null {
  const match = gloss.match(
    /^(?:an?\s+)?(?:alternative|alternate)\s+(?:form|spelling|variant)\s+of\s+(.+?)[.!?]?$/i,
  );
  if (!match?.[1]) return null;
  // Wiktionary often appends a translated hint — `cacahuete (“peanut”)` —
  // which is useful prose but is not part of the headword lookup key.
  return sanitizeWord(match[1].replace(/\s+[（(].*[)）]\s*$/, '')) || null;
}

/** The subset that produced something, as the `meanings` map an import takes. */
export function meaningsFromResolved(resolved: ResolvedMeaning[]): Record<string, string> {
  const meanings: Record<string, string> = {};
  for (const entry of resolved) {
    if (entry.meaning) meanings[entry.word] = entry.meaning;
  }
  return meanings;
}
