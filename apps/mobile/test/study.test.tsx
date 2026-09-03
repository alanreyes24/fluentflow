import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Card, Deck } from '@fluentflow/core';
import StudyScreen from '../app/(app)/study/[deckId]';
import { ExampleService } from '../src/ai/service';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { mockSearchParams, renderScreen, TEST_USER } from './setup';

/**
 * The study session, rendered.
 *
 * The repository is real and backed by real SQLite, so "press Good" here runs
 * the same SM-2 code a phone runs and writes the same row. What is asserted is
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
    expect(screen.getByText('2 / 2')).toBeTruthy();
    // The next card starts hidden again.
    expect(screen.queryByText('to eat')).toBeNull();

    const stored = await repository.getCard(first!.id);
    expect(stored?.repetitions).toBe(1);
    expect(stored?.interval).toBeGreaterThan(0);
    expect(stored?.syncStatus).toBe('pending');
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
      // "Easy" raises the ease factor above the 2.5 default; "Good" leaves it.
      expect(stored?.easeFactor).toBeGreaterThan(2.5);
    });
  });

  it('ends the session after the last card', async () => {
    await seed([['hablar', 'to speak']]);
    await show();

    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('to speak');
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await screen.findByText('Nothing left to review');
    expect(screen.getByText(/1 reviewed/)).toBeTruthy();
  });

  it('offers nothing to review when the queue is empty', async () => {
    await show();
    await screen.findByText('Nothing left to review');
    // No count when the session reviewed nothing — "0 reviewed" would be noise.
    expect(screen.queryByText(/reviewed/)).toBeNull();
  });

  it('leaves a card scheduled in the future out of the queue', async () => {
    const [card] = await seed([['hablar', 'to speak']]);
    await repository.rateCard(card!, 'easy');

    await show();

    await screen.findByText('Nothing left to review');
    expect(screen.queryByText('hablar')).toBeNull();
  });
});
