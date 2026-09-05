import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import TextImportScreen from '../app/(app)/text-import';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { mockSearchParams, renderScreen, TEST_USER } from './setup';

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
 * The desktop shell's lookup bridge.
 *
 * Installed on `globalThis` exactly as `contextBridge` installs it, so the
 * screen's own detection runs rather than a mock of it. The answers are real:
 * the dictionary rows are what the distilled Wiktionary file returns, and the
 * model row is what Qwen2.5-1.5B actually said about a word it did not know.
 */
function installBridge(overrides = {}) {
  const bridge = {
    platform: 'darwin',
    ai: {
      status: jest.fn(async () => ({
        dictionary: { available: true, languages: { es: true, bs: true }, source: { es: 'Spanish' } },
        model: { available: true, name: 'Qwen/Qwen2.5-1.5B-Instruct' },
      })),
      resolve: jest.fn(async () => ({
        ok: true,
        meanings: [
          { word: 'nido', meaning: 'nest', source: 'dictionary', needsReview: false },
          { word: 'empapar', meaning: 'to drench', source: 'dictionary', needsReview: false },
          { word: 'lodazal', meaning: 'lodestar', source: 'model', needsReview: true },
        ],
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
    expect(screen.getByText('Import complete')).toBeTruthy();
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

  it('reads a bare word list as words, not as one enormous card', async () => {
    await renderScreen(<TextImportScreen />, { repository });
    await paste(WORDS);

    // The bug this covers: with no separators and no blank lines, three lines
    // used to become one card with "empapar lodazal" on its back.
    expect(screen.getByText('3 cards ready')).toBeTruthy();
    expect(screen.getByText('Separator: One word per line')).toBeTruthy();
    expect(screen.getByText('3 words with no meaning yet')).toBeTruthy();
  });

  it('will not import words that have no meaning', async () => {
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    // Nothing to write yet: a card with a blank back is not a card.
    expect(screen.getByRole('button', { name: 'Create cards' })).toBeDisabled();
  });

  it('says why it cannot look anything up when nothing is installed', async () => {
    installBridge({
      status: jest.fn(async () => ({
        dictionary: { available: false, reason: 'No dictionaries in ~/dictionaries' },
        model: { available: false },
      })),
    });
    await renderScreen(<TextImportScreen />, { repository });
    await paste(WORDS);

    await screen.findByText(/No dictionary or model installed/);
    expect(screen.queryByRole('button', { name: 'Look up the meanings' })).toBeNull();
  });

  it('offers the lookup when only a dictionary is installed', async () => {
    installBridge({
      status: jest.fn(async () => ({
        dictionary: { available: true, languages: { es: true }, source: { es: 'Spanish' } },
        model: { available: false, reason: 'No model' },
      })),
    });
    await renderScreen(<TextImportScreen />, { repository });
    await paste(WORDS);

    // The dictionary alone is the good case, not a degraded one.
    await screen.findByRole('button', { name: 'Look up the meanings' });
  });

  it('says where every meaning came from, and flags the model ones', async () => {
    const bridge = installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);

    await fireEvent.press(await screen.findByRole('button', { name: 'Look up the meanings' }));

    await screen.findByText('Check these before importing');
    expect(bridge.ai.resolve).toHaveBeenCalledWith(['nido', 'empapar', 'lodazal'], 'es');

    expect(screen.getByLabelText('nido').props.value).toBe('nest');
    expect(screen.getByLabelText('empapar').props.value).toBe('to drench');
    expect(screen.getByLabelText('lodazal').props.value).toBe('lodestar');

    // Two came from the dictionary and can be skimmed; the third is a guess and
    // says so, which is the whole reason the sources are tracked separately.
    expect(screen.getAllByText('dictionary')).toHaveLength(2);
    expect(screen.getByText('model — check this')).toBeTruthy();
    expect(screen.getByText('2 from the dictionary, 1 from the model, 0 not found')).toBeTruthy();

    // Still nothing written: the deck is untouched until the user says so.
    expect(await repository.listDecks(TEST_USER.id)).toHaveLength(0);
  });

  it('imports the corrected meanings, not the ones the model gave', async () => {
    installBridge();
    await renderScreen(<TextImportScreen />, { repository, user: TEST_USER });
    await paste(WORDS);
    await fireEvent.press(await screen.findByRole('button', { name: 'Look up the meanings' }));
    await screen.findByText('Check these before importing');

    // The model's "lodestar" is wrong and the user fixes it; the dictionary's
    // "to drench" is fine but they prefer their own wording.
    await fireEvent.changeText(screen.getByLabelText('empapar'), 'to soak');
    await fireEvent.changeText(screen.getByLabelText('lodazal'), 'quagmire');
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
      'lodazal=quagmire',
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
    await fireEvent.press(await screen.findByRole('button', { name: 'Look up the meanings' }));
    await screen.findByText('Check these before importing');
    expect(screen.getByText('not found')).toBeTruthy();

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

    await fireEvent.press(await screen.findByRole('button', { name: 'Look up the meanings' }));

    await screen.findByText('the runtime fell over');
    expect(screen.queryByText('Check these before importing')).toBeNull();
  });
});
