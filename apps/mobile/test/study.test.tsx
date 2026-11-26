import { fireEvent, screen, waitFor } from '@testing-library/react-native';
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
    // Make the reviewed card due so reopening selects it again.
    await repository.updateCard(first!, { nextReview: new Date(Date.now() - 1000).toISOString() });
    await show();
    await screen.findByRole('button', { name: 'Unstar card' });
    await fireEvent.press(screen.getByRole('button', { name: 'Unstar card' }));
    await screen.findByRole('button', { name: 'Star card' });
    expect((await repository.getCard(first!.id))?.starred).toBe(false);
  });

  /** What a review made on another device looks like once sync applies it. */
  async function answerElsewhere(card: Card) {
    // The card reached the server before the other device studied it; a card
    // still waiting to upload here would (rightly) keep its local copy.
    await repository.markSynced([], [card]);
    const now = Date.now();
    await repository.applyServerChanges(TEST_USER.id, {
      decks: [],
      cards: [{
        ...card,
        phase: 'review',
        status: 'learning',
        interval: 3,
        introducedAt: new Date(now).toISOString(),
        nextReview: new Date(now + 3 * 86_400_000).toISOString(),
        lastModified: new Date(now).toISOString(),
      }],
      reviewEvents: [],
    });
  }

  it('picks up where the cards are after the study screen is reopened', async () => {
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

  it('does not show cards already answered on another device', async () => {
    const [first, second] = await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
      ['vivir', 'to live'],
    ]);
    const view = await show();
    await screen.findByText('hablar');
    await view.unmount();

    // The learner carried on on their phone, and sync brought it here.
    await answerElsewhere(first!);
    await answerElsewhere(second!);

    await show();
    await screen.findByText('vivir');
    expect(screen.queryByText('hablar')).toBeNull();
    expect(screen.getByText('1 / 1')).toBeTruthy();
  });

  it('drops cards another device answers while the session is open', async () => {
    const [first, second] = await seed([
      ['hablar', 'to speak'],
      ['comer', 'to eat'],
      ['vivir', 'to live'],
    ]);
    const view = await show();
    await screen.findByText('hablar');
    expect(screen.getByText('1 / 3')).toBeTruthy();

    await answerElsewhere(first!);
    await answerElsewhere(second!);
    await view.updateState({ remoteChanges: 1 });

    await screen.findByText('vivir');
    expect(screen.queryByText('hablar')).toBeNull();
    expect(screen.getByText('1 / 1')).toBeTruthy();
  });

  it('keeps cards on their learning steps when sync echoes this device\'s own answers', async () => {
    await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    const view = await show();
    await screen.findByText('hablar');
    expect(screen.getByText('1 / 2')).toBeTruthy();

    // "Again" puts a new card on its first learning step, minutes away, so it
    // goes back on the end of this session's queue.
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Again' }));
    await screen.findByText('comer');
    expect(screen.getByText('2 / 3')).toBeTruthy();

    // The push/pull round trip hands this device its own review back, which
    // the app reports as a remote change. Nothing was answered elsewhere, so
    // the learning card must still be waiting at the end of the session.
    await view.updateState({ remoteChanges: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('2 / 3')).toBeTruthy();

    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));
    await screen.findByText('hablar');
    expect(screen.getByText('3 / 4')).toBeTruthy();
  });

  it('keeps a revealed card on screen when another device answers it', async () => {
    const [first] = await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    const view = await show();
    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('to speak');

    await answerElsewhere(first!);
    await view.updateState({ remoteChanges: 1 });

    // The answer being read stays put; the rest of the queue is still there.
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    expect(screen.getByText('hablar')).toBeTruthy();
    expect(screen.getByText('to speak')).toBeTruthy();
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

  it('undoes a rating even after it has synced', async () => {
    const [first] = await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    await show();
    await screen.findByText('hablar');
    await reveal();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));
    await screen.findByText('comer');

    // The background push runs every few seconds; undo used to stop working after it.
    await repository.markSynced([], [], await repository.pendingReviewEvents(TEST_USER.id));

    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('hablar');
    expect((await repository.getCard(first!.id))?.phase).toBe('new');
  });

  it('suspends a card from the top bar without opening the options, and can undo it', async () => {
    const [first] = await seed([['hablar', 'to speak'], ['comer', 'to eat']]);
    await show();
    await screen.findByText('hablar');

    // Available before the answer is revealed, with no options menu in the way.
    await fireEvent.press(screen.getByRole('button', { name: 'Suspend card' }));
    await screen.findByText('comer');
    expect((await repository.getCard(first!.id))?.suspended).toBe(true);

    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('hablar');
    expect((await repository.getCard(first!.id))?.suspended).toBeFalsy();
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
      // "Easy" skips the learning steps for FSRS's easy interval (about eight
      // days at 90% retention), where "Good" would have left the card ten
      // minutes out. Anki fuzzes the exact number of days, so the assertion
      // is the fuzz window, not the midpoint.
      expect(stored?.phase).toBe('review');
      expect(stored?.interval).toBeGreaterThanOrEqual(6);
      expect(stored?.interval).toBeLessThanOrEqual(10);
      expect(stored?.stability).toBeGreaterThan(0);
    });
  });

  it('ends the session once the last card has left the learning steps', async () => {
    await seed([['hablar', 'to speak']]);
    await show();

    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('to speak');
    // Good once is a learning step, so the card returns; good again graduates
    // it to a day-level interval and the session is over.
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
    // FSRS's easy interval. The preview runs the same `review` the button
    // will, against the same scheduling state, so it cannot drift from it.
    expect(screen.getByText('1 min')).toBeTruthy();
    expect(screen.getByText('6 min')).toBeTruthy();
    expect(screen.getByText('10 min')).toBeTruthy();
    expect(screen.getByText(/^([6-9]|10) d$/)).toBeTruthy();
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

  it('defines a captured word with the model and normalizes it with the dictionary', async () => {
    const [card] = await seed([['hablar', 'to speak']]);
    await repository.updateCard(card!, {
      examples: ['Ellos comieron juntos.'],
    });
    (globalThis as Record<string, unknown>).fluentflowDesktop = {
      platform: 'darwin',
      ai: {
        status: async () => ({
          dictionary: { available: true, languages: { es: true } },
          cloud: { available: true, configured: true, model: 'gemini-test' },
        }),
        resolve: async (words: string[], _language: string, options?: { useModel?: boolean }) => ({
          ok: true,
          meanings: words.map((word) => {
            if (word !== 'comieron') return { word, meaning: '', source: 'none', needsReview: false };
            // The model defines; the dictionary only supplies the infinitive.
            return options?.useModel === false
              ? { word, meaning: 'dictionary gloss', source: 'dictionary', correctedWord: 'comer', needsReview: false }
              : { word, meaning: 'they ate', source: 'model', needsReview: true };
          }),
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
      const captured = cards.find((item) => item.front === 'comer');
      expect(captured?.back).toBe('they ate');
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
