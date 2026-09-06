import type { TargetLanguage } from '../types.js';
import type { InferenceFn } from './generate.js';
import { buildTranslatePrompt, parseTranslation } from './translate.js';

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
  /** There was no dictionary and no model to ask. */
  | 'nothing-to-ask';

export interface ResolvedMeaning {
  word: string;
  /** Empty when nothing usable was found. */
  meaning: string;
  source: MeaningSource;
  /** The headword the meaning came from, when it is not the word itself. */
  lemma?: string;
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
  for (const word of words) {
    const found = deps.dictionary ? await lookUp(deps.dictionary, word) : null;
    if (found) {
      results.push(found);
    } else {
      unresolved.push(results.length);
      results.push({
        word,
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
  let done = words.length - unresolved.length;

  for (const index of unresolved) {
    const entry = results[index];
    if (!entry) continue;
    if (deps.signal?.aborted || now() >= deadline) break;

    try {
      const raw = await deps.infer({
        prompt: buildTranslatePrompt(entry.word, language),
        stop: ['\n'],
        maxTokens: deps.maxTokens ?? 12,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });

      const parsed = parseTranslation(raw, entry.word);
      if (parsed.meaning) {
        results[index] = {
          word: entry.word,
          meaning: parsed.meaning,
          source: 'model',
          needsReview: true,
        };
      } else {
        // The model was asked and produced nothing usable. Throwing it out is
        // the point: a word with no meaning is a word the user can type one
        // for, and a wrong meaning is a card that teaches the wrong thing.
        results[index] = { ...entry, rejected: 'model-rejected' };
      }
    } catch {
      results[index] = { ...entry, rejected: 'model-rejected' };
    }

    deps.onProgress?.(++done, words.length);
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
async function lookUp(dictionary: DictionaryLookup, word: string): Promise<ResolvedMeaning | null> {
  const trimmed = word.trim();
  if (!trimmed) return null;

  const forms = [trimmed, trimmed.toLowerCase()];
  let rows: DictionaryEntry[] = [];
  for (const form of [...new Set(forms)]) {
    rows = await dictionary(form);
    if (rows.length > 0) break;
  }
  if (rows.length === 0) return null;

  // An inflected form: follow it once to the word it inflects. Once, not in a
  // loop — a data error that made two forms point at each other would
  // otherwise hang the import.
  const lemma = rows[0]?.lemma ?? null;
  if (lemma && lemma !== trimmed) {
    const lemmaRows = await dictionary(lemma);
    if (lemmaRows.length > 0) {
      const meaning = joinGlosses(lemmaRows);
      if (meaning) {
        return { word: trimmed, meaning, source: 'dictionary', lemma, needsReview: false };
      }
    }
  }

  const meaning = joinGlosses(rows);
  if (!meaning) return null;
  return { word: trimmed, meaning, source: 'dictionary', needsReview: false };
}

/** The first few glosses, as one card back. */
function joinGlosses(rows: DictionaryEntry[]): string {
  const glosses: string[] = [];
  for (const row of rows) {
    const gloss = row.gloss?.trim();
    if (!gloss) continue;
    // A "form of" gloss is a signpost, not a meaning: it is only useful when
    // the lemma could not be followed, and never as the whole card back.
    if (glosses.length > 0 && /\b(of|form of)\b/.test(gloss) && /\bof\s+\S+$/.test(gloss)) continue;
    if (!glosses.includes(gloss)) glosses.push(gloss);
    if (glosses.length >= MAX_GLOSSES) break;
  }

  return glosses.join(', ').slice(0, MAX_MEANING_LENGTH).trim();
}

/** The subset that produced something, as the `meanings` map an import takes. */
export function meaningsFromResolved(resolved: ResolvedMeaning[]): Record<string, string> {
  const meanings: Record<string, string> = {};
  for (const entry of resolved) {
    if (entry.meaning) meanings[entry.word] = entry.meaning;
  }
  return meanings;
}
