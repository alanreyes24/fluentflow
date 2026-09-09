import { normalizeCardFront, normalizeExistingCards } from '../src/ai/card-fronts';
import { createTestRepository } from './fakes/database';
import { TEST_USER } from './setup';

describe('card-front normalization', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;

  beforeEach(async () => {
    context = await createTestRepository();
    (globalThis as Record<string, unknown>).fluentflowDesktop = {
      platform: 'darwin',
      ai: {
        status: jest.fn(async () => ({
          dictionary: { available: true, languages: { es: true, bs: true } },
        })),
        resolve: jest.fn(async (words: string[], language: string) => ({
          ok: true,
          meanings: words.map((word) => {
            if (language === 'es' && word === 'comieron') {
              return {
                word,
                meaning: 'to eat',
                source: 'dictionary',
                lemma: 'comer',
                correctedWord: 'comer',
                needsReview: false,
              };
            }
            if (language === 'bs' && word === 'stići') {
              return {
                word,
                meaning: 'to arrive, reach',
                source: 'dictionary',
                lemma: 'stȉgnuti',
                needsReview: false,
              };
            }
            if (language === 'bs' && word === 'molim') {
              return {
                word,
                meaning: 'to pray, to ask',
                source: 'dictionary',
                lemma: 'moliti',
                correctedWord: 'moliti',
                needsReview: false,
              };
            }
            if (language === 'es' && word === 'tablas') {
              return {
                word,
                meaning: 'to pleat',
                source: 'dictionary',
                lemma: 'tablear',
                correctedWord: 'tablear',
                needsReview: false,
              };
            }
            return { word, meaning: '', source: 'none', needsReview: false };
          }),
        })),
        onProgress: jest.fn(() => jest.fn()),
      },
    };
  });

  afterEach(async () => {
    await context.close();
    delete (globalThis as Record<string, unknown>).fluentflowDesktop;
  });

  it('normalizes manual input with the free dictionary', async () => {
    await expect(normalizeCardFront('comieron', 'es')).resolves.toBe('comer');
    await expect(normalizeCardFront('molim', 'bs')).resolves.toBe('moliti');
    await expect(normalizeCardFront('tablas', 'es', 'boards')).resolves.toBe('tablas');
  });

  it('audits existing fronts and repairs pointer meanings', async () => {
    const spanish = await context.repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    const bosnian = await context.repository.createDeck(TEST_USER.id, 'Bosnian', 'bs');
    await context.repository.addCard(TEST_USER.id, spanish, 'comieron', 'they ate');
    await context.repository.addCard(
      TEST_USER.id,
      bosnian,
      'stići',
      'alternative form of stȉgnuti',
    );

    const summary = await normalizeExistingCards(context.repository, TEST_USER.id);
    const [spanishCard] = await context.repository.listCards(spanish.id);
    const [bosnianCard] = await context.repository.listCards(bosnian.id);

    expect(summary).toEqual({ scanned: 2, frontsChanged: 1, meaningsChanged: 1 });
    expect(spanishCard?.front).toBe('comer');
    expect(spanishCard?.back).toBe('they ate');
    expect(bosnianCard?.front).toBe('stići');
    expect(bosnianCard?.back).toBe('to arrive, reach');
  });
});
