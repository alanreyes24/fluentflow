import type { GenerateExamplesResult } from '@fluentflow/core';
import { ExampleService } from '../src/ai/service';
import { createTestRepository } from './fakes/database';

/**
 * Where a card reveal gets its sentences on the desktop.
 *
 * The bundle is the same one a browser tab runs, so it cannot load a model
 * itself. In Electron the model lives in the main process and reaches the app
 * through the bridge `preload.js` exposes. What is pinned here is the routing
 * and its failure behaviour, not the model: when the shell is present it must
 * be asked, and when it is not, or it fails, the reveal must still produce
 * something.
 */

/** The shape `apps/desktop/preload.js` exposes on `window.fluentflowDesktop`. */
function installBridge(examples: jest.Mock | undefined) {
  (globalThis as Record<string, unknown>).fluentflowDesktop = {
    platform: 'darwin',
    ai: {
      status: jest.fn(),
      resolve: jest.fn(),
      onProgress: jest.fn(() => () => {}),
      ...(examples ? { examples } : {}),
    },
  };
}

describe('example generation through the desktop shell', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;

  beforeEach(async () => {
    context = await createTestRepository();
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).fluentflowDesktop;
    await context.close();
  });

  async function testCard() {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    return repository.addCard('u1', deck, 'nido', 'nest');
  }

  const modelResult: GenerateExamplesResult = {
    examples: ['El pájaro construye su nido en la hierba alta.', 'La abeja cuida su nido.'],
    source: 'model',
    durationMs: 5948,
    attempts: 1,
  };

  it('asks the shell for two sentences and shows them as model output', async () => {
    const examples = jest.fn().mockResolvedValue({ ok: true, result: modelResult });
    installBridge(examples);

    const card = await testCard();
    const result = await new ExampleService(context.repository).forCard(card);

    expect(examples).toHaveBeenCalledWith(
      { word: 'nido', meaning: 'nest', language: 'es', count: 2 },
      // The id the shell needs to match a later `cancelExamples` against; an
      // AbortSignal cannot cross contextBridge, so the handle is a string.
      expect.any(String),
    );
    expect(result.source).toBe('model');
    expect(result.examples).toEqual(modelResult.examples);
  });

  it('caches the shell result, so the second reveal costs no inference', async () => {
    const examples = jest.fn().mockResolvedValue({ ok: true, result: modelResult });
    installBridge(examples);

    const card = await testCard();
    const service = new ExampleService(context.repository);
    await service.forCard(card);
    // A fresh card record: the first reveal wrote the examples onto the stored
    // card, and re-reading is what a second study session actually does.
    const [stored] = await context.repository.listCards(card.deckId);
    const second = await service.forCard(stored!);

    expect(examples).toHaveBeenCalledTimes(1);
    expect(second.source).toBe('cache');
    expect(second.examples).toEqual(modelResult.examples);
  });

  it('falls back to carrier sentences when the shell reports a failure', async () => {
    const examples = jest.fn().mockResolvedValue({ ok: false, error: 'the model config is corrupt' });
    installBridge(examples);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const card = await testCard();
    const result = await new ExampleService(context.repository).forCard(card);

    expect(result.source).toBe('fallback');
    expect(result.examples.length).toBeGreaterThan(0);
  });

  it('ignores an older shell that has no example bridge at all', async () => {
    installBridge(undefined);

    const card = await testCard();
    const result = await new ExampleService(context.repository).forCard(card);

    // No model in this process either, so carrier sentences — but reached
    // without ever calling a function the older shell does not expose.
    expect(result.source).toBe('fallback');
    expect(result.examples.length).toBeGreaterThan(0);
  });

  it('falls back to carrier sentences in a plain browser tab, with no shell present', async () => {
    const card = await testCard();
    const result = await new ExampleService(context.repository).forCard(card);

    expect(result.source).toBe('fallback');
    expect(result.examples.length).toBeGreaterThan(0);
  });
});
