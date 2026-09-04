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

  /**
   * The statistics queries.
   *
   * The bucketing is the part worth testing rather than assuming: reviews are
   * stored as UTC timestamps and grouped into *local* days by a SQLite date
   * modifier the repository builds from the device offset. A review made at
   * 23:00 local has to land on today even when UTC has already rolled over.
   */
  describe('statistics', () => {
    /** Local noon `days` ago — far enough from either midnight to be stable. */
    const daysAgo = (days: number) => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - days);
      return date;
    };

    const localDay = (date: Date) =>
      `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;

    it('groups reviews into local days, newest last', async () => {
      const { repository } = context;
      const deck = await repository.createDeck('u1', 'Spanish', 'es');
      const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
      const other = await repository.addCard('u1', deck, 'comer', 'to eat');

      await repository.rateCard(card, 'good', daysAgo(2));
      await repository.rateCard(card, 'again', daysAgo(1));
      await repository.rateCard(other, 'good', daysAgo(1));

      const days = await repository.reviewDays('u1');

      expect(days).toEqual([
        { day: localDay(daysAgo(2)), reviews: 1, lapses: 0 },
        { day: localDay(daysAgo(1)), reviews: 2, lapses: 1 },
      ]);
    });

    it('buckets a late-evening review on the day the learner had', async () => {
      const { repository } = context;
      const deck = await repository.createDeck('u1', 'Spanish', 'es');
      const card = await repository.addCard('u1', deck, 'hablar', 'to speak');

      const lateTonight = new Date();
      lateTonight.setHours(23, 30, 0, 0);
      await repository.rateCard(card, 'good', lateTonight);

      const days = await repository.reviewDays('u1');
      // In any timezone east of UTC this is already tomorrow in UTC, which is
      // exactly the case UTC bucketing would get wrong.
      expect(days[0]?.day).toBe(localDay(lateTonight));
    });

    it('counts every rating, including the ones never pressed', async () => {
      const { repository } = context;
      const deck = await repository.createDeck('u1', 'Spanish', 'es');
      const card = await repository.addCard('u1', deck, 'hablar', 'to speak');

      await repository.rateCard(card, 'good');
      await repository.rateCard(card, 'again');
      await repository.rateCard(card, 'good');

      expect(await repository.ratingCounts('u1')).toEqual({
        again: 1,
        hard: 0,
        good: 2,
        easy: 0,
      });
    });

    it('keeps one user statistics out of another', async () => {
      const { repository } = context;
      const mine = await repository.createDeck('u1', 'Spanish', 'es');
      const theirs = await repository.createDeck('u2', 'Bosnian', 'bs');
      await repository.rateCard(await repository.addCard('u1', mine, 'hablar', 'to speak'), 'good');
      await repository.rateCard(await repository.addCard('u2', theirs, 'raditi', 'to work'), 'good');

      const days = await repository.reviewDays('u1');
      expect(days.reduce((total, day) => total + day.reviews, 0)).toBe(1);

      const stats = await repository.studyStats('u1');
      expect(stats.collection.total).toBe(1);
      expect(stats.decks.map((entry) => entry.deck.name)).toEqual(['Spanish']);
    });

    it('gathers history, ratings, forecast and collection in one call', async () => {
      const { repository } = context;
      const deck = await repository.createDeck('u1', 'Spanish', 'es');
      const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
      await repository.addCard('u1', deck, 'comer', 'to eat');
      await repository.rateCard(card, 'good');

      const stats = await repository.studyStats('u1');

      expect(stats.days).toHaveLength(1);
      expect(stats.ratings.good).toBe(1);
      expect(stats.collection.total).toBe(2);
      expect(stats.collection.decks).toBe(1);
      // One card is still new and therefore due; the rated one is a day out.
      expect(stats.collection.due).toBe(1);
      expect(stats.forecast).toHaveLength(14);
      expect(stats.forecast.reduce((total, entry) => total + entry.count, 0)).toBe(2);
      expect(stats.decks[0]?.progress.total).toBe(2);
    });

    it('reports nothing rather than failing for a user who has never studied', async () => {
      const { repository } = context;
      const stats = await repository.studyStats('nobody');

      expect(stats.days).toEqual([]);
      expect(stats.ratings).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
      expect(stats.collection.total).toBe(0);
      expect(stats.collection.mastery).toBe(0);
    });
  });
});
