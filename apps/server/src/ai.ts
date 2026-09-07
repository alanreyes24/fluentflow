import {
  createRemoteInference,
  DEFAULT_REMOTE_MODEL,
  EXAMPLES_SCHEMA,
  generateExamples,
  isTargetLanguage,
  resolveMeanings,
  type GenerateExamplesResult,
  type ResolvedMeaning,
  type TargetLanguage,
} from '@fluentflow/core';
import type { Config } from './config.ts';
import { dictionaryLookup, dictionaryStatus, type DictionaryStatus } from './dictionary.ts';

/**
 * The local browser-facing AI proxy.
 *
 * The browser gets status and finished results, never the Gemini credential.
 * This is intentionally backed by the same core inference and validation
 * pipeline used by the desktop shell.
 */

export interface AiStatus {
  cloud: {
    available: boolean;
    configured: boolean;
    reason?: string;
    model: string;
    provider: 'gemini';
    keyUrl: string;
  };
  dictionary: DictionaryStatus;
}

export interface AiRequest {
  config: Config;
}

const KEY_URL = 'https://aistudio.google.com/apikey';
const EXAMPLE_BUDGET_MS = 10_000;
const TRANSLATION_BUDGET_MS = 30_000;
const EXAMPLE_MAX_TOKENS = 128;

export function aiStatus({ config }: AiRequest): AiStatus {
  const model = config.geminiModel || DEFAULT_REMOTE_MODEL;
  const configured = Boolean(config.geminiApiKey?.trim());
  return {
    cloud: {
      available: configured,
      configured,
      ...(configured ? {} : { reason: 'Set GEMINI_API_KEY in .env and restart the local server.' }),
      model,
      provider: 'gemini',
      keyUrl: KEY_URL,
    },
    dictionary: dictionaryStatus(),
  };
}

export async function resolveWithAi(
  { config }: AiRequest,
  words: string[],
  language: string,
  useModel: boolean,
): Promise<ResolvedMeaning[]> {
  if (!isTargetLanguage(language)) throw new Error('Unsupported target language.');
  const infer = useModel ? remoteInference(config) : null;
  const dictionary = dictionaryLookup(language as TargetLanguage);
  return resolveMeanings(words, language as TargetLanguage, {
    dictionary,
    infer,
    budgetMs: TRANSLATION_BUDGET_MS,
  });
}

export function examplesWithAi(
  { config }: AiRequest,
  input: { word: string; meaning?: string; language: string; count?: number },
): Promise<GenerateExamplesResult> {
  if (!isTargetLanguage(input.language)) throw new Error('Unsupported target language.');
  return generateExamples(
    {
      word: input.word,
      meaning: input.meaning,
      language: input.language as TargetLanguage,
      count: input.count,
    },
    {
      infer: remoteInference(config, EXAMPLES_SCHEMA),
      budgetMs: EXAMPLE_BUDGET_MS,
      maxTokens: EXAMPLE_MAX_TOKENS,
      retryOnParseFailure: false,
    },
  );
}

function remoteInference(config: Config, responseSchema?: unknown) {
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) return null;
  return createRemoteInference({
    apiKey,
    model: config.geminiModel,
    responseSchema,
  });
}
