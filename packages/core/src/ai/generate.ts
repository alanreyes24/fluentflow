import type { TargetLanguage } from '../types.js';
import { buildPrompt, STOP_SEQUENCES } from './prompt.js';
import { parseExamples } from './parse.js';
import { fallbackExamples } from './fallback.js';

/**
 * The generation pipeline, kept free of platform APIs so it can be unit tested
 * and reused by the app, the server and the CLI.
 *
 * The design constraint that shapes everything here: a card reveal must not
 * feel blocked. The budget is a hard deadline, not a target — when it is spent,
 * the fallback ships and the model result is discarded, because a learner
 * staring at a spinner is a worse outcome than a generic example sentence.
 */

export type ExampleSource = 'cache' | 'model' | 'fallback';

export interface InferenceRequest {
  prompt: string;
  stop: string[];
  maxTokens: number;
  /** Optional per-request Gemini response schema for structured output. */
  responseSchema?: unknown;
  signal?: AbortSignal;
}

/**
 * Turns a prompt into text. The one seam every backend plugs into — today the
 * hosted model in ai/remote.ts, and a stub in the tests.
 */
export type InferenceFn = (request: InferenceRequest) => Promise<string>;

export interface GenerateExamplesInput {
  word: string;
  meaning?: string;
  language: TargetLanguage;
  count?: number;
  /** Examples already stored on the card; short-circuits the whole pipeline. */
  cached?: string[];
}

export interface GenerateExamplesDeps {
  infer?: InferenceFn | null;
  /** Hard deadline for inference, in milliseconds. */
  budgetMs?: number;
  maxTokens?: number;
  /**
   * Allow a second attempt when the first produced fewer usable sentences than
   * were asked for. The retry asks a deliberately different question — see the
   * loop below for why an identical one would be pointless.
   */
  retryOnParseFailure?: boolean;
  /**
   * Cancels the run from outside, as distinct from the budget's own deadline.
   *
   * The two are different to the caller even though they look identical to the
   * decode loop. A spent budget means "this is taking too long, ship what you
   * have"; a cancellation means "nobody wants this any more", and its partial
   * output should be thrown away rather than cached. Callers tell them apart by
   * checking the signal, which is theirs.
   */
  signal?: AbortSignal;
  now?: () => number;
}

export interface GenerateExamplesResult {
  examples: string[];
  /**
   * English translations aligned with `examples`, when the model returned them
   * (the Bosnian path). Absent for Spanish and for the written fallback.
   */
  translations?: string[];
  source: ExampleSource;
  /** Wall-clock time spent on inference, in milliseconds. */
  durationMs: number;
  attempts: number;
  /** Set when the model was tried and did not produce usable output. */
  error?: string;
}

export const DEFAULT_BUDGET_MS = 2000;
export const DEFAULT_MAX_TOKENS = 96;

export async function generateExamples(
  input: GenerateExamplesInput,
  deps: GenerateExamplesDeps = {},
): Promise<GenerateExamplesResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const count = input.count ?? 2;

  if (input.cached && input.cached.length > 0) {
    return { examples: input.cached.slice(0, count), source: 'cache', durationMs: 0, attempts: 0 };
  }

  const fallback = () =>
    fallbackExamples({
      word: input.word,
      language: input.language,
      meaning: input.meaning,
      count,
      seed: `${input.word}:${input.language}`,
    });

  if (!deps.infer) {
    return { examples: fallback(), source: 'fallback', durationMs: 0, attempts: 0 };
  }

  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxAttempts = deps.retryOnParseFailure ? 2 : 1;
  const controller = new AbortController();

  // The caller's signal and the deadline below both end at the same place: the
  // one controller the inference actually sees.
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let attempts = 0;
  let lastError = 'no usable output';
  /** The best set of sentences any attempt has produced so far. */
  let best: string[] = [];
  /** Translations for `best`, kept in step with it. Undefined for Spanish. */
  let bestTranslations: string[] | undefined;

  // Aborting makes the inference promise reject on its own, and that rejection
  // usually wins the race against the deadline's. The flag keeps the reported
  // reason accurate ("budget", not whatever the backend calls cancellation).
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(budgetMessage(budgetMs)));
    }, budgetMs);
    timer.unref?.();
  });

  try {
    while (attempts < maxAttempts) {
      attempts++;

      // Asking for one more sentence than is needed, rather than repeating the
      // question. Core cannot see how the backend decodes, and a deterministic
      // one returns the same tokens for the same prompt — so a retry that asks
      // the identical question is a second request for a guaranteed identical
      // answer, billed twice. A wider ask diverges either way, and it also
      // covers the case the retry usually exists for: a model that wrote two
      // sentences but only one usable one, or wrote the same sentence twice.
      const ask = attempts === 1 ? count : count + 1;
      const prompt = buildPrompt({
        word: input.word,
        meaning: input.meaning,
        language: input.language,
        count: ask,
      });

      const raw = await Promise.race([
        deps.infer({
          prompt,
          stop: STOP_SEQUENCES,
          maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
          signal: controller.signal,
        }),
        deadline,
      ]);

      const parsed = parseExamples(raw, {
        word: input.word,
        language: input.language,
        max: ask,
      });

      // `parseExamples` drops duplicates, so this counts distinct sentences —
      // which is what was asked for. Two copies of one sentence is one example.
      if (parsed.examples.length > best.length) {
        best = parsed.examples;
        bestTranslations = parsed.translations;
      }

      if (best.length >= count) {
        return {
          examples: best.slice(0, count),
          ...(bestTranslations ? { translations: bestTranslations.slice(0, count) } : {}),
          source: 'model',
          durationMs: now() - started,
          attempts,
        };
      }

      lastError = parsed.rejected[0]
        ? `output rejected: ${parsed.rejected[0].reason}`
        : 'model returned no parsable sentences';
    }
  } catch (error) {
    lastError = timedOut
      ? budgetMessage(budgetMs)
      : error instanceof Error
        ? error.message
        : String(error);
  } finally {
    // Speculative generation runs this many times per session rather than once
    // per reveal, so a timer left armed for every call is worth clearing.
    clearTimeout(timer);
    controller.abort();
  }

  // Fewer sentences than asked for, but real ones. A single genuine usage beats
  // two carrier phrases that quote the word instead of inflecting it, so a
  // short result ships as a model result rather than being thrown away.
  if (best.length > 0) {
    return {
      examples: best,
      ...(bestTranslations ? { translations: bestTranslations } : {}),
      source: 'model',
      durationMs: now() - started,
      attempts,
      error: `only ${best.length} of ${count} sentences were usable`,
    };
  }

  return {
    examples: fallback(),
    source: 'fallback',
    durationMs: now() - started,
    attempts,
    error: lastError,
  };
}

function budgetMessage(budgetMs: number): string {
  return `inference exceeded the ${budgetMs}ms budget`;
}
