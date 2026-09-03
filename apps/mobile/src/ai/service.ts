import {
  generateExamples,
  type Card,
  type ExampleSource,
  type InferenceFn,
} from '@fluentflow/core';
import type { Repository } from '../db/repository';
import { appConfig } from '../firebase/config';
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
 *  3. The bundled model, under a hard time budget, falling back to written
 *     carrier sentences.
 *
 * A successful generation is written back to both the cache and the card, which
 * is what gets it onto the user's other devices — the card is a synced record,
 * the cache is not.
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

    const infer = await this.resolveInference();
    const result = await generateExamples(
      {
        word: card.front,
        meaning: card.back,
        language: card.language,
        count: 2,
      },
      {
        infer,
        family: appConfig.ai.modelFamily,
        budgetMs: appConfig.ai.budgetMs,
        maxTokens: appConfig.ai.maxTokens,
        // One retry is affordable only because the budget covers both attempts.
        retryOnParseFailure: true,
      },
    );

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
