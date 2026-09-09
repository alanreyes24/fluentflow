import type { TargetLanguage } from '../types.js';

/**
 * Turning raw model output into example sentences.
 *
 * A 1.1B model asked for `["a", "b"]` returns that maybe two-thirds of the
 * time. The rest is numbered lists, markdown fences, a preamble ("Sure! Here
 * are two sentences:"), a truncated array, or the prompt echoed back. Parsing
 * therefore degrades through several strategies, and every candidate is then
 * validated — a sentence that does not contain the word it was supposed to
 * demonstrate is worse than no sentence at all.
 */

export interface ParseOptions {
  word: string;
  language: TargetLanguage;
  max?: number;
  minWords?: number;
  maxWords?: number;
}

export interface ParsedExamples {
  examples: string[];
  /**
   * English translations, one per accepted sentence, in the same order as
   * `examples`. Present only when the model returned a translation for every
   * accepted sentence (the Bosnian path — see {@link ExamplePromptInput}).
   */
  translations?: string[];
  /** Which strategy produced the result; surfaced in debug builds. */
  strategy: 'json' | 'bracket' | 'quoted' | 'lines' | 'none';
  /** Candidates that were dropped, with the reason. Useful when tuning prompts. */
  rejected: { text: string; reason: string }[];
}

/**
 * One extracted sentence before validation. The model may return bare strings
 * (Spanish) or `{ sentence, translation }` objects (Bosnian); both land here.
 */
interface Candidate {
  text: string;
  translation?: string;
}

const DEFAULTS = { max: 3, minWords: 3, maxWords: 20 };

/** Characters that legitimately appear in Spanish and Bosnian sentences. */
const ALLOWED_CHARS: Record<TargetLanguage, RegExp> = {
  es: /^[\p{L}\p{M}0-9\s.,;:!?'"()¿¡—–-]+$/u,
  bs: /^[\p{L}\p{M}0-9\s.,;:!?'"()—–-]+$/u,
};

export function parseExamples(raw: string, options: ParseOptions): ParsedExamples {
  const config = { ...DEFAULTS, ...options };
  const cleaned = stripScaffolding(raw);
  const rejected: ParsedExamples['rejected'] = [];

  for (const [strategy, candidates] of extractionStrategies(cleaned)) {
    const accepted: string[] = [];
    const acceptedTranslations: (string | undefined)[] = [];
    for (const candidate of candidates) {
      const text = tidy(candidate.text);
      if (!text) continue;
      const reason = rejectionReason(text, config);
      if (reason) {
        rejected.push({ text, reason });
        continue;
      }
      if (!accepted.some((existing) => equivalent(existing, text))) {
        accepted.push(text);
        acceptedTranslations.push(tidyTranslation(candidate.translation));
      }
      if (accepted.length >= config.max) break;
    }
    if (accepted.length > 0) {
      // Only surface translations when every accepted sentence has one — a
      // partial set would be worse than none, silently mislabelling a sentence.
      const translations = acceptedTranslations.every((value): value is string => Boolean(value))
        ? acceptedTranslations
        : undefined;
      return { examples: accepted, ...(translations ? { translations } : {}), strategy, rejected };
    }
  }

  return { examples: [], strategy: 'none', rejected };
}

/** Ordered extraction attempts, cheapest and most reliable first. */
function extractionStrategies(text: string): [ParsedExamples['strategy'], Candidate[]][] {
  return [
    ['json', fromJson(text)],
    ['bracket', fromBracket(text)],
    ['quoted', fromQuoted(text)],
    ['lines', fromLines(text)],
  ];
}

/** A JSON array item is either a bare sentence or a `{ sentence, translation }`. */
function toCandidate(value: unknown): Candidate | null {
  if (typeof value === 'string') return { text: value };
  if (value && typeof value === 'object') {
    const record = value as { sentence?: unknown; translation?: unknown };
    if (typeof record.sentence === 'string') {
      return {
        text: record.sentence,
        translation: typeof record.translation === 'string' ? record.translation : undefined,
      };
    }
  }
  return null;
}

function fromJson(text: string): Candidate[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(toCandidate).filter((c): c is Candidate => c !== null);
  } catch {
    return [];
  }
}

/** Find the first `[...]` anywhere in the output, repairing a truncated tail. */
function fromBracket(text: string): Candidate[] {
  const start = text.indexOf('[');
  if (start === -1) return [];
  const end = text.indexOf(']', start);
  const slice = end === -1 ? `${text.slice(start)}"]` : text.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(slice);
    if (Array.isArray(parsed)) {
      return parsed.map(toCandidate).filter((c): c is Candidate => c !== null);
    }
  } catch {
    // Fall through to a looser read of the same slice.
  }
  return fromQuoted(slice);
}

function fromQuoted(text: string): Candidate[] {
  const matches = text.match(/"([^"\n]{3,})"/g) ?? [];
  return matches.map((m) => ({ text: m.slice(1, -1) }));
}

function fromLines(text: string): Candidate[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map((line) => ({ text: line }));
}

/** Remove markdown fences, chat-template markers and lead-in chatter. */
function stripScaffolding(raw: string): string {
  let text = raw.replace(/```(?:json)?/gi, ' ');
  text = text.replace(/<\|(?:system|user|assistant|endoftext|im_start|im_end)\|>/gi, ' ');
  text = text.replace(/<\/?s>/g, ' ');
  // "Sure! Here are two example sentences:" and its localised cousins.
  text = text.replace(
    /^[^[\n"]{0,120}?(?:sentences?|frases?|rečenice|recenice|oraciones|ejemplos?)\s*[:.]\s*/i,
    '',
  );
  return text.trim();
}

function tidy(candidate: string): string {
  return candidate
    .replace(/\\n/g, ' ')
    .replace(/^[\s"'`,[\]-]+/, '')
    .replace(/[\s"'`,[\]]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim a translation to a clean single line, or drop it if there is nothing left. */
function tidyTranslation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`]+/, '')
    .replace(/[\s"'`]+$/, '')
    .trim();
  return cleaned || undefined;
}

function rejectionReason(
  text: string,
  config: Required<ParseOptions>,
): string | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < config.minWords) return 'too short';
  if (words.length > config.maxWords) return 'too long';

  const allowed = ALLOWED_CHARS[config.language];
  if (allowed && !allowed.test(text)) return 'contains unexpected characters';

  // The model sometimes returns the instruction rather than an answer.
  if (/\b(?:json|array|format|instruct|generate \d)\b/i.test(text)) return 'echoes the prompt';

  if (!containsWord(text, config.word)) return 'does not use the word';

  return null;
}

/**
 * Match the target word allowing for inflection: Spanish and Bosnian both
 * decline heavily, so `hablar` legitimately appears as `habla` or `hablamos`,
 * and `knjiga` as `knjigu`. Comparing on a truncated stem catches those without
 * needing a morphological analyser on device.
 */
export function containsWord(sentence: string, word: string): boolean {
  const haystack = fold(sentence);
  const needle = fold(word);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  const sentenceTokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
  const targetTokens = needle.split(/[^a-z0-9]+/).filter(Boolean);

  // A phrase needs phrase matching, not a stem of the entire string. The old
  // code turned `entrar a la fuerza en` into `entrar a la fue`, which can never
  // match a sentence token. This also handles the natural Spanish variant
  // `entró por la fuerza en ...` that the prompt explicitly asks Gemini to use.
  if (targetTokens.length > 1) {
    return sentenceTokens.some((_, start) => matchesPhraseAt(sentenceTokens, targetTokens, start));
  }

  return sentenceTokens.some((token) => tokenMatches(token, targetTokens[0] ?? ''));
}

function matchesPhraseAt(sentenceTokens: string[], targetTokens: string[], start: number): boolean {
  if (start + targetTokens.length > sentenceTokens.length) return false;

  return targetTokens.every((target, offset) => {
    const actual = sentenceTokens[start + offset];
    return actual !== undefined && (tokenMatches(actual, target) || connectorVariant(actual, target));
  });
}

function tokenMatches(actual: string, target: string): boolean {
  if (actual === target) return true;

  // Spanish infinitives often surface as a conjugated form: `entrar` ->
  // `entró`, `hablar` -> `hablamos`. Keep this deliberately conservative for
  // ordinary single-word matching while allowing the phrase case to use it.
  const stem = /(?:ar|er|ir)$/.test(target) ? target.slice(0, -2) : stemOf(target);
  return stem.length >= 3 && actual.startsWith(stem);
}

/** Common Spanish collocation alternation: `entrar a la fuerza` / `entrar por la fuerza`. */
function connectorVariant(actual: string, target: string): boolean {
  return (target === 'a' && actual === 'por') || (target === 'por' && actual === 'a');
}

function stemOf(word: string): string {
  // Drop a short inflectional tail; 4 characters is enough to stay specific for
  // the vocabulary lengths this app deals with.
  const keep = Math.max(4, Math.ceil(word.length * 0.7));
  return word.slice(0, keep);
}

function equivalent(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}
