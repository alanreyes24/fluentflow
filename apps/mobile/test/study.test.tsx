import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collectionDayKey, type Card, type Deck } from '@fluentflow/core';
import StudyScreen from '../app/(app)/study/[deckId]';
import { ExampleService } from '../src/ai/service';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { mockRouter, mockSearchParams, renderScreen, TEST_USER } from './setup';

/**
 * The study session, rendered.
 *
 * The repository is real and backed by real SQLite, so "press Good" here runs
 * the same scheduler the app runs and writes the same row. What is asserted is
 * the sequencing the screen is responsible for: what is on screen before the
 * reveal, what appears after it, and that a rating advances the queue.
 */

describe('StudyScreen', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let repository: Repository;
  let examples: ExampleService;
  let deck: Deck;

  async function seed(words: [string, string][]): Promise<Card[]> {
    const cards: Card[] = [];
    for (const [front, back] of words) {
      cards.push(await repository.addCard(TEST_USER.id, deck, front, back));
    }
    return cards;
  }

  function show() {
    return renderScreen(<StudyScreen />, { repository, examples });
  }

  /**
   * Both the card itself and the button below it reveal the answer, and they
   * share an accessible name, so the query has to say which. Pressing the
   * button is the path a screen-reader user takes.
   */
  async function reveal() {
    const controls = screen.getAllByRole('button', { name: 'Show answer' });
    await fireEvent.press(controls[controls.length - 1]!);
  }


  beforeEach(async () => {
    context = await createTestRepository();
    repository = context.repository;
    examples = new ExampleService(repository);
    deck = await repository.createDeck(TEST_USER.id, 'Spanish Verbs', 'es');
    mockSearchParams.current = { deckId: deck.id };
  });

  afterEach(async () => {
    await context.close();
    await AsyncStorage.removeItem('fluentflow.studySession');
    delete (globalThis as Record<string, unknown>).fluentflowDesktop;
  });

  it('shows the front alone, and only reveals the back when asked', async () => {
    await seed([['hablar', 'to speak']]);
    await show();

    await screen.findByText('hablar');
    expect(screen.queryByText('to speak')).toBeNull();
    // Ratings must not be reachable before the answer is visible, or the
    // grade means nothing.
    expect(screen.queryByRole('button', { name: 'Good' })).toBeNull();

    await reveal();

    await screen.findByText('to speak');
    expect(screen.getByRole('button', { name: 'Again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Good' })).toBeTruthy();
  });

  it('accepts the next rating while deck totals are still refreshing', async () => {
    await seed([['hablar', 'to speak'], ['comer', 'to eat'], ['vivir', 'to live']]);
    const refreshDecks = jest.fn(() => new Promise<void>(() => {}));
    const rateCard = jest.spyOn(repository, 'rateCard');
    await renderScreen(<StudyScreen />, { repository, examples, overrides: { refreshDecks } });
    await screen.findByText('hablar');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));
    await screen.findByText('comer');
    expect(refreshDecks).toHaveBeenCalledTimes(1);
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));
    await screen.findByText('vivir');
    expect(rateCard).toHaveBeenCalledTimes(2);
  });

  it('persists favorites across reveal, review, and reopening the session', async () => {
    const [first] = await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    const view = await show();
    await screen.findByText('hablar');
    await fireEvent.press(screen.getByRole('button', { name: 'Star card' }));
    await screen.findByRole('button', { name: 'Unstar card', selected: true });
    expect((await repository.getCard(first!.id))?.starred).toBe(true);
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Again' }));
    await screen.findByText('comer');
    expect(screen.getByRole('button', { name: 'Star card' })).toBeTruthy();
    expect((await repository.getCard(first!.id))?.starred).toBe(true);
    await view.unmount();
    // This assertion starts a deliberately new session. Resume behavior is
    // covered below; ordinary entry from a deck should still be able to start
    // from the current queue rather than a session the user explicitly left.
    await AsyncStorage.removeItem('fluentflow.studySession');
    // Make the reviewed card due so reopening selects it again.
    await repository.updateCard(first!, { nextReview: new Date(Date.now() - 1000).toISOString() });
    await show();
    await screen.findByRole('button', { name: 'Unstar card' });
    await fireEvent.press(screen.getByRole('button', { name: 'Unstar card' }));
    await screen.findByRole('button', { name: 'Star card' });
    expect((await repository.getCard(first!.id))?.starred).toBe(false);
  });

  it('resumes the current card after the study screen is reopened', async () => {
    await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    const view = await show();
    await screen.findByText('hablar');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));
    await screen.findByText('comer');
    await view.unmount();

    await show();
    await screen.findByText('comer');
  });

  it('starts no more than the deck limit of untouched new cards', async () => {
    deck = await repository.setNewCardsPerDay(deck, 2);
    await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
      ['vivir', 'to live'],
    ]);

    await show();

    await screen.findByText('hablar');
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByLabelText('New: 2')).toBeTruthy();
    expect(screen.getByLabelText('Learn: 0')).toBeTruthy();
    expect(screen.getByLabelText('Review: 0')).toBeTruthy();
  });

  it('schedules the card and advances to the next one', async () => {
    const [first] = await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
    ]);
    await show();

    await screen.findByText('hablar');
    expect(screen.getByText('1 / 2')).toBeTruthy();

    await reveal();
    await screen.findByText('to speak');
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await screen.findByText('comer');
    // The rated card is still on its learning steps, so the queue grew: it is
    // waiting at the back rather than being finished for the day.
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(screen.getByLabelText('New: 1')).toBeTruthy();
    expect(screen.getByLabelText('Learn: 1')).toBeTruthy();
    expect(screen.getByLabelText('Review: 0')).toBeTruthy();
    // The next card starts hidden again.
    expect(screen.queryByText('to eat')).toBeNull();

    const stored = await repository.getCard(first!.id);
    expect(stored?.repetitions).toBe(1);
    expect(stored?.phase).toBe('learning');
    expect(stored?.syncStatus).toBe('pending');
  });

  it('accepts only one rating while the save is pending', async () => {
    await seed([['hablar', 'to speak'], ['comer', 'to eat'], ['vivir', 'to live']]);
    const original = repository.rateCard.bind(repository);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const rate = jest.spyOn(repository, 'rateCard').mockImplementation(async (...args) => {
      await pending;
      return original(...args);
    });
    await show();
    await screen.findByText('hablar');
    await reveal();
    const good = screen.getByRole('button', { name: 'Good' });
    await fireEvent.press(good);
    await fireEvent.press(good);
    expect(rate).toHaveBeenCalledTimes(1);
    release();
    await screen.findByText('comer');
    expect(screen.getByText('2 / 4')).toBeTruthy();
    expect(screen.queryByText('to eat')).toBeNull();
  });

  it('separates due reviews from new cards in the remaining counters', async () => {
    const [reviewCard] = await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
    ]);
    const now = new Date();
    await repository.updateCard(reviewCard!, {
      phase: 'review',
      interval: 2,
      nextReview: now.toISOString(),
      dueDay: collectionDayKey(now),
      status: 'learning',
    });

    await show();

    await screen.findByText('hablar');
    expect(screen.getByLabelText('New: 1')).toBeTruthy();
    expect(screen.getByLabelText('Learn: 0')).toBeTruthy();
    expect(screen.getByLabelText('Review: 1')).toBeTruthy();

    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await screen.findByText('comer');
    expect(screen.getByLabelText('New: 1')).toBeTruthy();
    expect(screen.getByLabelText('Review: 0')).toBeTruthy();
  });

  it('brings a card still on its learning steps back before the session ends', async () => {
    await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
    ]);
    await show();

    await screen.findByText('hablar');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await screen.findByText('comer');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    // Both cards owe another step, so the first one comes round again.
    await screen.findByText('hablar');
    expect(screen.getByText('3 / 4')).toBeTruthy();
  });

  it('records the rating that was actually pressed', async () => {
    const [card] = await seed([['hablar', 'to speak']]);
    await show();

    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('to speak');
    await fireEvent.press(screen.getByRole('button', { name: 'Easy' }));

    await waitFor(async () => {
      const stored = await repository.getCard(card!.id);
      // "Easy" skips the learning steps for the four-day easy interval, where
      // "Good" would have left the card ten minutes out. Anki fuzzes the exact
      // number of days, so the assertion is the window, not the midpoint.
      expect(stored?.phase).toBe('review');
      expect(stored?.interval).toBeGreaterThanOrEqual(3);
      expect(stored?.interval).toBeLessThanOrEqual(5);
    });
  });

  it('ends the session once the last card has left the learning steps', async () => {
    await seed([['hablar', 'to speak']]);
    await show();

    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('to speak');
    // Good once is a learning step, so the card returns; good again graduates
    // it to a one-day interval and the session is over.
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await screen.findByText('hablar');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks'));
  });

  it('picks up learning cards that become due during the session before returning home', async () => {
    const [, pending] = await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    await repository.updateCard(pending!, {
      phase: 'learning',
      learningStep: 1,
      nextReview: new Date(Date.now() + 60_000).toISOString(),
    });
    await show();
    await screen.findByText('hablar');
    expect(screen.getByText('1 / 1')).toBeTruthy();

    // Simulate the pending learning timer elapsing while the first card is open.
    await repository.updateCard((await repository.getCard(pending!.id))!, {
      nextReview: new Date(Date.now() - 1000).toISOString(),
    });
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Easy' }));
    await screen.findByText('comer');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Easy' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks'));
    expect((await repository.studyQueue(deck.id)).cards).toHaveLength(0);
  });

  it('continues with another batch when the initial queue is exhausted', async () => {
    await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    const dueCards = repository.dueCards.bind(repository);
    jest.spyOn(repository, 'dueCards').mockImplementation((id, now, _limit, newLimit, reviewLimit) =>
      dueCards(id, now, 1, newLimit, reviewLimit));
    await show();
    await screen.findByText('hablar');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Easy' }));
    await screen.findByText('comer');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Easy' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks'));
    expect((await repository.studyQueue(deck.id)).cards).toHaveLength(0);
  });

  it('honors unlimited daily allowances when opening a session', async () => {
    deck = await repository.setNewCardsPerDay(deck, null);
    deck = await repository.setMaxReviewsPerDay(deck, null);
    await seed(Array.from({ length: 21 }, (_, i) => [`word${i}`, `meaning${i}`]));
    const dueCards = jest.spyOn(repository, 'dueCards');
    await show();
    await screen.findByText('word0');
    expect(screen.getByText('1 / 21')).toBeTruthy();
    expect(dueCards).toHaveBeenCalledWith(deck.id, expect.any(Date), 200, null, null);
  });

  it('previews the interval each rating would schedule', async () => {
    await seed([['hablar', 'to speak']]);
    await show();

    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('to speak');

    // A brand-new card walks the learning steps (1m, 10m): Again restarts them,
    // Hard sits between, Good moves to the next, and Easy graduates straight to
    // the four-day interval. The preview runs the same `review` the button
    // will, against the same scheduling state, so it cannot drift from it.
    expect(screen.getByText('1 min')).toBeTruthy();
    expect(screen.getByText('6 min')).toBeTruthy();
    expect(screen.getByText('10 min')).toBeTruthy();
    expect(screen.getByText(/^[345] d$/)).toBeTruthy();
  });

  it('returns home once the queue runs out', async () => {
    await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
    ]);
    await show();

    // Neither of the first two answers ends the card's day: Good and Again both
    // leave a new card on a learning step inside the twenty-minute learn-ahead
    // window, so both come back. Easy graduates them, and the app returns home.
    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('to speak');
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await screen.findByText('comer');
    await reveal();
    await screen.findByText('to eat');
    await fireEvent.press(screen.getByRole('button', { name: 'Again' }));

    await screen.findByText('hablar');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Easy' }));

    await screen.findByText('comer');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Easy' }));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks'));
  });

  it('edits the card on screen without losing its place in the session', async () => {
    const [card] = await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
    ]);
    await show();

    await screen.findByText('hablar');
    await fireEvent.press(screen.getByRole('button', { name: 'Edit' }));

    const back = await screen.findByLabelText('Meaning or translation');
    await fireEvent.changeText(back, 'to talk');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    // Back on the same card, still first in the queue and awaiting reveal.
    await screen.findByText('hablar');
    expect(screen.queryByText('to talk')).toBeNull();
    expect(screen.getByText('1 / 2')).toBeTruthy();

    await reveal();
    await screen.findByText('to talk');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();

    const stored = await repository.getCard(card!.id);
    expect(stored?.back).toBe('to talk');
    expect(stored?.phase).toBe('new');
  });

  it('normalizes a conjugated word captured from an example', async () => {
    const [card] = await seed([['hablar', 'to speak']]);
    await repository.updateCard(card!, {
      examples: ['Ellos comieron juntos.'],
    });
    (globalThis as Record<string, unknown>).fluentflowDesktop = {
      platform: 'darwin',
      ai: {
        status: async () => ({
          dictionary: { available: true, languages: { es: true } },
        }),
        resolve: async (words: string[]) => ({
          ok: true,
          meanings: words.map((word) => word === 'comieron'
            ? {
                word,
                meaning: 'to eat',
                source: 'dictionary',
                correctedWord: 'comer',
                needsReview: false,
              }
            : { word, meaning: '', source: 'none', needsReview: false }),
        }),
        onProgress: () => () => {},
      },
    };
    await show();

    await screen.findByText('hablar');
    await reveal();
    await screen.findByRole('button', { name: 'comieron' });
    await fireEvent.press(screen.getByRole('button', { name: 'comieron' }));

    await waitFor(async () => {
      const cards = await repository.listCards(deck.id);
      expect(cards.some((item) => item.front === 'comer')).toBe(true);
      expect(cards.some((item) => item.front === 'comieron')).toBe(false);
    });
  });

  it('offers nothing to review when the queue is empty', async () => {
    await show();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks'));
  });

  it('leaves a card scheduled in the future out of the queue', async () => {
    const [card] = await seed([['hablar', 'to speak']]);
    await repository.rateCard(card!, 'easy');

    await show();

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks'));
    expect(screen.queryByText('hablar')).toBeNull();
  });
});
