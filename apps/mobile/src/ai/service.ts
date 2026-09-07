import {
  generateExamples,
  type Card,
  type ExampleSource,
  type GenerateExamplesResult,
} from '@fluentflow/core';
import type { Repository } from '../db/repository';
import { exampleBridgeAvailable, generateExamplesOnDesktop } from './desktop';
import { generateExamplesOnWeb, webAiAvailable } from './web';

/**
 * Example generation as the UI sees it.
 *
 * Four layers, cheapest first:
 *
 *  1. Examples already on the card (imported, or generated on another device
 *     and synced down).
 *  2. The `example_cache` table, keyed by word rather than card, so a word that
 *     appears in two decks is only ever generated once.
 *  3. A speculative run started before the card was revealed — see
 *     {@link ExampleService.prefetch}.
 *  4. The model, falling back to written carrier sentences.
 *
 * A successful generation is written back to both the cache and the card, which
 * is what gets it onto the user's other devices — the card is a synced record,
 * the cache is not.
 *
 * Layers 3 and 4 need a model, and the model runs in the Electron main process:
 * the renderer is the same bundle a browser tab runs, and it has no way to load
 * one. When the desktop shell is present this asks it for the finished
 * sentences over IPC; before that bridge existed every reveal showed a carrier
 * sentence quoting the word rather than using it. In a plain browser tab there
 * is no shell and no model, and the fallback is the honest answer.
 */

export interface ExampleResult {
  examples: string[];
  source: ExampleSource;
  durationMs: number;
  /** Present when the model was tried and did not produce usable output. */
  error?: string;
}

/**
 * How many cards ahead of the one on screen are generated speculatively.
 *
 * Three is chosen against how fast a session actually moves: a review takes a
 * learner a few seconds and a generation takes the model a few seconds, so one
 * card of lead is enough to keep up and is lost to a single fast answer. Three
 * absorbs a run of "easy, easy, easy" without holding a queue of work the user
 * may never reach. Nothing here is wasted in any case — the results are written
 * to `example_cache` and to the cards, so a prefetch the session never reaches
 * is simply a reveal paid for early.
 */
const PREFETCH_DEPTH = 3;

export class ExampleService {
  /** In-flight requests, keyed by word, so a double tap runs one inference. */
  private readonly pending = new Map<string, Promise<ExampleResult>>();
  /** Cards queued for speculative generation, nearest to the user first. */
  private backlog: Card[] = [];
  /** The speculative run in flight, so a reveal can cut in front of it. */
  private speculating: { key: string; card: Card; abort: AbortController } | null = null;
  /**
   * Words this session has already settled, however they were settled.
   *
   * The study queue hands out the same `Card` objects for the whole session,
   * and those objects still read `examples: []` after a prefetch has filled the
   * cache behind them. Without this the window would keep re-picking the same
   * three cards on every advance and never get ahead of the user.
   */
  private readonly resolved = new Set<string>();
  private draining = false;

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

    const key = cacheKey(card);
    const existing = this.pending.get(key);
    // A prefetch already working on this word *is* the request being made.
    // Joining it rather than starting a second one is the whole point of having
    // run it early, and it is why the reveal usually returns immediately.
    if (existing && !force) {
      const result = await existing;
      // A speculative run deliberately leaves the card alone (see `generate`).
      // Now that the card is on screen and in the caller's hand, the examples
      // belong on it.
      if (result.source !== 'fallback' && result.examples.length > 0) {
        await this.attachToCard(card, result.examples);
      }
      return result;
    }

    // Anything else the model is doing is now in the way: the user is looking
    // at this card, and there is one set of threads to decode with.
    this.cancelSpeculation(key);

    return this.track(key, this.generate(card, force));
  }

  /**
   * Generate examples for upcoming cards before they are revealed.
   *
   * The wait a learner notices is the couple of seconds between tapping "show
   * answer" and the sentences appearing, and none of that time is needed
   * *then*: a study session knows its whole queue up front. Running the model
   * on the cards behind the current one turns nearly every reveal into a cache
   * read, without touching the budget that protects the UI thread — which is
   * the reason not to reach for a smaller model instead. The 0.5B alternatives
   * measured here are markedly worse at the task (see the model notes), and
   * they would still be paying their cost at the moment the user is watching.
   *
   * The caller passes the remaining queue, nearest card first, including the
   * one on screen — a card that has not been revealed yet is exactly the card
   * most worth generating. Cards that already carry examples are skipped
   * without waking the model, so a deck studied before costs nothing here.
   *
   * Call it again on every advance; the window moves with the user and the
   * previous backlog is replaced rather than added to.
   */
  prefetch(cards: Card[]): void {
    const wanted: Card[] = [];
    for (const card of cards) {
      if (wanted.length >= PREFETCH_DEPTH) break;
      const key = cacheKey(card);
      if (card.examples.length > 0 || this.resolved.has(key)) continue;
      if (this.pending.has(key)) continue;
      wanted.push(card);
    }

    this.backlog = wanted;
    if (this.backlog.length > 0) void this.drain();
  }

  /**
   * Work through the backlog one card at a time.
   *
   * Strictly one at a time, and that is the important part. Two concurrent
   * decodes do not each take half as long, they each take twice as long — they
   * are competing for the same four threads — and one of them may be the card
   * the user is staring at. Because only ever one speculative run is in flight,
   * a reveal that has to queue waits behind at most one generation, and on the
   * in-process path it does not wait at all: {@link cancelSpeculation} stops
   * that one within a forward pass.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.backlog.length > 0) {
        const card = this.backlog.shift()!;
        const key = cacheKey(card);
        if (this.pending.has(key)) continue;

        const abort = new AbortController();
        this.speculating = { key, card, abort };
        try {
          await this.track(key, this.generate(card, false, abort.signal));
        } catch {
          // Nobody is waiting on a prefetch, so nothing here is worth
          // surfacing. The reveal runs the same path again and shows a
          // fallback if it has to.
        } finally {
          this.speculating = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Stop the speculative run, unless it is already generating `unless`.
   *
   * The card goes back on the front of the backlog: it is still the nearest
   * card needing work, and a cancelled generation is only wasted if it is never
   * finished.
   */
  private cancelSpeculation(unless?: string): void {
    const running = this.speculating;
    if (!running || running.key === unless) return;
    running.abort.abort();
    this.backlog.unshift(running.card);
  }

  /** Register an in-flight request so a second asker joins it. */
  private track(key: string, work: Promise<ExampleResult>): Promise<ExampleResult> {
    const request = work.finally(() => {
      // Only clear our own entry: a forced regeneration may have replaced it.
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  /**
   * The pipeline behind both callers.
   *
   * `speculation` is present exactly when this card is not the one on screen:
   * it cancels the run, and it withholds the write onto the card. That second
   * part matters more than it looks. `rateCard` writes a card row from the copy
   * it is handed, and a study session holds its cards for the whole session —
   * so examples written onto a card the user is about to rate from a stale copy
   * would be overwritten a moment later. The word-keyed `example_cache` has no
   * such problem, so a prefetch writes only there, and the reveal puts the
   * sentences on the card it is actually holding.
   */
  private async generate(
    card: Card,
    force: boolean,
    speculation?: AbortSignal,
  ): Promise<ExampleResult> {
    const key = cacheKey(card);

    if (!force) {
      const cached = await this.repository.getCachedExamples(card.front, card.language);
      if (cached && cached.examples.length > 0) {
        this.resolved.add(key);
        // Promote the cache hit onto the card so it syncs to other devices.
        if (!speculation) await this.attachToCard(card, cached.examples);
        return { examples: cached.examples, source: 'cache', durationMs: 0 };
      }
    }

    const result = await this.runModel(card, speculation);

    // A cancelled run stopped mid-sentence to get out of the user's way. Core
    // still answers with carrier sentences, because from its side a cancelled
    // budget and a spent one look the same — but keeping those would make the
    // shortcut permanent and leave a generic example on the card for good.
    if (speculation?.aborted) {
      return { examples: [], source: 'fallback', durationMs: result.durationMs };
    }

    // Including a fallback: with no model installed every card falls back, and
    // re-deciding that on every advance is work for a foregone conclusion.
    // `reset()` clears this, which is how a newly installed model takes effect.
    this.resolved.add(key);

    if (result.source === 'model' && result.examples.length > 0) {
      await this.repository.cacheExamples(card.front, card.language, result.examples, 'model');
      if (!speculation) await this.attachToCard(card, result.examples);
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
   * not go through `rateCard`, so revealing a card never advances its interval
   * — and neither does generating one the user has not reached yet.
   */
  private async attachToCard(card: Card, examples: string[]): Promise<void> {
    if (sameExamples(card.examples, examples)) return;
    await this.repository.updateCard(card, { examples });
  }

  /**
   * Two example sentences for a word, from the model in the desktop shell.
   *
   * The model runs in Electron's main process — see apps/desktop/ai.js — and
   * the renderer asks for finished sentences over IPC. The budget and token
   * count are the shell's: inference there runs off the UI thread and can
   * afford to take its time.
   *
   * `signal` crosses the bridge as an id and a second one-way message rather
   * than a signal, because nothing but cloneable data crosses `contextBridge`
   * — see `generateExamplesOnDesktop`. With no shell there is no model, and
   * core answers with written carrier sentences the UI labels as offline.
   */
  private async runModel(card: Card, signal?: AbortSignal): Promise<GenerateExamplesResult> {
    const request = {
      word: card.front,
      meaning: card.back,
      language: card.language,
      count: 2,
    };

    if (exampleBridgeAvailable()) {
      try {
        return await generateExamplesOnDesktop(request, signal);
      } catch (error) {
        // The shell failed rather than the model — it was not running, or the
        // IPC call was rejected. Fall through to the written sentences, which
        // is what a build with no model shows anyway.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`The desktop shell could not write examples: ${reason}`);
      }
    }

    if (webAiAvailable()) {
      try {
        return await generateExamplesOnWeb(request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`The localhost AI server could not write examples: ${reason}`);
      }
    }

    return generateExamples(request, { infer: null, signal });
  }

  /** Clear per-session state, e.g. after the cached examples are wiped. */
  reset(): void {
    this.cancelSpeculation();
    this.backlog = [];
    this.pending.clear();
    this.resolved.clear();
  }
}

/** Examples are cached by word, not by card: two decks share one generation. */
function cacheKey(card: Card): string {
  return `${card.language}:${card.front.trim().toLowerCase()}`;
}

function sameExamples(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
