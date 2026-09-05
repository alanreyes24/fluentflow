import type { TargetLanguage } from '../types.js';
import { buildPrompt, STOP_SEQUENCES, type ModelFamily } from './prompt.js';
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
  signal?: AbortSignal;
  /** Prepend the model's BOS token. Chat templates supply their own opener. */
  addBos?: boolean;
}

/** Runs the bundled model. Implemented per platform (ONNX Runtime, llama.cpp). */
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
  family?: ModelFamily;
  /** Hard deadline for inference, in milliseconds. */
  budgetMs?: number;
  maxTokens?: number;
  /** Retry once when the first response fails validation. */
  retryOnParseFailure?: boolean;
  now?: () => number;
}

export interface GenerateExamplesResult {
  examples: string[];
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

  const family = deps.family ?? 'tinyllama';
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxAttempts = deps.retryOnParseFailure ? 2 : 1;
  const controller = new AbortController();

  let attempts = 0;
  let lastError = 'no usable output';

  // Aborting makes the inference promise reject on its own, and that rejection
  // usually wins the race against the deadline's. The flag keeps the reported
  // reason accurate ("budget", not whatever the backend calls cancellation).
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(budgetMessage(budgetMs)));
    }, budgetMs);
    timer.unref?.();
  });

  try {
    while (attempts < maxAttempts) {
      attempts++;
      const prompt = buildPrompt(
        { word: input.word, meaning: input.meaning, language: input.language, count },
        family,
      );

      const raw = await Promise.race([
        deps.infer({
          prompt,
          stop: STOP_SEQUENCES[family],
          maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
          signal: controller.signal,
        }),
        deadline,
      ]);

      const parsed = parseExamples(raw, {
        word: input.word,
        language: input.language,
        max: count,
      });

      if (parsed.examples.length > 0) {
        return {
          examples: parsed.examples.slice(0, count),
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
    controller.abort();
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
