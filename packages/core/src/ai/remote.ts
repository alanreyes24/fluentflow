import type { TargetLanguage } from '../types.js';
import type { InferenceFn, InferenceRequest } from './generate.js';

/**
 * Example generation and translation against a hosted model.
 *
 * This is the same seam the bundled ONNX model plugs into — an
 * {@link InferenceFn} that takes a prompt and returns text — so every part of
 * the pipeline that decides what to ask, what to accept and what to throw away
 * is shared. A hosted model writes better sentences than a 1.5B running on the
 * user's laptop, but it is not more trustworthy about whether a sentence
 * actually contains the word it was meant to demonstrate, so it gets validated
 * exactly as harshly.
 *
 * **Why this is cheap enough to be uninteresting.** Two example sentences cost
 * roughly 150 input and 80 output tokens. At Gemini 2.5 Flash-Lite's
 * $0.10/$0.40 per million that is about $0.00005 a card — five cents for a
 * thousand-word deck, once, because the result is cached by word and written
 * onto the card. The free tier covers a personal deck outright.
 *
 * **Why the key is not in here.** Nothing in this module reads an environment
 * variable or a file. The caller supplies the key, which on the desktop means
 * the main process reading it out of the OS keychain — see apps/desktop/cloud.js.
 * The renderer never holds it.
 */

/**
 * The cheapest model that does this job well, and the default.
 *
 * Picked on price against capability and then measured, September 2026:
 * $0.25 in / $1.50 out per million tokens, six words out of six usable, ~1.9 s
 * a card, and Bosnian that is a real language rather than the word salad the
 * local 1.5B produced. That works out at about five cents per thousand cards.
 *
 * `gemini-2.5-flash-lite` is cheaper on paper ($0.10/$0.40) and was the first
 * choice, but Google has closed it to new keys — it answers a model listing and
 * then refuses the request, which is why the default is a measured model rather
 * than the cheapest row in a pricing table. `gemini-3.5-flash-lite` is both
 * newer and dearer ($0.30/$2.50). Anything called Pro is a different price
 * bracket for a task a Flash-Lite already does well.
 */
export const DEFAULT_REMOTE_MODEL = 'gemini-3.1-flash-lite';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Ask for a JSON array of strings — the shape {@link parseExamples} prefers. */
export const EXAMPLES_SCHEMA = { type: 'ARRAY', items: { type: 'STRING' } } as const;

/**
 * Ask for a JSON array of `{ sentence, translation }` objects.
 *
 * Used for Bosnian, where each example carries an English translation shown
 * beneath it in study. {@link parseExamples} accepts this shape as well as the
 * bare-string one.
 */
export const EXAMPLES_WITH_TRANSLATION_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      sentence: { type: 'STRING' },
      translation: { type: 'STRING' },
    },
    required: ['sentence', 'translation'],
  },
} as const;

/**
 * The response schema for a card's example generation, by target language.
 *
 * Bosnian sentences are generated with an English translation attached; Spanish
 * is a bare string array as before.
 */
export function examplesSchemaFor(language: TargetLanguage): unknown {
  return language === 'bs' ? EXAMPLES_WITH_TRANSLATION_SCHEMA : EXAMPLES_SCHEMA;
}

export interface RemoteInferenceOptions {
  apiKey: string;
  /** Defaults to {@link DEFAULT_REMOTE_MODEL}. */
  model?: string;
  /** Override for tests and for a proxy. Defaults to {@link GEMINI_ENDPOINT}. */
  endpoint?: string;
  /**
   * A response schema the model must fill. Present for example generation,
   * absent for translation, where the answer is a bare phrase.
   */
  responseSchema?: unknown;
  /**
   * Sampling temperature. Slightly warm by default for the same reason the
   * local path samples rather than decoding greedily: asked twice for one
   * sentence, a cold model writes the same sentence twice.
   */
  temperature?: number;
  /** Injectable for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Receives the service-reported token usage after each successful request. */
  onUsage?: (usage: ModelUsage) => void;
}

/** Measured usage for one or more successful hosted-model requests. */
export interface ModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  /** Candidate and thinking tokens, both billed at the output rate. */
  outputTokens: number;
  totalTokens: number;
  /** Cost calculated from measured tokens at the model's published list price. */
  listPriceUsd?: number;
}

/** A hosted call that failed. `retryable` separates "try again" from "fix this". */
export class RemoteInferenceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RemoteInferenceError';
  }
}

/**
 * Build an {@link InferenceFn} backed by the Gemini API.
 *
 * The returned function honours the caller's `maxTokens` and `signal` and
 * ignores `stop` when a response schema is in force — a schema already ends the
 * answer at the closing bracket, and a stop sequence on top of it can only
 * truncate valid JSON into invalid JSON.
 */
export function createRemoteInference(options: RemoteInferenceOptions): InferenceFn {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new RemoteInferenceError('No API key.');

  const model = options.model?.trim() || DEFAULT_REMOTE_MODEL;
  const endpoint = options.endpoint ?? GEMINI_ENDPOINT;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new RemoteInferenceError('This runtime has no fetch.');
  }

  /**
   * Whether this model accepts being told not to think.
   *
   * Asking for a zero thinking budget is worth doing — "write two short
   * sentences" needs no reasoning, and thinking tokens are billed as output at
   * the dearer rate — but which models accept it is not something a model name
   * can be read for. `gemini-3.1-flash-lite` takes it; `gemini-3.5-flash-lite`
   * rejects the whole request with a flat "invalid argument", and the Pro
   * models have a floor above zero. Rather than keep a list that goes stale
   * every release, the first request tries it and a rejection turns it off for
   * the life of this function. The cost of being wrong is one retried request,
   * once, per app run.
   */
  let mayDisableThinking = true;

  const call = async (request: InferenceRequest, disableThinking: boolean): Promise<Response> => {
    const responseSchema = request.responseSchema ?? options.responseSchema;
    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: request.maxTokens,
      candidateCount: 1,
    };

    if (responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = responseSchema;
    } else {
      // Gemini takes at most five, and rejects an empty one.
      const stop = request.stop.filter((sequence) => sequence.length > 0).slice(0, 5);
      if (stop.length > 0) generationConfig.stopSequences = stop;
    }

    if (disableThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    try {
      return await doFetch(`${endpoint}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig,
        }),
        signal: request.signal,
      });
    } catch (error) {
      // An abort is the caller's own doing and must stay an AbortError so the
      // pipeline can tell a cancellation from a failure.
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new RemoteInferenceError(
        `Could not reach the model: ${(error as Error)?.message ?? String(error)}`,
        undefined,
        true,
      );
    }
  };

  return async (request: InferenceRequest): Promise<string> => {
    let response = await call(request, mayDisableThinking);

    // A 400 while asking for no thinking is the model refusing that field, not
    // the prompt being bad — every other 400 survives the retry and is reported
    // normally below.
    if (response.status === 400 && mayDisableThinking) {
      mayDisableThinking = false;
      response = await call(request, false);
    }

    if (!response.ok) throw await httpError(response, model);

    const body = (await response.json()) as GeminiResponse;
    const usage = usageFrom(body, model);
    if (usage) options.onUsage?.(usage);
    const text = textFrom(body);
    if (!text) {
      const blocked = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason;
      throw new RemoteInferenceError(
        blocked ? `The model returned nothing (${blocked}).` : 'The model returned nothing.',
      );
    }
    return text;
  };
}

/** Plain multi-turn chat; no study prompts, tools, or structured output. */
export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export function validateChatMessages(value: unknown): asserts value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 ||
      value.some((message, index) => !message ||
        message.role !== (index % 2 === 0 ? 'user' : 'model') ||
        typeof message.text !== 'string' || !message.text.trim()) ||
      value[value.length - 1].role !== 'user' ||
      value.reduce((size, message) => size + message.text.length, 0) > 100_000) {
    throw new Error('Send a conversation ending with a question (up to 100,000 characters).');
  }
}

export async function chatWithGemini(
  options: RemoteInferenceOptions,
  messages: ChatMessage[],
): Promise<string> {
  validateChatMessages(messages);
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new Error('Add a Gemini API key in Settings to chat.');
  const model = options.model?.trim() || DEFAULT_REMOTE_MODEL;
  const response = await (options.fetchImpl ?? globalThis.fetch)(
    `${options.endpoint ?? GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: messages.map(({ role, text }) => ({ role, parts: [{ text }] })),
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) throw await httpError(response, model);
  const body = await response.json() as GeminiResponse;
  const text = textFrom(body);
  if (!text) throw new Error('Gemini returned no text. Try another question.');
  return text;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

/** Combine per-request measurements into the amount shown for one import. */
export function combineModelUsage(usages: ModelUsage[]): ModelUsage | undefined {
  if (usages.length === 0) return undefined;
  const model = usages[0]?.model ?? '';
  const sameModel = usages.every((usage) => usage.model === model);
  const allPriced = sameModel && usages.every((usage) => usage.listPriceUsd !== undefined);

  return {
    model,
    requests: usages.reduce((sum, usage) => sum + usage.requests, 0),
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
    ...(allPriced
      ? {
          listPriceUsd: roundUsd(
            usages.reduce((sum, usage) => sum + (usage.listPriceUsd ?? 0), 0),
          ),
        }
      : {}),
  };
}

function usageFrom(body: GeminiResponse, model: string): ModelUsage | undefined {
  const metadata = body.usageMetadata;
  if (!metadata) return undefined;
  const inputTokens = tokenCount(metadata.promptTokenCount);
  const outputTokens =
    tokenCount(metadata.candidatesTokenCount) + tokenCount(metadata.thoughtsTokenCount);
  const totalTokens = tokenCount(metadata.totalTokenCount) || inputTokens + outputTokens;
  const listPriceUsd = listPrice(model, inputTokens, outputTokens);

  return {
    model,
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(listPriceUsd === undefined ? {} : { listPriceUsd }),
  };
}

function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Paid standard-tier text rates per million tokens, September 2026. */
function listPrice(model: string, inputTokens: number, outputTokens: number): number | undefined {
  if (model !== 'gemini-3.1-flash-lite') return undefined;
  return (inputTokens * 0.25 + outputTokens * 1.5) / 1_000_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function textFrom(body: GeminiResponse): string {
  return (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

/**
 * Turn an HTTP failure into something worth showing a person.
 *
 * The status codes that matter here are the two a user can act on — a key that
 * is wrong and a quota that is spent — and they are worth naming, because
 * "request failed" sends someone looking at their network instead of at their
 * key.
 */
async function httpError(response: Response, model: string): Promise<RemoteInferenceError> {
  let detail = '';
  try {
    const body = (await response.json()) as GeminiResponse;
    detail = body.error?.message ?? '';
  } catch {
    // A non-JSON error body (a proxy's HTML, usually) tells the user nothing
    // the status code does not.
  }

  const suffix = detail ? ` ${detail}` : '';
  switch (response.status) {
    case 400:
      return new RemoteInferenceError(`The model rejected the request.${suffix}`, 400);
    case 401:
    case 403:
      return new RemoteInferenceError(
        `That API key was refused. Check it in Settings.${suffix}`,
        response.status,
      );
    case 404:
      return new RemoteInferenceError(
        `No model called "${model}" — check the model name in Settings.${suffix}`,
        404,
      );
    case 429:
      return new RemoteInferenceError(
        `Rate limit or quota reached.${suffix}`,
        429,
        true,
      );
    default:
      return new RemoteInferenceError(
        `The model service failed (HTTP ${response.status}).${suffix}`,
        response.status,
        response.status >= 500,
      );
  }
}
