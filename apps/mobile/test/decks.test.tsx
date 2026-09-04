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
    expect(screen.getByText('Create a deck or import one from Anki to get started.')).toBeTruthy();
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

  it('routes to import, statistics and settings', async () => {
    await renderScreen(<DecksScreen />, { repository, decks: [] });

    await fireEvent.press(screen.getByRole('button', { name: 'Import from Anki' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/import');

    await fireEvent.press(screen.getByRole('button', { name: 'Statistics' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/stats');

    await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings');
  });

  /**
   * The panel above the list.
   *
   * It exists to answer "what should I do right now" before any deck name is
   * read, so what is asserted is that its four numbers come from the review
   * log and the cards rather than from anywhere convenient.
   */
  describe('today', () => {
    /** Local noon `days` ago, well clear of either midnight. */
    function daysAgo(days: number): Date {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - days);
      return date;
    }

    async function seedStreak() {
      const deck = await repository.createDeck(TEST_USER.id, 'Spanish', 'es');
      const studied = await repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
      await repository.addCard(TEST_USER.id, deck, 'comer', 'to eat');
      await repository.rateCard(studied, 'good', daysAgo(1));
      await repository.rateCard(studied, 'good', new Date());
      const [stored] = await repository.listDecks(TEST_USER.id);
      return stored!;
    }

    it('counts yesterday and today as a two-day streak', async () => {
      const deck = await seedStreak();
      await renderScreen(<DecksScreen />, { repository, decks: [deck] });

      await screen.findByLabelText('2 day streak');
      expect(screen.getByText('Kept up today')).toBeTruthy();
    });

    it('separates what is due from what has been reviewed today', async () => {
      const deck = await seedStreak();
      await renderScreen(<DecksScreen />, { repository, decks: [deck] });

      // One card was rated twice and is scheduled days out; the other is new.
      await waitFor(() => expect(screen.getByLabelText('Due today: 1')).toBeTruthy());
      expect(screen.getByLabelText('Reviewed: 1')).toBeTruthy();
      expect(screen.getByLabelText('Cards: 2')).toBeTruthy();
    });

    it('opens the deck with the most cards waiting', async () => {
      const deck = await seedStreak();
      await renderScreen(<DecksScreen />, { repository, decks: [deck] });

      const study = await screen.findByRole('button', { name: 'Study · Spanish' });
      await fireEvent.press(study);

      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/(app)/study/[deckId]',
        params: { deckId: deck.id },
      });
    });

    it('stays out of the way when there are no decks at all', async () => {
      await renderScreen(<DecksScreen />, { repository, decks: [] });

      await screen.findByText('No decks yet');
      // A panel of zeroes is noise on a first launch.
      expect(screen.queryByText('Day streak')).toBeNull();
    });
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
