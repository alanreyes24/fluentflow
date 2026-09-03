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
  /** Which strategy produced the result; surfaced in debug builds. */
  strategy: 'json' | 'bracket' | 'quoted' | 'lines' | 'none';
  /** Candidates that were dropped, with the reason. Useful when tuning prompts. */
  rejected: { text: string; reason: string }[];
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
    for (const candidate of candidates) {
      const text = tidy(candidate);
      if (!text) continue;
      const reason = rejectionReason(text, config);
      if (reason) {
        rejected.push({ text, reason });
        continue;
      }
      if (!accepted.some((existing) => equivalent(existing, text))) {
        accepted.push(text);
      }
      if (accepted.length >= config.max) break;
    }
    if (accepted.length > 0) {
      return { examples: accepted, strategy, rejected };
    }
  }

  return { examples: [], strategy: 'none', rejected };
}

/** Ordered extraction attempts, cheapest and most reliable first. */
function extractionStrategies(text: string): [ParsedExamples['strategy'], string[]][] {
  return [
    ['json', fromJson(text)],
    ['bracket', fromBracket(text)],
    ['quoted', fromQuoted(text)],
    ['lines', fromLines(text)],
  ];
}

function fromJson(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Find the first `[...]` anywhere in the output, repairing a truncated tail. */
function fromBracket(text: string): string[] {
  const start = text.indexOf('[');
  if (start === -1) return [];
  const end = text.indexOf(']', start);
  const slice = end === -1 ? `${text.slice(start)}"]` : text.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(slice);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Fall through to a looser read of the same slice.
  }
  return fromQuoted(slice);
}

function fromQuoted(text: string): string[] {
  const matches = text.match(/"([^"\n]{3,})"/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

function fromLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
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

  const stem = stemOf(needle);
  if (stem.length < 3) return false;
  return haystack.split(/[^a-z0-9]+/).some((token) => token.startsWith(stem));
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
