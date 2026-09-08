import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Card, Deck } from '@fluentflow/core';
import StatsScreen from '../app/(app)/stats';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { renderScreen, TEST_USER } from './setup';

/**
 * The statistics screen, over a real review log.
 *
 * Nothing here is handed to the component: the reviews are made through
 * `rateCard`, so the retention and rating split are computed from rows the app
 * itself wrote.
 */

describe('StatsScreen', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let repository: Repository;
  let deck: Deck;

  async function card(front: string, back: string): Promise<Card> {
    return repository.addCard(TEST_USER.id, deck, front, back);
  }

  function show() {
    return renderScreen(<StatsScreen />, { repository, user: TEST_USER });
  }

  beforeEach(async () => {
    context = await createTestRepository();
    repository = context.repository;
    deck = await repository.createDeck(TEST_USER.id, 'Spanish Verbs', 'es');
  });

  afterEach(async () => {
    await context.close();
  });

  /** Local noon `days` ago, well clear of either midnight. */
  function daysAgo(days: number): Date {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return date;
  }

  it('says there is nothing to show before the first review', async () => {
    await show();

    await screen.findByText('No reviews yet');
    expect(screen.getByText('Rate a card and this screen fills in.')).toBeTruthy();
  });

  it('reports retention as the share of reviews not rated Again', async () => {
    const subject = await card('hablar', 'to speak');
    await repository.rateCard(subject, 'good');
    await repository.rateCard(subject, 'good');
    await repository.rateCard(subject, 'good');
    await repository.rateCard(subject, 'again');

    await show();

    await screen.findByLabelText('Retention: 75%');
    // And the rating split agrees with it: one of the four was Again.
    expect(screen.getByText('25%')).toBeTruthy();
  });

  it('narrows to the last seven days when asked', async () => {
    const subject = await card('hablar', 'to speak');
    await repository.rateCard(subject, 'good', daysAgo(20));
    await repository.rateCard(subject, 'good', daysAgo(1));

    await show();

    // 30 days is the default, so both reviews are in view.
    await screen.findByLabelText('Reviews: 2');

    await fireEvent.press(screen.getByRole('button', { name: '7 days' }));

    // The 20-day-old review drops out of the window; the recent one stays.
    await waitFor(() => expect(screen.getByLabelText('Reviews: 1')).toBeTruthy());
    expect(screen.getByLabelText('Days studied: 1')).toBeTruthy();
  });

  it('breaks the collection down by deck', async () => {
    const other = await repository.createDeck(TEST_USER.id, 'Bosnian Basics', 'bs');
    await card('hablar', 'to speak');
    await repository.addCard(TEST_USER.id, other, 'raditi', 'to work');
    await repository.rateCard((await repository.listCards(deck.id))[0]!, 'good');

    await show();

    await screen.findByText('Spanish Verbs');
    expect(screen.getByText('Bosnian Basics')).toBeTruthy();
    // Nothing has reached the 21-day interval, so neither deck is mastered.
    expect(screen.getAllByText('0% mastered')).toHaveLength(2);
  });
});
