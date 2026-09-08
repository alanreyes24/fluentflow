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
    await reveal();
    await screen.findByText('to speak');

    await fireEvent.press(screen.getByRole('button', { name: 'Study options' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Edit' }));

    const back = await screen.findByLabelText('Meaning or translation');
    await fireEvent.changeText(back, 'to talk');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    // Back on the same card, still first in the queue, with the new wording.
    await screen.findByText('to talk');
    expect(screen.getByText('hablar')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();

    const stored = await repository.getCard(card!.id);
    expect(stored?.back).toBe('to talk');
    expect(stored?.phase).toBe('new');
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
