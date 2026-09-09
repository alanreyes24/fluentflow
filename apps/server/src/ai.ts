import {
  createRemoteInference,
  combineModelUsage,
  DEFAULT_REMOTE_MODEL,
  examplesSchemaFor,
  generateExamples,
  isTargetLanguage,
  resolveMeanings,
  type GenerateExamplesResult,
  type ModelUsage,
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
/** Bosnian items carry an English translation, so the answer needs more room. */
const EXAMPLE_MAX_TOKENS_WITH_TRANSLATION = 320;

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
  modelOnly = false,
): Promise<{ meanings: ResolvedMeaning[]; usage?: ModelUsage }> {
  if (!isTargetLanguage(language)) throw new Error('Unsupported target language.');
  const usages: ModelUsage[] = [];
  const infer = useModel ? remoteInference(config, undefined, (usage) => usages.push(usage)) : null;
  const dictionary = modelOnly ? null : dictionaryLookup(language as TargetLanguage);
  const meanings = await resolveMeanings(words, language as TargetLanguage, {
    dictionary,
    infer,
    budgetMs: TRANSLATION_BUDGET_MS,
  });
  return { meanings, usage: combineModelUsage(usages) };
}

export function examplesWithAi(
  { config }: AiRequest,
  input: { word: string; meaning?: string; language: string; count?: number },
): Promise<GenerateExamplesResult> {
  if (!isTargetLanguage(input.language)) throw new Error('Unsupported target language.');
  const language = input.language as TargetLanguage;
  return generateExamples(
    {
      word: input.word,
      meaning: input.meaning,
      language,
      count: input.count,
    },
    {
      infer: remoteInference(config, examplesSchemaFor(language)),
      budgetMs: EXAMPLE_BUDGET_MS,
      maxTokens: language === 'bs' ? EXAMPLE_MAX_TOKENS_WITH_TRANSLATION : EXAMPLE_MAX_TOKENS,
      retryOnParseFailure: false,
    },
  );
}

function remoteInference(
  config: Config,
  responseSchema?: unknown,
  onUsage?: (usage: ModelUsage) => void,
) {
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) return null;
  return createRemoteInference({
    apiKey,
    model: config.geminiModel,
    responseSchema,
    onUsage,
  });
}
