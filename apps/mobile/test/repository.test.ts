import { createTestRepository } from './fakes/database';
import { FSRS_DEFAULT_PARAMETERS, collectionDayKey } from '@fluentflow/core';
import { Repository } from '../src/db/repository';
import { optimizeFsrsForAccount } from '../src/state/fsrs-optimize';
import { SCHEMA_VERSION } from '../src/db/schema';

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
    expect(row?.user_version).toBe(SCHEMA_VERSION);
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

  it('lists Spanish decks before Bosnian ones, each alphabetical', async () => {
    const { repository } = context;
    await repository.createDeck('u1', 'Bosnian', 'bs');
    await repository.createDeck('u1', 'Spanish Verbs', 'es');
    await repository.createDeck('u1', 'Animals', 'bs');
    await repository.createDeck('u1', 'Spanish', 'es');

    const decks = await repository.listDecks('u1');
    expect(decks.map((deck) => deck.name)).toEqual(['Spanish', 'Spanish Verbs', 'Animals', 'Bosnian']);
  });

  it('searches tags and persists bulk card changes', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish Verbs', 'es');
    const hablar = await repository.addCard('u1', deck, 'hablar', 'to speak', [], [], [], ['travel', 'verbs']);
    const comer = await repository.addCard('u1', deck, 'comer', 'to eat');

    expect((await repository.searchCards('u1', 'travel')).map((card) => card.id)).toEqual([hablar.id]);
    await repository.updateCards([hablar, comer], { suspended: true, tags: ['practice'] });
    const cards = await repository.listCards(deck.id);
    expect(cards.every((card) => card.suspended)).toBe(true);
    expect(cards.every((card) => card.tags?.includes('practice'))).toBe(true);
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

    // The deck runs FSRS, so graduation reads the interval off the card's
    // stability (2.3 days for two same-day Goods) rather than SM-2's flat day.
    expect(graduated.phase).toBe('review');
    expect(graduated.interval).toBe(2);
    expect(graduated.stability).toBeCloseTo(2.3065, 3);
    expect(graduated.lastReviewedAt).toBeDefined();
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

  it('keeps a finished daily queue finished when examples save from an old snapshot', async () => {
    const { repository, database } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    await repository.addCard('u1', deck, 'comer', 'to eat');
    const now = new Date();
    const learning = await repository.rateCard(card, 'good', now);
    const graduated = await repository.rateCard(learning, 'good', now);
    expect(await repository.dueCards(deck.id, now, 200, 1)).toHaveLength(0);

    await repository.updateCard(card, { examples: ['Ella habla español.'] });

    const reloaded = new Repository(database);
    expect(await reloaded.getCard(card.id)).toMatchObject({
      phase: graduated.phase,
      nextReview: graduated.nextReview,
      dueDay: graduated.dueDay,
      repetitions: graduated.repetitions,
      introducedAt: graduated.introducedAt,
      examples: ['Ella habla español.'],
    });
    expect(await reloaded.newCardsIntroducedToday(deck.id, now)).toBe(1);
    expect(await reloaded.dueCards(deck.id, now, 200, 1)).toHaveLength(0);
  });

  it('does not undo a review or resurrect a deleted card when a stale edit completes', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    const reviewed = await repository.rateCard(card, 'easy');
    await repository.deleteCard(reviewed);
    await repository.updateCard(card, { back: 'to talk' });
    const [stored] = await context.database.getAllAsync<{ deleted: number; repetitions: number; back: string }>(
      'SELECT deleted, repetitions, back FROM cards WHERE id = ?', card.id,
    );
    expect(stored).toMatchObject({ deleted: 1, repetitions: 1, back: 'to talk' });
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
    expect(await repository.dueCards(deck.id, tomorrow, 200, unlimited.newCardsPerDay)).toHaveLength(3);
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

  it('does not spend the review allowance on learning-step answers', async () => {
    const { repository } = context;
    let deck = await repository.createDeck('u1', 'Spanish', 'es');
    deck = await repository.setMaxReviewsPerDay(deck, 1);
    const learningCard = await repository.addCard('u1', deck, 'hablar', 'to speak');
    const dueReview = await repository.addCard('u1', deck, 'comer', 'to eat');
    const now = new Date();

    const learning = await repository.rateCard(learningCard, 'good', now);
    await repository.rateCard(learning, 'again', new Date(now.getTime() + 1_000));
    await repository.updateCard(dueReview, {
      phase: 'review', interval: 2, dueDay: collectionDayKey(now), nextReview: now.toISOString(), status: 'learning',
    });

    const queue = await repository.studyQueue(deck.id, now, 20, 20, deck.maxReviewsPerDay);
    expect(queue.cards.map((card) => card.id)).toContain(dueReview.id);
  });

  it('keeps favorite changes when undoing a review', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    const reviewed = await repository.rateCard(card, 'again');
    await repository.updateCard(reviewed, { starred: true });
    const restored = await repository.undoLastReview('u1');
    expect(restored?.starred).toBe(true);
    expect(restored?.repetitions).toBe(0);
    expect((await repository.getCard(card.id))?.starred).toBe(true);
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

  it('undoes a review even after it has synced', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    await repository.rateCard(card, 'easy');
    // The background push runs every few seconds; undo must still work after it.
    await repository.markSynced([], [], await repository.pendingReviewEvents('u1'));

    const restored = await repository.undoLastReview('u1');
    expect(restored?.id).toBe(card.id);
    expect(await repository.getCard(card.id)).toMatchObject({ phase: 'new', interval: 0, syncStatus: 'pending' });
    // The server already holds that event, so it stays — but cannot be undone twice.
    expect(await repository.undoLastReview('u1')).toBeNull();
  });

  it('leaves ease alone under FSRS but still counts lapses towards a leech', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    let card = await repository.addCard('u1', deck, 'hablar', 'to speak');

    card = await repository.rateCard(card, 'easy');
    const graduatedStability = card.stability!;
    for (let i = 0; i < 10; i++) {
      card = await repository.rateCard(card, 'again');
      expect(card.phase).toBe('relearning');
      card = await repository.rateCard(card, 'good');
    }

    expect(card.easeFactor).toBe(2.5);
    expect(card.stability).toBeLessThan(graduatedStability);
    expect(card.difficulty).toBeGreaterThan(9);
    expect(card.lapses).toBe(10);
    expect(card.leech).toBe(true);
  });

  it('keeps a deck\'s scheduler choice and defaults to FSRS at 90%', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    expect(deck.scheduler).toBeUndefined();

    await repository.setScheduling(deck, { scheduler: 'sm2', desiredRetention: 0.85 });
    const stored = await repository.getDeck(deck.id);
    expect(stored).toMatchObject({ scheduler: 'sm2', desiredRetention: 0.85, syncStatus: 'pending' });
  });

  it('converts studied SM-2 cards to FSRS once, without moving their due dates', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const sm2Deck = await repository.setScheduling(
      await repository.createDeck('u1', 'Old', 'es'),
      { scheduler: 'sm2' },
    );
    const fresh = await repository.addCard('u1', deck, 'nuevo', 'new');
    const imported = await repository.addCard('u1', deck, 'perro', 'dog');
    const kept = await repository.addCard('u1', sm2Deck, 'gato', 'cat');
    // An Anki import: SM-2 state and twelve answers this app never saw.
    const sm2State = {
      phase: 'review' as const,
      interval: 30,
      easeFactor: 2.3,
      repetitions: 12,
      status: 'mastered' as const,
      dueDay: '2030-01-15',
      nextReview: '2030-01-15T12:00:00.000Z',
    };
    await repository.updateCard(imported, sm2State);
    await repository.updateCard(kept, sm2State);

    expect(await repository.convertCardsToFsrs('u1')).toBe(1);

    const converted = await repository.getCard(imported.id);
    expect(converted?.stability).toBeCloseTo(30, 3);
    expect(converted?.difficulty).toBeGreaterThan(1);
    expect(converted).toMatchObject({ dueDay: '2030-01-15', interval: 30, easeFactor: 2.3, syncStatus: 'pending' });
    expect((await repository.getCard(kept.id))?.stability).toBeUndefined();
    expect((await repository.getCard(fresh.id))?.stability).toBeUndefined();

    // Nothing left to do on the next launch.
    expect(await repository.convertCardsToFsrs('u1')).toBe(0);
  });

  it('replays a card\'s logged history when converting it', async () => {
    const { repository } = context;
    const deck = await repository.setScheduling(
      await repository.createDeck('u1', 'Spanish', 'es'),
      { scheduler: 'sm2' },
    );
    let card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    card = await repository.rateCard(card, 'good');
    card = await repository.rateCard(card, 'good');
    expect(card.phase).toBe('review');
    // Reviewed under SM-2: no memory state to read yet.
    await repository.updateCard(card, { stability: undefined, difficulty: undefined });
    await repository.setScheduling((await repository.getDeck(deck.id))!, { scheduler: 'fsrs' });

    expect(await repository.convertCardsToFsrs('u1')).toBe(1);
    const converted = await repository.getCard(card.id);
    // Two same-day Goods: FSRS's initial Good stability, not SM-2's one day.
    expect(converted?.stability).toBeCloseTo(2.3065, 3);
  });

  it('hands FSRS only the cards whose whole history is logged', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    let logged = await repository.addCard('u1', deck, 'hablar', 'to speak');
    logged = await repository.rateCard(logged, 'good');
    logged = await repository.rateCard(logged, 'good');
    const imported = await repository.addCard('u1', deck, 'perro', 'dog');
    // Twelve answers in Anki, one here.
    await repository.rateCard(
      await repository.updateCard(imported, { phase: 'review', interval: 30, repetitions: 12 }),
      'good',
    );

    const histories = await repository.fsrsHistories('u1');
    expect(histories).toHaveLength(1);
    expect(histories[0]!.map((answer) => answer.rating)).toEqual(['good', 'good']);
  });

  it('does not fit FSRS to a history too short to trust', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    await repository.rateCard(await repository.addCard('u1', deck, 'hablar', 'to speak'), 'good');

    const outcome = await optimizeFsrsForAccount(repository, 'u1', { force: true });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'not-enough-reviews' });
    expect((await repository.getSettings('u1')).fsrs).toBeUndefined();
  });

  it('replays memory states under new FSRS weights without moving due dates', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    let card = await repository.addCard('u1', deck, 'hablar', 'to speak');
    card = await repository.rateCard(card, 'good');
    card = await repository.rateCard(card, 'good');
    const weights = [...FSRS_DEFAULT_PARAMETERS];
    weights[2] = 5; // a bigger head start for a first "good"

    expect(await repository.recomputeFsrsMemory('u1', weights)).toBe(1);
    const recomputed = await repository.getCard(card.id);
    expect(recomputed?.stability).toBeCloseTo(5, 3);
    expect(recomputed?.dueDay).toBe(card.dueDay);
    expect(await repository.recomputeFsrsMemory('u1', weights)).toBe(0);
  });

  it('schedules with the account\'s fitted FSRS weights', async () => {
    const { repository } = context;
    const deck = await repository.createDeck('u1', 'Spanish', 'es');
    const weights = [...FSRS_DEFAULT_PARAMETERS];
    weights[3] = 20;
    await repository.saveSettings('u1', { fsrs: { parameters: weights, reviews: 500 } });

    const card = await repository.rateCard(await repository.addCard('u1', deck, 'hablar', 'to speak'), 'easy');
    expect(card.stability).toBeCloseTo(20, 3);
  });

  it('drops the ease factor on lapses but never below the floor on an SM-2 deck', async () => {
    const { repository } = context;
    const deck = await repository.setScheduling(
      await repository.createDeck('u1', 'Spanish', 'es'),
      { scheduler: 'sm2' },
    );
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

  it('brings settings chosen before sign-in along, unless the account has its own', async () => {
    const { repository } = context;
    await repository.saveSettings('local', { theme: 'dark' });
    await repository.claimLocalData('local', 'real-user');
    expect(await repository.getSettings('real-user')).toMatchObject({ theme: { value: 'dark' } });
    expect(await repository.getSettings('local')).toEqual({});

    await repository.saveSettings('local', { theme: 'light' });
    await repository.claimLocalData('local', 'real-user');
    expect(await repository.getSettings('real-user')).toMatchObject({ theme: { value: 'dark' } });
  });

  it('keeps settings queued until the server has every choice made here', async () => {
    const { repository } = context;
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 10, minute));
    expect(await repository.getSettings('u1')).toEqual({});
    await repository.saveSettings('u1', { dailyGoal: 40 }, at(0));
    await repository.saveSettings('u1', { theme: 'dark' }, at(1));
    expect(await repository.countPending('u1')).toBe(1);
    const sent = await repository.pendingSettings('u1');
    expect(sent).toEqual({
      dailyGoal: { value: 40, updatedAt: at(0).toISOString() },
      theme: { value: 'dark', updatedAt: at(1).toISOString() },
    });

    // The server answers with an older goal from elsewhere and our theme
    // missing (sent before the theme was chosen): the theme stays queued.
    const partial = await repository.applyServerSettings('u1', {
      dailyGoal: { value: 10, updatedAt: at(-5).toISOString() },
      uiLanguage: { value: 'bs', updatedAt: at(-5).toISOString() },
    });
    expect(partial.changed).toBe(true);
    expect(await repository.getSettings('u1')).toMatchObject({
      dailyGoal: { value: 40 },
      theme: { value: 'dark' },
      uiLanguage: { value: 'bs' },
    });
    expect(await repository.countPending('u1')).toBe(1);

    // Once the server holds everything, nothing is pending.
    const merged = await repository.getSettings('u1');
    const done = await repository.applyServerSettings('u1', merged);
    expect(done.changed).toBe(false);
    expect(await repository.countPending('u1')).toBe(0);
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
      // One card is still new; Future Due only projects the day-level review
      // card, which is scheduled beyond this forecast's current day.
      expect(stats.collection.due).toBe(1);
      expect(stats.forecast).toHaveLength(14);
      expect(stats.forecast.reduce((total, entry) => total + entry.count, 0)).toBe(0);
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
