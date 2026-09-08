import { createTestRepository } from './fakes/database';
import { collectionDayKey } from '@fluentflow/core';

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
    expect(row?.user_version).toBe(11);
  });

  it('round-trips a deck and its cards', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish Verbs', 'es');
    await repository.addCard('u1', deck, 'hablar', 'to speak');
    await repository.addCard('u1', deck, 'comer', 'to eat');

    const decks = await repository.listDecks('u1');
    expect(decks).toHaveLength(1);
    expect(decks[0]?.cardCount).toBe(2);
    expect(decks[0]?.newCardsPerDay).toBe(20);
    expect(decks[0]?.maxReviewsPerDay).toBe(50);

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

  it('persists the per-deck new-card limit and marks the deck pending', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');

    const updated = await repository.setNewCardsPerDay(deck, 40);

    expect(updated.newCardsPerDay).toBe(40);
    expect((await repository.getDeck(deck.id))?.newCardsPerDay).toBe(40);
    expect((await repository.pendingDecks('u1'))[0]?.newCardsPerDay).toBe(40);
  });

  it('persists study presentation settings and card context', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const configured = await repository.setStudyPresentation(deck, {
      reverseCards: true,
      showExamples: false,
      showGrammarNotes: false,
      showRelatedWords: false,
    });
    const card = await repository.addCard(
      'u1',
      configured,
      'hablar',
      'to speak',
      [],
      ['verb; regular -ar'],
      ['conversar', 'hablante'],
    );

    expect((await repository.getDeck(deck.id))?.reverseCards).toBe(true);
    expect((await repository.getDeck(deck.id))?.showExamples).toBe(false);
    expect((await repository.listCards(deck.id))[0]).toMatchObject({
      id: card.id,
      grammarNotes: ['verb; regular -ar'],
      relatedWords: ['conversar', 'hablante'],
    });
  });

  it('stamps a new card once and enforces the remaining daily allowance', async () => {
    const { repository } = context;
    const deck = await repository.setNewCardsPerDay(
      await repository.createDeck('u1', 'Spanish', 'es'),
      2,
    );
    const cards = await Promise.all([
      repository.addCard('u1', deck, 'hablar', 'to speak'),
      repository.addCard('u1', deck, 'comer', 'to eat'),
      repository.addCard('u1', deck, 'vivir', 'to live'),
    ]);
    const now = new Date();

    expect(await repository.dueCards(deck.id, now, 200, deck.newCardsPerDay)).toHaveLength(2);

    const first = await repository.rateCard(cards[0]!, 'good', now);
    expect(first.introducedAt).toBe(now.toISOString());
    const second = await repository.rateCard(first, 'good', new Date(now.getTime() + 1_000));
    expect(second.introducedAt).toBe(now.toISOString());
    expect(await repository.newCardsIntroducedToday(deck.id, now)).toBe(1);

    // The introduced card is still learning and is allowed through even though
    // only one untouched new card remains within the daily budget.
    const dueLearning = await repository.updateCard(second, {
      nextReview: new Date(now.getTime() - 1_000).toISOString(),
    });
    const queue = await repository.dueCards(deck.id, now, 200, deck.newCardsPerDay);
    expect(queue.map((card) => card.id)).toContain(dueLearning.id);
    expect(queue.filter((card) => card.phase === 'new')).toHaveLength(1);
  });

  it('resets the new-card allowance on the next local day and supports unlimited', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const cards = await Promise.all([
      repository.addCard('u1', deck, 'hablar', 'to speak'),
      repository.addCard('u1', deck, 'comer', 'to eat'),
      repository.addCard('u1', deck, 'vivir', 'to live'),
    ]);

    await repository.rateCard(cards[0]!, 'good', today);
    expect(await repository.newCardsIntroducedToday(deck.id, today)).toBe(1);
    expect(await repository.newCardsIntroducedToday(deck.id, tomorrow)).toBe(0);

    const unlimited = await repository.setNewCardsPerDay(deck, null);
    expect(await repository.dueCards(deck.id, new Date(), 200, unlimited.newCardsPerDay)).toHaveLength(3);
  });

  it('limits review cards separately from new cards', async () => {
    const { repository } = context;
    let deck = await repository.createDeck('u1', 'Spanish', 'es');
    deck = await repository.setMaxReviewsPerDay(deck, 1);
    const first = await repository.addCard('u1', deck, 'hablar', 'to speak');
    const second = await repository.addCard('u1', deck, 'comer', 'to eat');
    const now = new Date();
    await repository.updateCard(first, {
      phase: 'review', interval: 2, dueDay: collectionDayKey(now), nextReview: now.toISOString(), status: 'learning',
    });
    await repository.updateCard(second, {
      phase: 'review', interval: 2, dueDay: collectionDayKey(now), nextReview: now.toISOString(), status: 'learning',
    });

    const queue = await repository.studyQueue(deck.id, now, 20, 0, deck.maxReviewsPerDay);
    expect(queue.cards).toHaveLength(1);
    expect(queue.cards[0]?.phase).toBe('review');
  });

  it('does not spend the review allowance on a new-card introduction', async () => {
    const { repository } = context;
    let deck = await repository.createDeck('u1', 'Spanish', 'es');
    deck = await repository.setMaxReviewsPerDay(deck, 1);
    const newCard = await repository.addCard('u1', deck, 'hablar', 'to speak');
    const reviewCard = await repository.addCard('u1', deck, 'comer', 'to eat');
    const now = new Date();
    await repository.rateCard(newCard, 'good', now);
    await repository.updateCard(reviewCard, {
      phase: 'review', interval: 2, dueDay: collectionDayKey(now), nextReview: now.toISOString(), status: 'learning',
    });

    const queue = await repository.studyQueue(deck.id, now, 20, 20, deck.maxReviewsPerDay);
    expect(queue.cards.map((card) => card.id)).toContain(reviewCard.id);
  });

  it('buries and suspends cards out of the due queue', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    const now = new Date();

    const buried = await repository.buryCard(card, now);
    expect(await repository.dueCards(deck.id, now)).toHaveLength(0);
    await repository.unburyCard(buried);
    expect(await repository.dueCards(deck.id, now)).toHaveLength(1);

    await repository.suspendCard(card);
    expect(await repository.dueCards(deck.id, now)).toHaveLength(0);
  });

  it('undoes the latest pending review and removes its log entry', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    const reviewed = await repository.rateCard(card, 'easy');

    const restored = await repository.undoLastReview('u1');
    expect(restored?.id).toBe(card.id);
    expect(restored?.phase).toBe('new');
    expect(restored?.interval).toBe(0);
    expect(await repository.getCard(card.id)).toMatchObject({ phase: 'new', interval: 0 });
    expect(await repository.ratingCounts('u1')).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
    expect(reviewed.phase).toBe('review');
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
