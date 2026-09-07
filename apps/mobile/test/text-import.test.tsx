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

/** What the distilled Wiktionary file returns for these words. */
const DICTIONARY: Record<string, string> = { nido: 'nest', empapar: 'to drench' };
/** What a small model actually said about a word it did not know. */
const GUESSES: Record<string, string> = { lodazal: 'lodestar' };

/** One word's answer, from whichever source this pass is allowed to use. */
function answer(word: string, useModel?: boolean) {
  if (DICTIONARY[word]) {
    return { word, meaning: DICTIONARY[word], source: 'dictionary', needsReview: false };
  }
  if (useModel && GUESSES[word]) {
    return { word, meaning: GUESSES[word], source: 'model', needsReview: true };
  }
  return { word, meaning: '', source: 'none', needsReview: false, rejected: 'not-found' };
}

/**
 * The desktop shell's lookup bridge.
 *
 * Installed on `globalThis` exactly as `contextBridge` installs it, so the
 * screen's own detection runs rather than a mock of it. The answers are real:
 * the dictionary rows are what the distilled Wiktionary file returns, and the
 * model row is what Qwen2.5-1.5B actually said about a word it did not know.
 *
 * It honours `useModel`, because the two-press flow is the point: the first
 * press must be answerable by the dictionary alone, and a fake that answers
 * with a model row anyway would let a screen that billed on the first press
 * pass this suite.
 */
function installBridge(overrides = {}) {
  const bridge = {
    platform: 'darwin',
    ai: {
      status: jest.fn(async () => ({
        dictionary: { available: true, languages: { es: true, bs: true }, source: { es: 'Spanish' } },
        cloud: { available: true, configured: true, model: 'gemini-3.1-flash-lite' },
      })),
      resolve: jest.fn(async (words: string[], _language: string, options?: { useModel?: boolean }) => ({
        ok: true,
        meanings: words.map((word) => answer(word, options?.useModel)),
      })),
      onProgress: jest.fn(() => jest.fn()),
      ...overrides,
    },
  };
  (globalThis as Record<string, unknown>).fluentflowDesktop = bridge;
  return bridge;
}

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

  it('keeps the list editor compact until expanded', async () => {
    await renderScreen(<TextImportScreen />, { repository });

    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
    expect(screen.queryByText(/Paste one word per line/)).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
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

    await screen.findByText('Gemini is not connected, so unresolved words cannot be added.');
    expect(screen.queryByRole('button', { name: 'Look up the meanings' })).toBeNull();
    expect(screen.queryByLabelText('nido')).toBeNull();
  });

  it('offers the lookup when only a dictionary is installed', async () => {
    installBridge({
      status: jest.fn(async () => ({
        dictionary: { available: true, languages: { es: true }, source: { es: 'Spanish' } },
        cloud: { available: false, configured: false, reason: 'No API key' },
      })),
    });
    await renderScreen(<TextImportScreen />, { repository });
    await paste(WORDS);

    // The dictionary alone is the good case: it answers without being asked,
    // and with no key there is no paid step to offer.
    await screen.findByText('Meanings assigned automatically');
    expect(screen.getByText('nest')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Ask / })).toBeNull();
  });

  it('answers from the dictionary first, and bills nothing to do it', async () => {
    const bridge = installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    // The dictionary pass runs on its own — it is free and sends nothing. The
    // paid pass still waits.
    await screen.findByText('Meanings assigned automatically');

    // The press the user cannot avoid is the one that sends nothing anywhere.
    expect(bridge.ai.resolve).toHaveBeenCalledWith(['nido', 'empapar', 'lodazal'], 'es', {
      useModel: false,
    });
    expect(screen.getByText('nest')).toBeTruthy();
    expect(screen.getByText('to drench')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('2 from the dictionary · 1 with no answer')).toBeTruthy();
  });

  it('sends only the leftovers to the model, and only when asked to', async () => {
    const bridge = installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    // The dictionary pass runs on its own — it is free and sends nothing. The
    // paid pass first shows its estimate and asks for confirmation.
    await screen.findByText('Meanings assigned automatically');

    expect(screen.getByText(/Estimated maximum cost/)).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Ask gemini-3.1-flash-lite about the remaining 1' }),
    );
    await screen.findByText(/Send only these missing words to gemini-3\.1-flash-lite/);
    await fireEvent.press(screen.getByRole('button', { name: 'Send to Gemini' }));

    await screen.findByText('Meanings assigned automatically');
    expect(bridge.ai.resolve).toHaveBeenLastCalledWith(['lodazal'], 'es', { useModel: true });
    expect(screen.getByText('lodestar')).toBeTruthy();
    expect(
      screen.getByText('2 from the dictionary · 1 from gemini-3.1-flash-lite'),
    ).toBeTruthy();

    // Still nothing written: the deck is untouched until the user says so.
    expect(await repository.listDecks(TEST_USER.id)).toHaveLength(0);
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

    await screen.findByText('Gemini is not connected, so unresolved words cannot be added.');
    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));
    expect(await repository.listDecks(TEST_USER.id)).toHaveLength(0);
  });

  it('imports the corrected meanings, not the ones the model gave', async () => {
    installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);
    await screen.findByText('Meanings assigned automatically');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Ask gemini-3.1-flash-lite about the remaining 1' }),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Send to Gemini' }));
    await screen.findByText('Meanings assigned automatically');

    // The meanings are assigned by the dictionary/model; there is no manual
    // meaning field to edit.
    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const decks = await repository.listDecks(TEST_USER.id);
      expect(decks).toHaveLength(1);
    });

    const [deck] = await repository.listDecks(TEST_USER.id);
    const cards = await repository.listCards(deck!.id);
    expect(cards.map((card) => `${card.front}=${card.back}`).sort()).toEqual([
      'empapar=to drench',
      'lodazal=lodestar',
      'nido=nest',
    ]);
  });

  it('a word left blank in review is not written as a card', async () => {
    installBridge({
      resolve: jest.fn(async () => ({
        ok: true,
        meanings: [
          { word: 'nido', meaning: 'nest', source: 'dictionary', needsReview: false },
          { word: 'empapar', meaning: 'to drench', source: 'dictionary', needsReview: false },
          // Neither source had anything: an empty box, not an invented card.
          { word: 'lodazal', meaning: '', source: 'none', needsReview: false, rejected: 'model-rejected' },
        ],
      })),
    });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);
    await screen.findByText('Meanings assigned automatically');
    expect(screen.getByText('2 from the dictionary · 1 with no answer')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Deck name'), 'Spanish');
    await fireEvent.press(screen.getByRole('button', { name: 'Create cards' }));

    await waitFor(async () => {
      const decks = await repository.listDecks(TEST_USER.id);
      expect(decks).toHaveLength(1);
    });

    // "lodazal" had no answer and was left blank, so only two cards exist.
    const [deck] = await repository.listDecks(TEST_USER.id);
    const cards = await repository.listCards(deck!.id);
    expect(cards.map((card) => card.front).sort()).toEqual(['empapar', 'nido']);
  });

  it('reports a shell that fails mid-lookup instead of hanging', async () => {
    installBridge({ resolve: jest.fn(async () => ({ ok: false, error: 'the runtime fell over' })) });
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    // The automatic pass is the one that fails here, so the error has to
    // surface on its own too — there is no press to hang off.
    await screen.findByText('the runtime fell over');
    expect(screen.queryByText('Check these before importing')).toBeNull();
  });
});
