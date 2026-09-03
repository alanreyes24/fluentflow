import type { TargetLanguage } from './types.js';

/**
 * Guess a deck's target language from its name (and any Anki metadata that
 * came with it). Anki decks are named by their owner, not by a schema, so this
 * is a best-effort heuristic — the import screen always lets the user override.
 */

interface LanguageHints {
  /** Words that name the language, in several languages. */
  names: string[];
  /** Diacritics/letters that are strong evidence when found in card text. */
  characters: RegExp;
  /** Function words that are common enough to be a decent signal. */
  stopWords: string[];
}

const HINTS: Record<TargetLanguage, LanguageHints> = {
  es: {
    names: ['spanish', 'espanol', 'español', 'espanhol', 'castellano', 'spanisch', 'spagnolo'],
    characters: /[ñáéíóúü¿¡]/i,
    stopWords: ['el', 'la', 'los', 'las', 'que', 'de', 'por', 'para', 'con', 'una', 'está'],
  },
  bs: {
    names: ['bosnian', 'bosanski', 'bosnisch', 'bosnia', 'bosna', 'serbo-croatian', 'bhs'],
    characters: /[čćžšđ]/i,
    stopWords: ['je', 'su', 'na', 'sa', 'ali', 'kako', 'koji', 'nije', 'ovo', 'ima'],
  },
};

/** Locale-ish tags that may appear in a deck name, e.g. "Core 2k [es-MX]". */
const TAG_PATTERN = /\b(es|spa|spanish|bs|bos|bosnian|hbs|sh)(?:[-_][a-z]{2})?\b/gi;
const TAG_TO_LANGUAGE: Record<string, TargetLanguage> = {
  es: 'es',
  spa: 'es',
  spanish: 'es',
  bs: 'bs',
  bos: 'bs',
  bosnian: 'bs',
  hbs: 'bs',
  sh: 'bs',
};

export interface LanguageDetection {
  language: TargetLanguage;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * @param deckName   the deck's name, e.g. "Spanish A1 Vocabulary"
 * @param sampleText optional concatenated card text used as a tiebreaker
 * @param fallback   returned when nothing matches
 */
export function detectLanguage(
  deckName: string,
  sampleText = '',
  fallback: TargetLanguage = 'es',
): LanguageDetection {
  const name = normalize(deckName);

  for (const language of Object.keys(HINTS) as TargetLanguage[]) {
    const hit = HINTS[language].names.find((n) => name.includes(normalize(n)));
    if (hit) {
      return { language, confidence: 'high', reason: `deck name contains "${hit}"` };
    }
  }

  const tags = deckName.match(TAG_PATTERN) ?? [];
  for (const tag of tags) {
    const key = tag.toLowerCase().split(/[-_]/)[0] ?? '';
    const language = TAG_TO_LANGUAGE[key];
    if (language) {
      return { language, confidence: 'medium', reason: `deck name has language tag "${tag}"` };
    }
  }

  if (sampleText) {
    const scores = (Object.keys(HINTS) as TargetLanguage[]).map((language) => ({
      language,
      score: scoreText(sampleText, HINTS[language]),
    }));
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    const runnerUp = scores[1];
    if (best && best.score > 0 && (!runnerUp || best.score > runnerUp.score)) {
      return { language: best.language, confidence: 'medium', reason: 'card text matches script' };
    }
  }

  return { language: fallback, confidence: 'low', reason: 'no signal, using default' };
}

function scoreText(text: string, hints: LanguageHints): number {
  const lower = text.toLowerCase();
  // Diacritics are the strongest signal, so weight them well above stop words.
  const diacritics = (lower.match(new RegExp(hints.characters.source, 'gi')) ?? []).length;
  const words = new Set(lower.split(/[^\p{L}]+/u).filter(Boolean));
  const stopWords = hints.stopWords.filter((w) => words.has(w)).length;
  return diacritics * 3 + stopWords;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}
