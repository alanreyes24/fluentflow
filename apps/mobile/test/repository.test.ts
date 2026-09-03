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
    expect(row?.user_version).toBe(3);
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

  it('schedules a review through real SM-2 and logs it', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');

    expect(card.interval).toBe(0);
    expect(card.status).toBe('new');

    const reviewed = await repository.rateCard(card, 'good');

    expect(reviewed.repetitions).toBe(1);
    expect(reviewed.interval).toBeGreaterThan(0);
    expect(reviewed.status).toBe('learning');
    expect(new Date(reviewed.nextReview).getTime()).toBeGreaterThan(Date.now());
    expect(await repository.reviewsSince('u1', new Date(Date.now() - 60_000))).toBe(1);
  });

  it('drops the ease factor but never below the SM-2 floor', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    let card = await repository.addCard('u1', deck, 'hablar', 'to speak');

    for (let i = 0; i < 20; i++) {
      card = await repository.rateCard(card, 'again');
    }

    expect(card.easeFactor).toBe(1.3);
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
