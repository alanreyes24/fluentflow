import type { Card, GenerateExamplesResult } from '@fluentflow/core';
import { ExampleService } from '../src/ai/service';
import { createTestRepository } from './fakes/database';

/**
 * Generating example sentences before the card is revealed.
 *
 * The point of the prefetch is that the couple of seconds a generation costs is
 * spent while the learner is reading the front of a card, not while they are
 * watching a spinner where the answer should be. What is pinned here is the
 * behaviour that makes that safe rather than merely early:
 *
 *  - one generation at a time, because two decodes compete for the same threads;
 *  - a reveal joins the speculative run for its own card instead of racing it;
 *  - a speculative run does not write to the card, only to the word cache — a
 *    study queue holds its cards for the whole session, and `rateCard` writes a
 *    row from the copy it is handed, so a write onto a card the user is about
 *    to rate would be undone by the rating.
 *
 * The desktop bridge is the injection point: it is the one inference path that
 * is a plain function on `globalThis`, so a test can hold it open.
 */

/** A generation the test finishes by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

function sentencesFor(word: string): GenerateExamplesResult {
  return {
    examples: [`Una frase con ${word}.`, `Otra frase con ${word}.`],
    source: 'model',
    durationMs: 1200,
    attempts: 1,
  };
}

/** Poll until `check` holds, so a fire-and-forget prefetch can be awaited. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('prefetching examples for upcoming cards', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let service: ExampleService;
  /** Words the shell has been asked about, in order. */
  let asked: string[];
  /** Generations currently in flight, to catch two running at once. */
  let inFlight: number;
  let peakInFlight: number;
  /** Held generations, by word, when the test wants to control timing. */
  let held: Map<string, ReturnType<typeof deferred>>;
  /** Live request ids to the word each is generating, for cancellation. */
  let running: Map<string, string>;
  /** Words the shell was told to abandon. */
  let cancelled: string[];

  beforeEach(async () => {
    context = await createTestRepository();
    service = new ExampleService(context.repository);
    asked = [];
    inFlight = 0;
    peakInFlight = 0;
    held = new Map();
    running = new Map();
    cancelled = [];

    (globalThis as Record<string, unknown>).fluentflowDesktop = {
      platform: 'darwin',
      ai: {
        status: jest.fn(),
        resolve: jest.fn(),
        onProgress: jest.fn(() => () => {}),
        examples: async ({ word }: { word: string }, requestId: string) => {
          asked.push(word);
          running.set(requestId, word);
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          try {
            await held.get(word)?.promise;
            return { ok: true, result: sentencesFor(word) };
          } finally {
            running.delete(requestId);
            inFlight--;
          }
        },
        // The real shell aborts the decode, which makes core return whatever
        // it had; the stand-in releases the held promise, which does the same.
        cancelExamples: (requestId: string) => {
          const word = running.get(requestId);
          if (word) {
            cancelled.push(word);
            held.get(word)?.resolve();
          }
        },
      },
    };
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).fluentflowDesktop;
    await context.close();
  });

  async function queueOf(...words: string[]): Promise<Card[]> {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const cards: Card[] = [];
    for (const word of words) {
      cards.push(await repository.addCard('u1', deck, word, `meaning of ${word}`));
    }
    return cards;
  }

  it('generates ahead of the card on screen, so revealing it is immediate', async () => {
    const queue = await queueOf('nido', 'hablar', 'correr');
    service.prefetch(queue);

    await until(() => asked.length === 3, 'the window to be generated');

    // The reveal finds the work already done: the sentences come back without
    // the shell being asked a fourth time.
    const result = await service.forCard(queue[0]!);
    expect(result.examples).toEqual(sentencesFor('nido').examples);
    expect(asked).toEqual(['nido', 'hablar', 'correr']);
  });

  it('runs one generation at a time', async () => {
    const queue = await queueOf('nido', 'hablar', 'correr');
    for (const word of ['nido', 'hablar', 'correr']) held.set(word, deferred());

    service.prefetch(queue);
    await until(() => asked.length === 1, 'the first generation to start');

    // With all three held, a parallel implementation would have started all
    // three by now. Releasing them one at a time walks the queue forward.
    for (const word of ['nido', 'hablar', 'correr']) {
      held.get(word)!.resolve();
      await until(() => !asked.includes(word) || inFlight === 0 || asked.length > 0, word);
    }
    await until(() => asked.length === 3, 'the window to finish');

    expect(peakInFlight).toBe(1);
  });

  it('preserves completed reviews when a revealed card finishes generating later', async () => {
    const [card] = await queueOf('hablar');
    held.set('hablar', deferred());
    const generating = service.forCard(card!);
    await until(() => asked.includes('hablar'), 'generation to start');
    const learning = await context.repository.rateCard(card!, 'good');
    const graduated = await context.repository.rateCard(learning, 'good');

    held.get('hablar')!.resolve();
    await generating;

    expect(await context.repository.getCard(card!.id)).toMatchObject({
      phase: 'review',
      nextReview: graduated.nextReview,
      dueDay: graduated.dueDay,
      introducedAt: graduated.introducedAt,
      repetitions: 2,
      examples: sentencesFor('hablar').examples,
    });
    expect(await context.repository.dueCards(card!.deckId)).toHaveLength(0);
  });

  it('stops at three cards ahead rather than generating the whole queue', async () => {
    const queue = await queueOf('uno', 'dos', 'tres', 'cuatro', 'cinco');
    service.prefetch(queue);

    await until(() => asked.length === 3, 'the window to be generated');
    // Give a fourth generation every chance to start before ruling it out.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(asked).toEqual(['uno', 'dos', 'tres']);
  });

  it('has a reveal join the run already in flight for that card', async () => {
    const queue = await queueOf('nido');
    held.set('nido', deferred());

    service.prefetch(queue);
    await until(() => asked.length === 1, 'the prefetch to start');

    const revealed = service.forCard(queue[0]!);
    held.get('nido')!.resolve();

    expect((await revealed).examples).toEqual(sentencesFor('nido').examples);
    // One generation, not two: the reveal waited on the speculative run.
    expect(asked).toEqual(['nido']);
  });

  it('leaves the card itself alone until it is revealed', async () => {
    const { repository } = context;
    const queue = await queueOf('nido');
    service.prefetch(queue);
    await until(() => asked.length === 1, 'the prefetch to run');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The word cache has the sentences — that is what makes the reveal fast.
    const cached = await repository.getCachedExamples('nido', 'es');
    expect(cached?.examples).toEqual(sentencesFor('nido').examples);

    // The card does not, yet. If it did, rating the card from the stale copy
    // the study queue is holding would write the empty list straight back over
    // them, and mark the card for sync while doing it.
    expect((await repository.getCard(queue[0]!.id))?.examples).toEqual([]);

    // Revealing puts them on the card the caller is holding, which is the copy
    // that gets rated.
    await service.forCard(queue[0]!);
    expect((await repository.getCard(queue[0]!.id))?.examples).toEqual(
      sentencesFor('nido').examples,
    );
  });

  it('drops a speculative run to get to the card the user just revealed', async () => {
    const queue = await queueOf('nido', 'hablar');
    // The prefetch reaches the second card while the user is still on the
    // first — the ordinary case once a session is a few cards in.
    held.set('hablar', deferred());
    service.prefetch(queue.slice(1));
    await until(() => asked.includes('hablar'), 'the speculative run to start');

    // Revealing a card the model is not working on. Without cancellation this
    // would sit behind the whole of 'hablar' — 3.5–6.2 s on the shell's budget.
    const revealed = await service.forCard(queue[0]!);

    expect(cancelled).toEqual(['hablar']);
    expect(revealed.examples).toEqual(sentencesFor('nido').examples);
    // 'hablar' was put back rather than abandoned: it is still the next card.
    await until(() => asked.filter((word) => word === 'hablar').length === 2, 'the retry');
  });

  it('skips cards that already have examples', async () => {
    const queue = await queueOf('nido', 'hablar');
    await context.repository.updateCard(queue[0]!, { examples: ['Ya tengo una frase.'] });
    queue[0]!.examples = ['Ya tengo una frase.'];

    service.prefetch(queue);
    await until(() => asked.length === 1, 'the second card to be generated');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(asked).toEqual(['hablar']);
  });

  it('moves the window on rather than re-generating what it already did', async () => {
    const queue = await queueOf('uno', 'dos', 'tres', 'cuatro', 'cinco');
    service.prefetch(queue);
    await until(() => asked.length === 3, 'the first window');

    // The user answers one card. The queue objects are the same stale ones —
    // they still say they have no examples — so only the service's own record
    // of what it has settled stops it re-running them.
    service.prefetch(queue.slice(1));
    await until(() => asked.length === 5, 'the window to advance');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Every word once: the window carried on past the two it had already
    // settled rather than starting them again.
    expect(asked).toEqual(['uno', 'dos', 'tres', 'cuatro', 'cinco']);
  });
});
