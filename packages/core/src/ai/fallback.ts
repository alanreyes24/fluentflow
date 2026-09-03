import type { TargetLanguage } from '../types.js';

/**
 * Offline fallback for when the bundled model is missing, still loading, too
 * slow, or produced output that failed validation.
 *
 * These are *carrier sentences*: the target word is quoted in its dictionary
 * form rather than inflected into the sentence. Getting agreement and case
 * right without a model is not something a template can do honestly for either
 * Spanish or Bosnian, so the fallback stays grammatical by quoting instead of
 * conjugating. The UI labels these as offline examples so nobody mistakes them
 * for generated usage.
 */

const FRAMES: Record<TargetLanguage, ((word: string) => string)[]> = {
  es: [
    (w) => `Hoy aprendí la palabra «${w}».`,
    (w) => `¿Cómo se usa «${w}» en una frase?`,
    (w) => `Quiero practicar «${w}» otra vez mañana.`,
    (w) => `No estoy seguro del significado de «${w}».`,
  ],
  bs: [
    (w) => `Danas sam naučio riječ „${w}".`,
    (w) => `Kako se koristi „${w}" u rečenici?`,
    (w) => `Želim ponoviti „${w}" sutra.`,
    (w) => `Nisam siguran šta znači „${w}".`,
  ],
};

/** Bilingual frame used when the card's translation is known. */
const TRANSLATION_FRAMES: Record<TargetLanguage, (word: string, meaning: string) => string> = {
  es: (w, m) => `«${w}» significa "${m}".`,
  bs: (w, m) => `„${w}" znači "${m}".`,
};

export interface FallbackOptions {
  word: string;
  language: TargetLanguage;
  meaning?: string;
  count?: number;
  /** Seed for frame selection, so the same card always shows the same examples. */
  seed?: string;
}

export function fallbackExamples(options: FallbackOptions): string[] {
  const count = Math.max(1, Math.min(options.count ?? 2, 3));
  const word = options.word.trim();
  if (!word) return [];

  const frames = FRAMES[options.language];
  const results: string[] = [];

  if (options.meaning?.trim()) {
    results.push(TRANSLATION_FRAMES[options.language](word, options.meaning.trim()));
  }

  const offset = hash(options.seed ?? word) % frames.length;
  for (let i = 0; results.length < count && i < frames.length; i++) {
    const frame = frames[(offset + i) % frames.length];
    if (frame) results.push(frame(word));
  }

  return results.slice(0, count);
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}
