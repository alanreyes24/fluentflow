import { createTestRepository } from './fakes/database';

/**
 * The repository against a real SQLite database.
 *
 * These are not view tests, but they are the foundation the view tests stand
 * on: if `rateCard` does not actually schedule, a passing study-screen test
 * means nothing.
 */
describe('Repository', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;

  beforeEach(async () => {
    context = await createTestRepository();
  });

  afterEach(async () => {
    await context.close();
  });

  it('migrates to the current schema version', async () => {
    const row = await context.database.getFirstAsync<{ user_version: number }>(
      'PRAGMA user_version',
    );
    expect(row?.user_version).toBe(4);
  });

  it('round-trips a deck and its cards', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish Verbs', 'es');
    await repository.addCard('u1', deck, 'hablar', 'to speak');
    await repository.addCard('u1', deck, 'comer', 'to eat');

    const decks = await repository.listDecks('u1');
    expect(decks).toHaveLength(1);
    expect(decks[0]?.cardCount).toBe(2);

    const cards = await repository.listCards(deck.id);
    expect(cards.map((card) => card.front)).toEqual(['hablar', 'comer']);
  });

  it('schedules a review through the real scheduler and logs it', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');

    expect(card.interval).toBe(0);
    expect(card.status).toBe('new');
    expect(card.phase).toBe('new');

    // Good on a new card walks it onto the second learning step, not onto a
    // day-level interval; that only comes when the steps run out.
    const learning = await repository.rateCard(card, 'good');

    expect(learning.repetitions).toBe(1);
    expect(learning.phase).toBe('learning');
    expect(learning.interval).toBe(0);
    expect(learning.status).toBe('learning');
    expect(new Date(learning.nextReview).getTime()).toBeGreaterThan(Date.now());

    const graduated = await repository.rateCard(learning, 'good');

    expect(graduated.phase).toBe('review');
    expect(graduated.interval).toBe(1);
    expect(await repository.reviewsSince('u1', new Date(Date.now() - 60_000))).toBe(2);
  });

  it('drops the ease factor on lapses but never below the floor', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    let card = await repository.addCard('u1', deck, 'hablar', 'to speak');

    // Ease only moves on review answers, so the card has to graduate first and
    // be relearned after each lapse. Every round trip costs 0.2 of ease.
    card = await repository.rateCard(card, 'easy');
    expect(card.phase).toBe('review');

    for (let i = 0; i < 20; i++) {
      card = await repository.rateCard(card, 'again');
      expect(card.phase).toBe('relearning');
      card = await repository.rateCard(card, 'good');
    }

    expect(card.easeFactor).toBe(1.3);
    expect(card.lapses).toBe(20);
    expect(card.leech).toBe(true);
  });

  it('keeps deleted decks out of the list but retains the tombstone', async () => {
    const { repository, database } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    await repository.addCard('u1', deck, 'hablar', 'to speak');

    await repository.deleteDeck(deck);

    expect(await repository.listDecks('u1')).toHaveLength(0);
    const rows = await database.getAllAsync<{ deleted: number }>('SELECT deleted FROM decks');
    expect(rows).toEqual([{ deleted: 1 }]);
    // The card is tombstoned too, or the delete never reaches other devices.
    const cards = await database.getAllAsync<{ deleted: number }>('SELECT deleted FROM cards');
    expect(cards).toEqual([{ deleted: 1 }]);
  });

  it('does not cache fallback examples', async () => {
    const { repository } = context;
    await repository.cacheExamples('hablar', 'es', ['«hablar» means "to speak".'], 'fallback');
    expect(await repository.getCachedExamples('hablar', 'es')).toBeNull();

    await repository.cacheExamples('hablar', 'es', ['Yo hablo español.'], 'model');
    expect((await repository.getCachedExamples('hablar', 'es'))?.examples).toEqual([
      'Yo hablo español.',
    ]);
  });

  it('re-homes anonymous data onto a real account', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('local', 'Spanish', 'es');
    await repository.addCard('local', deck, 'hablar', 'to speak');

    const moved = await repository.claimLocalData('local', 'real-user');

    expect(moved).toBe(2);
    expect(await repository.listDecks('local')).toHaveLength(0);
    expect(await repository.listDecks('real-user')).toHaveLength(1);
  });
});
