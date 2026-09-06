import { LANGUAGE_NAMES_EN, type TargetLanguage } from '../types.js';
import type { InferenceFn } from './generate.js';

/**
 * Word translation with the on-device model.
 *
 * This exists because a pasted vocabulary list often has no meanings on it —
 * just the words — and typing twelve translations by hand is the work the app
 * was supposed to save.
 *
 * **What it is honest about.** A small instruct model translates common words
 * well and invents plausible answers for uncommon ones, which is precisely
 * backwards for flashcards: nobody makes a card for "the dog". Measured on
 * Qwen2.5-1.5B, roughly ten words in fourteen came back usable and the rest
 * were confident nonsense — `lodazal` as "lodestar", `encestar` as "to be
 * born". The model cannot tell you which four.
 *
 * So nothing here writes a card. Every translation comes back marked
 * {@link WordTranslation.needsReview}, and the caller is expected to put it in
 * front of the user before it becomes anything. The model is a first draft, not
 * an authority — which is also why `confidence` is deliberately absent: a
 * number the model made up about its own output would only make the guessing
 * look rigorous.
 *
 * The validation below throws away the answers that are obviously junk. It
 * cannot catch a wrong translation, only a malformed one.
 */

/** Few-shot pairs, chosen to fix the output shape rather than teach vocabulary. */
const EXAMPLES: Record<TargetLanguage, [string, string][]> = {
  es: [
    ['hablar', 'to speak'],
    ['la casa', 'the house'],
    ['rápidamente', 'quickly'],
  ],
  bs: [
    ['govoriti', 'to speak'],
    ['kuća', 'house'],
    ['brzo', 'quickly'],
  ],
};

const SYSTEM = (language: string): string =>
  `You are a ${language}-English dictionary. For each ${language} word you reply with only ` +
  'its English translation: a word or a short phrase, nothing else. No sentences, no ' +
  'explanation, no quotation marks. If you do not know the word, reply exactly: ?';

/**
 * Build the prompt for one word.
 *
 * One word per request, not a batch. A batch shares a forward pass and is
 * tempting, but a model that drops or reorders one line of a twelve-line answer
 * silently misaligns every translation after it — and the failure looks exactly
 * like a bad translation rather than a parsing bug.
 */
export function buildTranslatePrompt(word: string, language: TargetLanguage): string {
  const languageName = LANGUAGE_NAMES_EN[language];
  const shots = EXAMPLES[language]
    .map(([from, to]) => `${from} = ${to}`)
    .join('\n');
  return `${SYSTEM(languageName)}\n\n${shots}\n${word} =`;
}

/** A word that has no meaning in the paste, with what the model made of it. */
export interface WordTranslation {
  word: string;
  /** The model's answer, cleaned up. Empty when nothing usable came back. */
  meaning: string;
  /**
   * Always true for a generated meaning. It is a field rather than an implicit
   * rule so that a caller cannot forget which side of the line a value is on.
   */
  needsReview: true;
  /** Why the model's answer was thrown away, when it was. */
  rejected?: 'empty' | 'unknown' | 'echoed-the-word' | 'a-sentence' | 'not-english';
}

const MAX_WORDS_IN_MEANING = 6;

/**
 * Clean and check one answer.
 *
 * Everything here is a shape check. "empapar" coming back as "to wrap" is a
 * wrong translation and passes every one of them, which is the point of the
 * review step.
 */
export function parseTranslation(raw: string, word: string): WordTranslation {
  const base: Omit<WordTranslation, 'rejected'> = { word, meaning: '', needsReview: true };

  // The first line is the answer; small models like to add a second one.
  const firstLine = (raw ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';

  const cleaned = firstLine
    // Instruct models wrap answers in quotes about a third of the time.
    .replace(/^["'“”«»]+|["'“”«».]+$/g, '')
    // "empapar: to soak" and "empapar = to soak" both happen.
    .replace(new RegExp(`^${escapeRegExp(word)}\\s*[=:\\-–]\\s*`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return { ...base, rejected: 'empty' };
  // The prompt asks for "?" when the model does not know the word. It rarely
  // takes the offer, but an answer that admits ignorance is worth honouring.
  if (/^[?¿]+$/.test(cleaned)) return { ...base, rejected: 'unknown' };
  if (cleaned.toLowerCase() === word.toLowerCase()) return { ...base, rejected: 'echoed-the-word' };

  const words = cleaned.split(/\s+/);
  if (words.length > MAX_WORDS_IN_MEANING) return { ...base, rejected: 'a-sentence' };

  // An answer still carrying the word it was asked about is an explanation
  // ("empapar means to soak"), not a translation.
  if (new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(cleaned)) {
    return { ...base, rejected: 'echoed-the-word' };
  }

  // Latin-1 letters are fine — "naïve" is English enough — but an answer in the
  // source language's script is the model refusing to translate.
  if (!/[a-z]/i.test(cleaned)) return { ...base, rejected: 'not-english' };

  return { ...base, meaning: cleaned };
}

export interface TranslateWordsDeps {
  infer: InferenceFn;
  maxTokens?: number;
  /** Hard deadline for the whole run. What is done by then is what you get. */
  budgetMs?: number;
  signal?: AbortSignal;
  /** Called after each word, for a progress bar over a long list. */
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
}

/**
 * Translate a list of words, one request each.
 *
 * The budget is a deadline for the whole list rather than per word, and the
 * words not reached come back with an empty meaning like any other failure —
 * a partially translated list is still useful, and a half-finished run that
 * throws away its own work is not.
 */
export async function translateWords(
  words: string[],
  language: TargetLanguage,
  deps: TranslateWordsDeps,
): Promise<WordTranslation[]> {
  const now = deps.now ?? (() => Date.now());
  const deadline = deps.budgetMs ? now() + deps.budgetMs : Infinity;
  const results: WordTranslation[] = [];

  for (const [index, word] of words.entries()) {
    if (deps.signal?.aborted || now() >= deadline) {
      results.push({ word, meaning: '', needsReview: true, rejected: 'empty' });
      continue;
    }

    try {
      const raw = await deps.infer({
        prompt: buildTranslatePrompt(word, language),
        // A translation is a few tokens. Stopping on a newline keeps a chatty
        // model from spending the budget — and the output tokens — explaining
        // itself.
        stop: ['\n'],
        maxTokens: deps.maxTokens ?? 12,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      results.push(parseTranslation(raw, word));
    } catch {
      results.push({ word, meaning: '', needsReview: true, rejected: 'empty' });
    }

    deps.onProgress?.(index + 1, words.length);
  }

  return results;
}

/** The subset that produced something, as the `meanings` map an import takes. */
export function meaningsFrom(translations: WordTranslation[]): Record<string, string> {
  const meanings: Record<string, string> = {};
  for (const entry of translations) {
    if (entry.meaning) meanings[entry.word] = entry.meaning;
  }
  return meanings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
