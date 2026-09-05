import {
  generateExamples,
  type Card,
  type ExampleSource,
  type GenerateExamplesResult,
  type InferenceFn,
} from '@fluentflow/core';
import type { Repository } from '../db/repository';
import { appConfig } from '../firebase/config';
import { exampleBridgeAvailable, generateExamplesOnDesktop } from './desktop';
import { createInference } from './model';

/**
 * Example generation as the UI sees it.
 *
 * Three layers, cheapest first:
 *
 *  1. Examples already on the card (imported, or generated on another device
 *     and synced down).
 *  2. The `example_cache` table, keyed by word rather than card, so a word that
 *     appears in two decks is only ever generated once.
 *  3. The model, under a hard time budget, falling back to written carrier
 *     sentences.
 *
 * A successful generation is written back to both the cache and the card, which
 * is what gets it onto the user's other devices — the card is a synced record,
 * the cache is not.
 *
 * Where layer 3 runs depends on what is hosting the bundle, and the difference
 * is not cosmetic. On a phone the model is loaded in this process through
 * `onnxruntime-react-native`. In the desktop shell that module cannot load at
 * all — it is a native *mobile* module — so inference happens in Electron's
 * main process and this asks for the finished sentences over IPC. Before that
 * bridge existed the desktop had no third layer, which is why every reveal
 * showed a carrier sentence quoting the word rather than using it.
 *
 * In a plain browser tab there is still no model and still no bridge, and the
 * fallback remains the honest answer.
 */

export interface ExampleResult {
  examples: string[];
  source: ExampleSource;
  durationMs: number;
  /** Present when the model was tried and did not produce usable output. */
  error?: string;
}

export class ExampleService {
  private inference: InferenceFn | null | undefined;
  /** In-flight requests, keyed by word, so a double tap runs one inference. */
  private readonly pending = new Map<string, Promise<ExampleResult>>();

  constructor(private readonly repository: Repository) {}

  /**
   * Examples for a card, generating them if needed.
   *
   * @param card    the card being revealed
   * @param force   ignore every cache and re-run the model
   */
  async forCard(card: Card, force = false): Promise<ExampleResult> {
    if (!force && card.examples.length > 0) {
      return { examples: card.examples, source: 'cache', durationMs: 0 };
    }

    const key = `${card.language}:${card.front.trim().toLowerCase()}`;
    const existing = this.pending.get(key);
    if (existing && !force) return existing;

    const request = this.generate(card, force).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  private async generate(card: Card, force: boolean): Promise<ExampleResult> {
    if (!force) {
      const cached = await this.repository.getCachedExamples(card.front, card.language);
      if (cached && cached.examples.length > 0) {
        // Promote the cache hit onto the card so it syncs to other devices.
        await this.attachToCard(card, cached.examples);
        return { examples: cached.examples, source: 'cache', durationMs: 0 };
      }
    }

    const result = await this.runModel(card);

    if (result.source === 'model' && result.examples.length > 0) {
      await this.repository.cacheExamples(card.front, card.language, result.examples, 'model');
      await this.attachToCard(card, result.examples);
    }

    return {
      examples: result.examples,
      source: result.source,
      durationMs: result.durationMs,
      error: result.error,
    };
  }

  /**
   * Store examples on the card without touching its scheduling.
   *
   * This does mark the card pending, which is intended: examples are part of
   * the card and should reach the user's other devices. It deliberately does
   * not go through `rateCard`, so revealing a card never advances its interval.
   */
  private async attachToCard(card: Card, examples: string[]): Promise<void> {
    if (sameExamples(card.examples, examples)) return;
    await this.repository.updateCard(card, { examples });
  }

  /**
   * Two example sentences for a word, from whichever model this platform has.
   *
   * The desktop shell is asked first because on the desktop it is the only one
   * there: the in-process path needs a native module the web export cannot
   * load. Its budget and token count are the shell's, not this build's — see
   * apps/desktop/ai.js — because inference there runs off the UI thread and can
   * afford to take its time, while the two seconds configured here exist to
   * protect a phone's UI thread.
   */
  private async runModel(card: Card): Promise<GenerateExamplesResult> {
    const request = {
      word: card.front,
      meaning: card.back,
      language: card.language,
      count: 2,
    };

    if (exampleBridgeAvailable()) {
      try {
        return await generateExamplesOnDesktop(request);
      } catch (error) {
        // The shell failed rather than the model — it was not running, or the
        // IPC call was rejected. Falling through to the in-process path costs
        // nothing on a platform that has no model: it returns carrier
        // sentences immediately, which is what should be shown anyway.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`The desktop shell could not write examples: ${reason}`);
      }
    }

    return generateExamples(request, {
      infer: await this.resolveInference(),
      family: appConfig.ai.modelFamily,
      budgetMs: appConfig.ai.budgetMs,
      maxTokens: appConfig.ai.maxTokens,
      // One retry is affordable only because the budget covers both attempts.
      retryOnParseFailure: true,
    });
  }

  private async resolveInference(): Promise<InferenceFn | null> {
    if (this.inference === undefined) {
      this.inference = await createInference();
    }
    return this.inference ?? null;
  }

  /** Force the next reveal to reload the model, e.g. after installing weights. */
  reset(): void {
    this.inference = undefined;
    this.pending.clear();
  }
}

function sameExamples(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
