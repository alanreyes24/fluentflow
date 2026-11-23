import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import TextImportScreen from '../app/(app)/text-import';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { mockRouter, mockSearchParams, renderScreen, TEST_USER } from './setup';

/**
 * Importing a pasted word list.
 *
 * The parser itself is covered in core; what matters here is that the screen
 * shows what it found *before* writing anything, and that what it writes lands
 * in real SQLite as cards a review session would pick up.
 */

const LIST = 'hablar - to speak\ncasa - house\nniño - child';
/** A pasted vocabulary list with no meanings on it — the hard case. */
const WORDS = 'nido\nempapar\nlodazal';

/**
 * What the distilled Wiktionary file returns. Only the free infinitive check
 * sees these; they must never reach a card back.
 */
const DICTIONARY: Record<string, string> = { nido: 'nest (dictionary)', empapar: 'to drench' };
/** What Gemini says about each word. Every definition comes from here. */
const MODEL: Record<string, string> = { nido: 'nest', empapar: 'to soak', lodazal: 'mudhole' };

/** One word's answer, from whichever source this call is allowed to use. */
function answer(word: string, useModel: boolean) {
  if (!useModel) {
    if (word === 'comieron') {
      return { word, correctedWord: 'comer', meaning: 'to eat', source: 'dictionary', needsReview: false };
    }
    if (word === 'molim') {
      return { word, correctedWord: 'moliti', meaning: 'I pray', source: 'dictionary', needsReview: false };
    }
    if (DICTIONARY[word]) {
      return { word, meaning: DICTIONARY[word], source: 'dictionary', needsReview: false };
    }
    return { word, meaning: '', source: 'none', needsReview: false, rejected: 'not-found' };
  }
  if (MODEL[word]) {
    return { word, meaning: MODEL[word], source: 'model', needsReview: true };
  }
  return { word, meaning: '', source: 'none', needsReview: false, rejected: 'model-rejected' };
}

/**
 * The desktop shell's lookup bridge.
 *
 * Installed on `globalThis` exactly as `contextBridge` installs it, so the
 * screen's own detection runs rather than a mock of it.
 *
 * It honours `useModel`: `false` is the free dictionary-only infinitive check,
 * anything else is a billed Gemini request.
 */
function installBridge(overrides = {}) {
  const bridge = {
    platform: 'darwin',
    ai: {
      status: jest.fn(async () => ({
        dictionary: { available: true, languages: { es: true, bs: true }, source: { es: 'Spanish' } },
        cloud: { available: true, configured: true, model: 'gemini-3.1-flash-lite' },
      })),
      resolve: jest.fn(async (words: string[], _language: string, options?: { useModel?: boolean }) => {
        const useModel = options?.useModel !== false;
        return {
          ok: true,
          meanings: words.map((word) => answer(word, useModel)),
          ...(useModel
            ? {
                usage: {
                  model: 'gemini-3.1-flash-lite',
                  requests: 1,
                  inputTokens: 120,
                  outputTokens: 30,
                  totalTokens: 150,
                  listPriceUsd: 0.000075,
                },
              }
            : {}),
        };
      }),
      onProgress: jest.fn(() => jest.fn()),
      ...overrides,
    },
  };
  (globalThis as Record<string, unknown>).fluentflowDesktop = bridge;
  return bridge;
}

const ASK = (count: number) => `Ask gemini-3.1-flash-lite to define ${count} word(s)`;

describe('TextImportScreen', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let repository: Repository;

  beforeEach(async () => {
    context = await createTestRepository();
    repository = context.repository;
    mockSearchParams.current = {};
  });

  afterEach(async () => {
    await context.close();
    delete (globalThis as Record<string, unknown>).fluentflowDesktop;
  });

  const paste = async (text: string) => {
    await fireEvent.changeText(screen.getByLabelText('Your list'), text);
  };

  it('says there is nothing to import until something is pasted', async () => {
    await renderScreen(<TextImportScreen />, { repository });

    expect(screen.getByText('Nothing to import yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create cards' })).toBeDisabled();
  });

  it('previews the cards and the separator it recognised', async () => {
    await renderScreen(<TextImportScreen />, { repository });
    await paste(LIST);

    expect(screen.getByText('3 cards ready')).toBeTruthy();
    expect(screen.getByText('Separator: word - meaning')).toBeTruthy();
    expect(screen.getByText('hablar')).toBeTruthy();
    expect(screen.getByText('to speak')).toBeTruthy();
  });

  it('does not show an extra expand control under the list', async () => {
    await renderScreen(<TextImportScreen />, { repository });

    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
  });

  it('names the lines it could not read instead of dropping them silently', async () => {
    await renderScreen(<TextImportScreen />, { repository });
    await paste('hablar - to speak\ncasa\nniño - child');

    expect(screen.getByText('2 cards ready')).toBeTruthy();
    expect(screen.getByText('1 line(s) skipped')).toBeTruthy();
    expect(screen.getByText('2: casa')).toBeTruthy();
  });

  it('reads the list the other way round on request', async () => {
    await renderScreen(<TextImportScreen />, { repository });
    await paste('to speak - hablar');

    await fireEvent.press(screen.getByRole('button', { name: 'Reading: word first' }));

    await screen.findByRole('button', { name: 'Reading: meaning first' });
    expect(screen.getByText('hablar')).toBeTruthy();
  });

  it('creates a deck of real cards, with the language taken from the words', async () => {
    const { state } = await renderScreen(<TextImportScreen />, {
      repository,
      user: TEST_USER,
    });

    await paste(LIST);
    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish A1');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const decks = await repository.listDecks(TEST_USER.id);
      expect(decks).toHaveLength(1);
      expect(decks[0]!.name).toBe('Spanish A1');
      expect(decks[0]!.language).toBe('es');
      expect(decks[0]!.cardCount).toBe(3);
    });

    const [deck] = await repository.listDecks(TEST_USER.id);
    const cards = await repository.listCards(deck!.id);
    expect(cards.map((card) => card.front).sort()).toEqual(['casa', 'hablar', 'niño']);
    // Every card is new and due, so a session started now would pick them up.
    expect(await repository.dueCards(deck!.id)).toHaveLength(3);
    expect(state.refreshDecks).toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/deck/[id]',
      params: { id: deck!.id },
    });
  });

  it('normalizes conjugated fronts even when the paste already includes meanings', async () => {
    installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });

    await paste('comieron - they ate');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const [deck] = await repository.listDecks(TEST_USER.id);
      const cards = deck ? await repository.listCards(deck.id) : [];
      expect(cards.map((card) => `${card.front}=${card.back}`)).toEqual(['comer=they ate']);
    });
  });

  it('normalizes Bosnian conjugated fronts when the paste already includes meanings', async () => {
    installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });

    await paste('molim - I pray');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const [deck] = await repository.listDecks(TEST_USER.id);
      const cards = deck ? await repository.listCards(deck.id) : [];
      expect(cards.map((card) => `${card.front}=${card.back}`)).toEqual(['moliti=I pray']);
    });
  });

  it('adds to an existing deck without repeating words it already has', async () => {
    const deck = await repository.createDeck(TEST_USER.id, 'Spanish A1', 'es');
    await repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
    mockSearchParams.current = { deckId: deck.id };

    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });

    // The deck is named on screen, so it is clear where the cards will land.
    await screen.findByText('Spanish A1 · Español');
    await paste(LIST);

    expect(screen.getByText('2 cards ready')).toBeTruthy();
    expect(screen.getByText('1 already in the deck')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Add to this deck' }));

    await waitFor(async () => {
      const cards = await repository.listCards(deck.id);
      expect(cards.map((card) => card.front).sort()).toEqual(['casa', 'hablar', 'niño']);
    });

    // No second deck, and the count on the existing one is recomputed.
    const decks = await repository.listDecks(TEST_USER.id);
    expect(decks).toHaveLength(1);
    expect(decks[0]!.cardCount).toBe(3);
  });

  it('lets the generic paste screen target an existing deck', async () => {
    const deck = await repository.createDeck(TEST_USER.id, 'Spanish A1', 'es');

    await renderScreen(<TextImportScreen />, {
      repository,
      user: TEST_USER,
      decks: [deck],
    });

    await fireEvent.press(screen.getByRole('button', { name: 'Spanish A1' }));
    await screen.findByText('Spanish A1 · Español');
    await paste('casa - house\nniño - child');

    expect(screen.getByRole('button', { name: 'Add to this deck' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Add to this deck' }));

    await waitFor(async () => {
      const cards = await repository.listCards(deck.id);
      expect(cards.map((card) => card.front).sort()).toEqual(['casa', 'niño']);
    });

    expect(await repository.listDecks(TEST_USER.id)).toHaveLength(1);
  });

  it('reads a bare word list as words, not as one enormous card', async () => {
    await renderScreen(<TextImportScreen />, { repository });
    await paste(WORDS);

    // The bug this covers: with no separators and no blank lines, three lines
    // used to become one card with "empapar lodazal" on its back.
    // "0 of 3" rather than "3 cards ready": the Create button is disabled until
    // the meanings exist, and the count above it should not say otherwise.
    expect(screen.getByText('0 of 3 ready')).toBeTruthy();
    expect(screen.getByText('Separator: One word per line')).toBeTruthy();
    expect(screen.getByText('3 words with no meaning yet')).toBeTruthy();
  });

  it('will not import words that have no meaning', async () => {
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    // Nothing to write yet: a card with a blank back is not a card.
    expect(screen.getByRole('button', { name: 'Create cards' })).toBeDisabled();
  });

  it('does not offer manual meanings when Gemini is unavailable', async () => {
    installBridge({
      status: jest.fn(async () => ({
        dictionary: { available: false, reason: 'No dictionaries in ~/dictionaries' },
        cloud: { available: false, configured: false },
      })),
    });
    await renderScreen(<TextImportScreen />, { repository });
    await paste(WORDS);

    await screen.findByText('Gemini is not connected. Add a key or approve skipping unresolved words.');
    expect(screen.queryByRole('button', { name: 'Look up the meanings' })).toBeNull();
    expect(screen.queryByLabelText('nido')).toBeNull();
  });

  it('never fills meanings from the dictionary, even with no API key', async () => {
    const bridge = installBridge({
      status: jest.fn(async () => ({
        dictionary: { available: true, languages: { es: true }, source: { es: 'Spanish' } },
        cloud: { available: false, configured: false, reason: 'No API key' },
      })),
    });
    await renderScreen(<TextImportScreen />, { repository });
    await paste(WORDS);

    await screen.findByText('Gemini is not connected. Add a key or approve skipping unresolved words.');
    expect(bridge.ai.resolve).not.toHaveBeenCalled();
    expect(screen.queryByText('nest (dictionary)')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ask / })).toBeNull();
  });

  it('sends nothing until the Gemini button is pressed', async () => {
    const bridge = installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    await screen.findByRole('button', { name: ASK(3) });
    expect(screen.getByText(/Estimated maximum cost/)).toBeTruthy();
    expect(bridge.ai.resolve).not.toHaveBeenCalled();
    expect(screen.queryByText('Meanings assigned automatically')).toBeNull();
  });

  it('sends every word to the model, including ones the dictionary knows', async () => {
    const bridge = installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    await fireEvent.press(await screen.findByRole('button', { name: ASK(3) }));

    await screen.findByText('Meanings assigned automatically');
    expect(bridge.ai.resolve).toHaveBeenLastCalledWith(['nido', 'empapar', 'lodazal'], 'es', undefined);
    expect(screen.getByText('nest')).toBeTruthy();
    expect(screen.getByText('to soak')).toBeTruthy();
    expect(screen.queryByText('to drench')).toBeNull();
    expect(screen.getByText('3 from gemini-3.1-flash-lite')).toBeTruthy();
    expect(
      screen.getByText(
        'Measured Gemini usage — requests: 1 · input tokens: 120 · output tokens: 30 · list-price cost: $0.00007500.',
      ),
    ).toBeTruthy();

    // Still nothing written: the deck is untouched until the user says so.
    expect(await repository.listDecks(TEST_USER.id)).toHaveLength(0);
  });

  it('shows an in-place busy indicator while the one-click Gemini request runs', async () => {
    let finishModel: (() => void) | undefined;
    installBridge({
      resolve: jest.fn(async (words: string[]) => new Promise((resolve) => {
        finishModel = () => resolve({
          ok: true,
          meanings: words.map((word) => ({
            word,
            meaning: 'mudflat',
            source: 'model',
            needsReview: true,
          })),
        });
      })),
    });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste('lodazal');

    await fireEvent.press(await screen.findByRole('button', { name: ASK(1) }));

    const loading = screen.getByRole('button', { name: 'Looking up meanings…' });
    expect(loading.props.accessibilityState).toEqual({ disabled: true, busy: true });

    finishModel?.();
    await screen.findByText('mudflat');
  });

  it('keeps cards with unresolved meanings out of the import', async () => {
    installBridge({
      status: jest.fn(async () => ({
        dictionary: { available: false, reason: 'No dictionaries in ~/dictionaries' },
        cloud: { available: false, configured: false },
      })),
    });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    await screen.findByText('Gemini is not connected. Add a key or approve skipping unresolved words.');
    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));
    expect(await repository.listDecks(TEST_USER.id)).toHaveLength(0);
  });

  it('imports the model\'s definitions, not the dictionary\'s', async () => {
    installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);
    await fireEvent.press(await screen.findByRole('button', { name: ASK(3) }));
    await screen.findByText('Meanings assigned automatically');

    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const decks = await repository.listDecks(TEST_USER.id);
      expect(decks).toHaveLength(1);
    });

    const [deck] = await repository.listDecks(TEST_USER.id);
    const cards = await repository.listCards(deck!.id);
    expect(cards.map((card) => `${card.front}=${card.back}`).sort()).toEqual([
      'empapar=to soak',
      'lodazal=mudhole',
      'nido=nest',
    ]);
  });

  it('a word the model could not define is not written as a card', async () => {
    installBridge({
      resolve: jest.fn(async (words: string[]) => ({
        ok: true,
        meanings: words.map((word) => word === 'lodazal'
          ? { word, meaning: '', source: 'none', needsReview: false, rejected: 'model-rejected' }
          : { word, meaning: MODEL[word], source: 'model', needsReview: true }),
      })),
    });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);
    await fireEvent.press(await screen.findByRole('button', { name: ASK(3) }));
    await screen.findByText('Meanings assigned automatically');
    expect(screen.getByText('2 from gemini-3.1-flash-lite · 1 with no answer')).toBeTruthy();

    expect(screen.getByRole('button', { name: 'Create cards' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'I understand — skip unresolved words' }));

    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const decks = await repository.listDecks(TEST_USER.id);
      expect(decks).toHaveLength(1);
    });

    const [deck] = await repository.listDecks(TEST_USER.id);
    const cards = await repository.listCards(deck!.id);
    expect(cards.map((card) => card.front).sort()).toEqual(['empapar', 'nido']);
  });

  it('offers every word in a large paste to Gemini', async () => {
    const words = Array.from({ length: 450 }, (_, index) => `palabra${index}`).join('\n');
    installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(words);

    await screen.findByText('450 words with no meaning yet');
    expect(await screen.findByRole('button', { name: ASK(450) })).toBeTruthy();
  });

  it('keeps model request failures available for retry', async () => {
    installBridge({
      resolve: jest.fn(async (words: string[]) => ({
        ok: true,
        meanings: words.map((word) => ({
          word,
          meaning: '',
          source: 'none',
          needsReview: false,
          rejected: 'model-failed',
        })),
      })),
    });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);
    await fireEvent.press(await screen.findByRole('button', { name: ASK(3) }));

    await screen.findByText('3 could not be completed and can be retried.');
    expect(screen.getByRole('button', { name: ASK(3) })).toBeTruthy();
  });

  it('applies a model spelling correction to the imported card front', async () => {
    installBridge({
      resolve: jest.fn(async (
        words: string[],
        _language: string,
        options?: { useModel?: boolean },
      ) => ({
        ok: true,
        meanings: words.map((word) => options?.useModel !== false
          ? { word, correctedWord: 'armadura', meaning: 'armor', source: 'model', needsReview: true }
          : { word, meaning: '', source: 'none', needsReview: false, rejected: 'not-found' }),
      })),
    });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste('almadura');
    await fireEvent.press(await screen.findByRole('button', { name: ASK(1) }));
    await screen.findByText('Meanings assigned automatically');
    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const [deck] = await repository.listDecks(TEST_USER.id);
      expect(deck).toBeTruthy();
      const cards = await repository.listCards(deck!.id);
      expect(cards.map((card) => `${card.front}=${card.back}`)).toEqual(['armadura=armor']);
    });
  });

  it('discards definitions and asks in the new language when the language changes', async () => {
    const bridge = installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste('lodazal');
    await fireEvent.press(await screen.findByRole('button', { name: ASK(1) }));
    await screen.findByText('mudhole');

    await fireEvent.press(screen.getByRole('button', { name: 'Bosanski' }));
    await waitFor(() => expect(screen.queryByText('mudhole')).toBeNull());

    await fireEvent.press(await screen.findByRole('button', { name: ASK(1) }));
    await waitFor(() => {
      expect(bridge.ai.resolve).toHaveBeenLastCalledWith(['lodazal'], 'bs', undefined);
    });
  });

  it('reports a shell that fails mid-lookup instead of hanging', async () => {
    installBridge({ resolve: jest.fn(async () => ({ ok: false, error: 'the runtime fell over' })) });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);
    await fireEvent.press(await screen.findByRole('button', { name: ASK(3) }));

    await screen.findByText('the runtime fell over');
    expect(screen.queryByText('Meanings assigned automatically')).toBeNull();
  });
});
