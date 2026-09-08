import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { collectionDayKey, type Deck } from '@fluentflow/core';
import DecksScreen from '../app/(app)/decks';
import DeckScreen from '../app/(app)/deck/[id]';
import NewDeckScreen from '../app/(app)/new-deck';
import { BottomBar } from '../src/ui/BottomBar';
import { SyncIndicator } from '../src/ui/SyncIndicator';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { mockRouter, mockSearchParams, renderScreen, TEST_USER } from './setup';

/**
 * The deck list, the toolbar under it, and the offline indicator in that
 * toolbar.
 *
 * The progress counts come from real cards through the real scheduler, so a deck shows
 * "new / learning / mastered" because those cards genuinely are in those
 * states, not because the numbers were handed to the component.
 */

describe('DecksScreen', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let repository: Repository;

  beforeEach(async () => {
    context = await createTestRepository();
    repository = context.repository;
  });

  afterEach(async () => {
    await context.close();
  });

  it('invites the first deck when there are none', async () => {
    await renderScreen(<DecksScreen />, { repository, decks: [] });

    await screen.findByText('No decks yet');
    expect(screen.getByText('Create a deck, paste a word list, or import one from Anki.')).toBeTruthy();
  });

  it('lists a deck with its language and card count', async () => {
    const deck = await repository.createDeck(TEST_USER.id, 'Spanish Verbs', 'es');
    await repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
    const [stored] = await repository.listDecks(TEST_USER.id);

    await renderScreen(<DecksScreen />, { repository, decks: [stored!] });

    await screen.findByText('Spanish Verbs');
    // Languages are named in their own language, not the interface's.
    expect(screen.getByText('Español · 1 cards')).toBeTruthy();
  });

  it('shows the number of cards available in today\'s study queue', async () => {
    const deck = await repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    for (let index = 0; index < 25; index += 1) {
      await repository.addCard(TEST_USER.id, deck, `palabra-${index}`, `word-${index}`);
    }
    const [stored] = await repository.listDecks(TEST_USER.id);

    await renderScreen(<DecksScreen />, { repository, decks: [stored!] });

    await waitFor(() => {
      expect(screen.getByText('20 due')).toBeTruthy();
    });
    expect(screen.queryByText('25 due')).toBeNull();
  });

  it('breaks a deck down into new, learning and mastered', async () => {
    const deck = await repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    const learning = await repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
    await repository.addCard(TEST_USER.id, deck, 'comer', 'to eat');
    await repository.rateCard(learning, 'good');
    const [stored] = await repository.listDecks(TEST_USER.id);

    await renderScreen(<DecksScreen />, { repository, decks: [stored!] });

    await screen.findByText('Spanish');
    await waitFor(() => {
      expect(screen.getByText('New 1')).toBeTruthy();
      expect(screen.getByText('Learning 1')).toBeTruthy();
      expect(screen.getByText('Mastered 0')).toBeTruthy();
    });
  });

  it('shows waiting learning steps across the day boundary instead of claiming the cycle is finished', async () => {
    let deck = await repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    deck = await repository.setNewCardsPerDay(deck, 1);
    const card = await repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
    const learning = await repository.rateCard(card, 'good');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await repository.updateCard(learning, {
      nextReview: tomorrow.toISOString(),
      dueDay: collectionDayKey(tomorrow),
    });
    const [stored] = await repository.listDecks(TEST_USER.id);

    await renderScreen(<DecksScreen />, { repository, decks: [stored!] });

    expect(await screen.findByText('Learning steps pending: 1')).toBeTruthy();
    expect(screen.queryByText('All caught up')).toBeNull();
    expect(screen.getByRole('button', { name: 'Study ahead' })).toBeTruthy();
    expect(screen.getByText('⏱ 1')).toBeTruthy();
  });

  it('shows the streak at the top of the deck screen', async () => {
    const deck = await repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    const subject = await repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - 1);
    await repository.rateCard(subject, 'good', date);
    await repository.rateCard(subject, 'good');
    const [stored] = await repository.listDecks(TEST_USER.id);

    await renderScreen(<DecksScreen />, { repository, decks: [stored!], user: TEST_USER });

    await screen.findByLabelText('2 day streak');
    expect(screen.getByText('Kept up today')).toBeTruthy();
  });

  it('creates a deck and opens it', async () => {
    const { state } = await renderScreen(<NewDeckScreen />, {
      repository,
      decks: [],
      user: TEST_USER,
    });

    await fireEvent.changeText(await screen.findByDisplayValue(''), 'Bosnian Basics');
    await fireEvent.press(screen.getByRole('button', { name: 'Create deck' }));

    await waitFor(async () => {
      const decks = await repository.listDecks(TEST_USER.id);
      expect(decks.map((deck: Deck) => deck.name)).toEqual(['Bosnian Basics']);
    });
    expect(state.refreshDecks).toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalled();
  });

  it('offers Anki import from the new-deck screen', async () => {
    await renderScreen(<NewDeckScreen />, { repository, decks: [], user: TEST_USER });

    expect(screen.getByText('Import from Anki')).toBeTruthy();
    expect(screen.getByText('Export a deck from Anki Desktop with File › Export › Anki Deck Package.')).toBeTruthy();
  });

});

describe('DeckScreen', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;

  beforeEach(async () => {
    context = await createTestRepository();
  });

  afterEach(async () => {
    await context.close();
  });

  it('persists a changed daily new-card limit', async () => {
    const deck = await context.repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    mockSearchParams.current = { id: deck.id };

    await renderScreen(<DeckScreen />, { repository: context.repository });
    await screen.findByText('New cards per day');
    await fireEvent.press(screen.getByRole('button', { name: 'New cards per day' }));
    await fireEvent.press(screen.getByRole('button', { name: '40' }));

    await waitFor(async () => {
      expect((await context.repository.getDeck(deck.id))?.newCardsPerDay).toBe(40);
    });
  });

  it('minimizes the card list until it is opened', async () => {
    const deck = await context.repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    await context.repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
    mockSearchParams.current = { id: deck.id };

    await renderScreen(<DeckScreen />, { repository: context.repository });
    await screen.findByText('Español');

    expect(screen.queryByText('hablar')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Cards' }));
    expect(await screen.findByText('hablar')).toBeTruthy();
  });

  it('shows Anki-style counts for today before study starts', async () => {
    const deck = await context.repository.createDeck(TEST_USER.id, 'Spanish', 'es');
    for (let index = 0; index < 25; index += 1) {
      await context.repository.addCard(TEST_USER.id, deck, `palabra-${index}`, `word-${index}`);
    }
    mockSearchParams.current = { id: deck.id };

    await renderScreen(<DeckScreen />, { repository: context.repository });

    await screen.findByText('Today');
    expect(screen.getByLabelText('New: 20')).toBeTruthy();
    expect(screen.getByLabelText('Learn: 0')).toBeTruthy();
    expect(screen.getByLabelText('Review: 0')).toBeTruthy();
  });
});

/**
 * The toolbar along the bottom of the window.
 *
 * Its actions are the app's, not the open screen's, which is why they are
 * tested apart from any one screen: whatever is showing above it, these four
 * routes have to stay reachable.
 */
describe('BottomBar', () => {
  it('routes to the actions that are not tied to a screen', async () => {
    await renderScreen(<BottomBar />);

    // Short names on purpose: the deck screen's own "Paste a word list" adds to
    // the deck that is open, and the toolbar's starts a new one.
    await fireEvent.press(screen.getByRole('button', { name: 'Paste' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/text-import');

    await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings');
  });

  it('does not show statistics or Anki import in the bottom bar', async () => {
    await renderScreen(<BottomBar />);

    expect(screen.queryByRole('button', { name: 'Statistics' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  });

  it('opens the dedicated new-deck screen', async () => {
    await renderScreen(<BottomBar />);

    await fireEvent.press(screen.getByRole('button', { name: 'New deck' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/new-deck');
  });
});

describe('SyncIndicator', () => {
  it('says offline for an account-less session', async () => {
    await renderScreen(<SyncIndicator />, {
      user: { id: 'local', email: null, anonymous: true },
    });
    expect(screen.getByText('Offline')).toBeTruthy();
  });

  it('reports the pending count ahead of a bare "synced"', async () => {
    await renderScreen(<SyncIndicator />, {
      sync: { state: 'idle', pending: 3, lastSyncedAt: null, error: null },
    });
    // The failure this guards against: claiming "Synced" with unsent reviews.
    expect(screen.getByText('3 pending')).toBeTruthy();
    expect(screen.queryByText('Synced')).toBeNull();
  });

  it.each([
    ['syncing', 'Syncing…'],
    ['offline', 'Offline'],
    ['error', 'Sync failed'],
    ['idle', 'Synced'],
  ] as const)('renders the %s state', async (state, label) => {
    await renderScreen(<SyncIndicator />, {
      sync: { state, pending: 0, lastSyncedAt: null, error: null },
    });
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('syncs when tapped', async () => {
    const { state } = await renderScreen(<SyncIndicator />);
    await fireEvent.press(screen.getByRole('button'));
    expect(state.syncNow).toHaveBeenCalled();
  });

  it('shows nothing before anyone has signed in', async () => {
    await renderScreen(<SyncIndicator />, { user: null });
    // No user, no claim about sync state either way.
    for (const label of ['Synced', 'Syncing…', 'Offline', 'Sync failed']) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByRole('button')).toBeNull();
  });
});
