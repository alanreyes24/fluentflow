import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Deck } from '@fluentflow/core';
import DecksScreen from '../app/(app)/decks';
import { SyncIndicator } from '../src/ui/SyncIndicator';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { mockRouter, renderScreen, TEST_USER } from './setup';

/**
 * The deck list, and the offline indicator that sits above it.
 *
 * The progress counts come from real cards through real SM-2, so a deck shows
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

  it('creates a deck and opens it', async () => {
    const { state } = await renderScreen(<DecksScreen />, {
      repository,
      decks: [],
      user: TEST_USER,
    });

    // Two "New deck" buttons while the list is empty: the toolbar action and
    // the empty state's own call to action. Either opens the form.
    await fireEvent.press(screen.getAllByRole('button', { name: 'New deck' })[0]!);
    await fireEvent.changeText(await screen.findByDisplayValue(''), 'Bosnian Basics');
    await fireEvent.press(screen.getByRole('button', { name: 'Create deck' }));

    await waitFor(async () => {
      const decks = await repository.listDecks(TEST_USER.id);
      expect(decks.map((deck: Deck) => deck.name)).toEqual(['Bosnian Basics']);
    });
    expect(state.refreshDecks).toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalled();
  });

  it('routes to import and settings', async () => {
    await renderScreen(<DecksScreen />, { repository, decks: [] });

    await fireEvent.press(screen.getByRole('button', { name: 'Import from Anki' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/import');

    await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings');
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
