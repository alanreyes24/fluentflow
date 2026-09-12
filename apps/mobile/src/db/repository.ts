import type { SQLiteDatabase } from 'expo-sqlite';
import {
  EMPTY_RATING_COUNTS,
  RATING_NAMES,
  addCollectionDays,
  buildStudyQueue,
  collectionDayKey,
  collectionDayStart,
  collectionSummary,
  createCard,
  createDeck,
  deckProgress,
  dueCards,
  forecast,
  isInterdayLearningCard,
  recomputeCardCounts,
  reviewCard,
  schedulingStateFor,
  softDelete,
  touch,
  uuid,
  type Card,
  type CollectionSummary,
  type DayCount,
  type Deck,
  type DeckProgress,
  type MissedCard,
  type RatingCounts,
  type RatingName,
  type ReviewEvent,
  type StudyQueue,
  type StudyDay,
  type TargetLanguage,
} from '@fluentflow/core';

/**
 * All local reads and writes.
 *
 * Two rules hold throughout:
 *
 *  1. Every mutation stamps `lastModified` and sets `syncStatus = 'pending'`,
 *     via the core `touch` helper. A write that skips this is invisible to the
 *     sync engine and silently never leaves the device.
 *  2. Deletes are soft. A row removed outright would reappear on the next pull,
 *     because the server cannot tell "deleted here" from "not yet uploaded".
 */

export interface ExampleCacheEntry {
  examples: string[];
  source: string;
  createdAt: string;
}

/** Everything the statistics screen needs, gathered in one pass. */
export interface StudyStats {
  /** Every day with at least one review, oldest first. */
  days: StudyDay[];
  ratings: RatingCounts;
  forecast: DayCount[];
  collection: CollectionSummary;
  cardsLearnedThisWeek: number;
  mostMissedCards: MissedCard[];
  decks: { deck: Deck; progress: DeckProgress }[];
}

export class Repository {
  constructor(private readonly db: SQLiteDatabase) {}

  // --- decks ---------------------------------------------------------------

  async listDecks(userId: string): Promise<Deck[]> {
    const rows = await this.db.getAllAsync<DeckRow>(
      'SELECT * FROM decks WHERE userId = ? AND deleted = 0 ORDER BY name COLLATE NOCASE',
      userId,
    );
    return rows.map(toDeck);
  }

  async getDeck(id: string): Promise<Deck | null> {
    const row = await this.db.getFirstAsync<DeckRow>('SELECT * FROM decks WHERE id = ?', id);
    return row ? toDeck(row) : null;
  }

  async createDeck(userId: string, name: string, language: TargetLanguage): Promise<Deck> {
    const deck = createDeck({ userId, name, language });
    await this.saveDecks([deck]);
    return deck;
  }

  async renameDeck(deck: Deck, name: string): Promise<Deck> {
    const updated = touch({ ...deck, name: name.trim() });
    await this.saveDecks([updated]);
    return updated;
  }

  async setNewCardsPerDay(deck: Deck, newCardsPerDay: number | null): Promise<Deck> {
    const updated = touch({ ...deck, newCardsPerDay });
    await this.saveDecks([updated]);
    return updated;
  }

  async setMaxReviewsPerDay(deck: Deck, maxReviewsPerDay: number | null): Promise<Deck> {
    const updated = touch({ ...deck, maxReviewsPerDay });
    await this.saveDecks([updated]);
    return updated;
  }

  async setStudyPresentation(
    deck: Deck,
    changes: Partial<Pick<Deck, 'reverseCards' | 'showExamples' | 'showGrammarNotes' | 'showRelatedWords'>>,
  ): Promise<Deck> {
    const updated = touch({ ...deck, ...changes });
    await this.saveDecks([updated]);
    return updated;
  }

  async deleteDeck(deck: Deck): Promise<void> {
    const cards = await this.listCards(deck.id);
    await this.db.withTransactionAsync(async () => {
      await this.writeDecks([softDelete(deck)]);
      // Cards are tombstoned individually so the deletion reaches other devices
      // even if they never learn the deck itself is gone.
      await this.writeCards(cards.map((card) => softDelete(card)));
    });
  }

  /** Write decks exactly as given, without re-stamping them. */
  async saveDecks(decks: Deck[]): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.writeDecks(decks);
    });
  }

  // --- cards ---------------------------------------------------------------

  async listCards(deckId: string): Promise<Card[]> {
    const rows = await this.db.getAllAsync<CardRow>(
      'SELECT * FROM cards WHERE deckId = ? AND deleted = 0 ORDER BY rowid',
      deckId,
    );
    return rows.map(toCard);
  }

  async listAllCards(userId?: string): Promise<Card[]> {
    const rows = userId
      ? await this.db.getAllAsync<CardRow>(
          'SELECT * FROM cards WHERE userId = ? AND deleted = 0',
          userId,
        )
      : await this.db.getAllAsync<CardRow>('SELECT * FROM cards WHERE deleted = 0');
    return rows.map(toCard);
  }

  /**
   * Find cards by their content or learner-defined tags, without pulling
   * deleted records into the library view. SQLite's case-insensitive LIKE is
   * deliberately used here: users expect `hablar` and `Hablar` to match.
   */
  async searchCards(userId: string, query: string): Promise<Card[]> {
    const term = query.trim();
    if (!term) return this.listAllCards(userId);
    const like = `%${term}%`;
    const rows = await this.db.getAllAsync<CardRow>(
      `SELECT * FROM cards
       WHERE userId = ? AND deleted = 0
         AND (front LIKE ? COLLATE NOCASE OR back LIKE ? COLLATE NOCASE OR tags LIKE ? COLLATE NOCASE)
       ORDER BY front COLLATE NOCASE, rowid`,
      userId,
      like,
      like,
      like,
    );
    return rows.map(toCard);
  }

  async getCard(id: string): Promise<Card | null> {
    const row = await this.db.getFirstAsync<CardRow>('SELECT * FROM cards WHERE id = ?', id);
    return row ? toCard(row) : null;
  }

  /** Find a live card by its front, without treating capitalization as a duplicate. */
  async findCardByFront(deckId: string, front: string): Promise<Card | null> {
    const row = await this.db.getFirstAsync<CardRow>(
      `SELECT * FROM cards
       WHERE deckId = ? AND deleted = 0 AND lower(trim(front)) = lower(trim(?))
       ORDER BY rowid
       LIMIT 1`,
      deckId,
      front,
    );
    return row ? toCard(row) : null;
  }

  /**
   * The study queue for a deck.
   *
   * `limit` exists so a deck with 10 000 cards does not deserialise every one
   * of them to show the next card.
   */
  async dueCards(
    deckId: string,
    now: Date = new Date(),
    limit = 200,
    newCardsPerDay: number | null = 20,
    maxReviewsPerDay: number | null = 50,
  ): Promise<Card[]> {
    return (await this.studyQueue(deckId, now, limit, newCardsPerDay, maxReviewsPerDay)).cards;
  }

  /** Gather learning, review, and new cards in Anki's normal queue order. */
  async studyQueue(
    deckId: string,
    now: Date = new Date(),
    limit = 200,
    newCardsPerDay: number | null = 20,
    maxReviewsPerDay: number | null = 50,
  ): Promise<StudyQueue> {
    const candidateLimit = Math.max(limit * 4, 1000);
    const [learningRows, reviewRows, newRows, introduced, reviewed] = await Promise.all([
      // Learning cards are transient and all of them matter to completion:
      // even a step scheduled beyond today's 4 a.m. boundary means the
      // learning cycle is not finished yet.
      this.db.getAllAsync<CardRow>(
        `SELECT * FROM cards
         WHERE deckId = ? AND deleted = 0 AND phase IN ('learning', 'relearning')
         ORDER BY nextReview, rowid`,
        deckId,
      ),
      this.db.getAllAsync<CardRow>(
        `SELECT * FROM cards
         WHERE deckId = ? AND deleted = 0 AND phase = 'review'
         ORDER BY nextReview, rowid
         LIMIT ?`,
        deckId,
        candidateLimit,
      ),
      this.db.getAllAsync<CardRow>(
        `SELECT * FROM cards
         WHERE deckId = ? AND deleted = 0 AND phase = 'new'
         ORDER BY rowid
         LIMIT ?`,
        deckId,
        candidateLimit,
      ),
      this.newCardsIntroducedToday(deckId, now),
      this.reviewsAnsweredTodayForDeck(deckId, now),
    ]);
    return buildStudyQueue([...learningRows, ...reviewRows, ...newRows].map(toCard), {
      now,
      limit,
      newCardsPerDay,
      maxReviewsPerDay,
      newCardsIntroducedToday: introduced,
      reviewsAnsweredToday: reviewed,
    });
  }

  /** Cards that are not due yet, for the "study ahead" path. */
  async upcomingCards(deckId: string, now: Date = new Date(), limit = 50): Promise<Card[]> {
    const rows = await this.db.getAllAsync<CardRow>(
      `SELECT * FROM cards
       WHERE deckId = ? AND deleted = 0 AND suspended = 0
         AND (buriedUntil IS NULL OR buriedUntil <= ?)
         AND nextReview > ?
       ORDER BY nextReview
       LIMIT ?`,
      deckId,
      collectionDayKey(now),
      now.toISOString(),
      limit,
    );
    return rows.map(toCard);
  }

  async addCard(
    userId: string,
    deck: Deck,
    front: string,
    back: string,
    examples: string[] = [],
    grammarNotes: string[] = [],
    relatedWords: string[] = [],
    tags: string[] = [],
  ): Promise<Card> {
    const card = createCard({
      userId,
      deckId: deck.id,
      front,
      back,
      language: deck.language,
      examples,
      grammarNotes,
      relatedWords,
      tags,
    });
    await this.saveCards([card]);
    await this.refreshDeckCount(deck.id);
    return card;
  }

  async updateCard(card: Card, changes: Partial<Card>): Promise<Card> {
    // Async example generation and editors can hold a pre-review snapshot.
    // Patch only the requested columns in one statement: writing that snapshot
    // back would reset the schedule and the day's new-card allowance.
    const patch = touch({ ...card, ...changes });
    const columns = CARD_UPDATE_COLUMNS.filter((key) =>
      key === 'lastModified' || key === 'syncStatus' || Object.prototype.hasOwnProperty.call(changes, key),
    );
    await this.db.runAsync(
      `UPDATE cards SET ${columns.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`,
      ...columns.map((key) => {
        const value = patch[key];
        if (key === 'examples' || key === 'grammarNotes' || key === 'relatedWords') {
          return JSON.stringify(value ?? []);
        }
        if (key === 'leech' || key === 'suspended' || key === 'deleted') return value ? 1 : 0;
        if (Array.isArray(value)) return JSON.stringify(value);
        if (typeof value === 'boolean') return value ? 1 : 0;
        return value ?? null;
      }),
      card.id,
    );
    const updated = await this.getCard(card.id);
    if (!updated) throw new Error(`Card ${card.id} no longer exists`);
    return updated;
  }

  async deleteCard(card: Card): Promise<void> {
    await this.saveCards([softDelete(card)]);
    await this.refreshDeckCount(card.deckId);
  }

  /** Apply a review: update scheduling, and record it for the stats screen. */
  async rateCard(card: Card, rating: RatingName, now: Date = new Date()): Promise<Card> {
    const reviewed = reviewCard(card, rating, { now });
    const introducedAt =
      schedulingStateFor(card).phase === 'new' && !card.introducedAt
        ? now.toISOString()
        : card.introducedAt;
    const withIntroduction = introducedAt ? { ...reviewed, introducedAt } : reviewed;
    await this.db.withTransactionAsync(async () => {
      await this.writeCards([withIntroduction]);
      await this.db.runAsync(
        `INSERT INTO review_log (eventId, cardId, userId, rating, interval, easeFactor, reviewedAt, syncStatus, previousState)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        uuid(),
        withIntroduction.id,
        withIntroduction.userId,
        rating,
        withIntroduction.interval,
        withIntroduction.easeFactor,
        now.toISOString(),
        JSON.stringify(card),
      );
    });
    return withIntroduction;
  }

  async newCardsIntroducedToday(deckId: string, now: Date = new Date()): Promise<number> {
    const start = collectionDayStart(now);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const row = await this.db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM cards
       WHERE deckId = ? AND deleted = 0 AND introducedAt >= ? AND introducedAt < ?`,
      deckId,
      start.toISOString(),
      end.toISOString(),
    );
    return Number(row?.count ?? 0);
  }

  async reviewsAnsweredTodayForDeck(deckId: string, now: Date = new Date()): Promise<number> {
    const start = collectionDayStart(now);
    const rows = await this.db.getAllAsync<ReviewCountRow>(
      `SELECT previousState, reviewedAt FROM review_log
       WHERE cardId IN (SELECT id FROM cards WHERE deckId = ?)
         AND reviewedAt >= ? AND reviewedAt <= ?`,
      deckId,
      start.toISOString(),
      now.toISOString(),
    );
    // Only an answer given while the card is in review consumes Anki's daily
    // review-card allowance. New introductions and their subsequent learning
    // or relearning steps have their own queues. Older synced events have no
    // snapshot, so count those conservatively as reviews.
    return rows.filter((row) => {
      if (!row.previousState) return true;
      const previous = parseCardSnapshot(row.previousState);
      return previous
        ? schedulingStateFor(previous).phase === 'review' ||
            isInterdayLearningCard(previous, new Date(row.reviewedAt))
        : true;
    }).length;
  }

  async buryCard(card: Card, now: Date = new Date()): Promise<Card> {
    const buried = touch({ ...card, buriedUntil: addCollectionDays(collectionDayKey(now), 1) });
    await this.saveCards([buried]);
    return buried;
  }

  async unburyCard(card: Card): Promise<Card> {
    const updated = touch({ ...card, buriedUntil: undefined });
    await this.saveCards([updated]);
    return updated;
  }

  async suspendCard(card: Card): Promise<Card> {
    const updated = touch({ ...card, suspended: true });
    await this.saveCards([updated]);
    return updated;
  }

  async unsuspendCard(card: Card): Promise<Card> {
    const updated = touch({ ...card, suspended: false });
    await this.saveCards([updated]);
    return updated;
  }

  /** Apply one safe content/status patch to several selected cards. */
  async updateCards(cards: Card[], changes: Partial<Card>): Promise<Card[]> {
    if (cards.length === 0) return [];
    const updated: Card[] = [];
    for (const card of cards) updated.push(await this.updateCard(card, changes));
    return updated;
  }

  /** Undo the latest review while its upload is still pending. */
  async undoLastReview(userId: string, now: Date = new Date()): Promise<Card | null> {
    const row = await this.db.getFirstAsync<UndoRow>(
      `SELECT id, cardId, syncStatus, previousState FROM review_log
       WHERE userId = ? AND previousState IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      userId,
    );
    if (!row || row.syncStatus !== 'pending') return null;
    const previous = parseCardSnapshot(row.previousState);
    if (!previous) return null;
    const current = await this.getCard(previous.id);
    const restored = touch({ ...previous, starred: current?.starred ?? false, suspended: previous.suspended ?? false }, now);
    await this.db.withTransactionAsync(async () => {
      await this.writeCards([restored]);
      await this.db.runAsync("DELETE FROM review_log WHERE id = ? AND syncStatus = 'pending'", row.id);
    });
    return restored;
  }

  async saveCards(cards: Card[]): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.writeCards(cards);
    });
  }

  // --- import --------------------------------------------------------------

  /** Store an imported deck and its cards as one unit. */
  async importDecks(decks: Deck[], cards: Card[]): Promise<void> {
    const withCounts = recomputeCardCounts(decks, cards);
    await this.db.withTransactionAsync(async () => {
      await this.writeDecks(withCounts);
      await this.writeCards(cards);
    });
  }

  // --- progress ------------------------------------------------------------

  async deckProgress(deckId: string, now: Date = new Date()): Promise<DeckProgress> {
    const cards = await this.listCards(deckId);
    return deckProgress(cards, now);
  }

  async reviewsSince(userId: string, since: Date): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM review_log WHERE userId = ? AND reviewedAt >= ?',
      userId,
      since.toISOString(),
    );
    return row?.count ?? 0;
  }

  // --- statistics ----------------------------------------------------------

  /**
   * Review activity, one row per day the learner actually studied.
   *
   * Grouped rather than fetched row by row: a year of daily study is a few
   * hundred rows this way and tens of thousands the other, and nothing above
   * this needs an individual review.
   */
  async reviewDays(userId: string, now: Date = new Date()): Promise<StudyDay[]> {
    const rows = await this.db.getAllAsync<{ day: string; reviews: number; lapses: number }>(
      `SELECT date(reviewedAt, ?2) AS day,
              COUNT(*) AS reviews,
              SUM(CASE WHEN rating = 'again' THEN 1 ELSE 0 END) AS lapses
       FROM review_log
       WHERE userId = ?1
       GROUP BY day
       ORDER BY day`,
      userId,
      collectionDayModifier(now),
    );
    return rows.map((row) => ({ day: row.day, reviews: row.reviews, lapses: row.lapses ?? 0 }));
  }

  /** How each button was pressed, for the ratings breakdown. */
  async ratingCounts(userId: string, since?: Date): Promise<RatingCounts> {
    const rows = since
      ? await this.db.getAllAsync<{ rating: string; count: number }>(
          `SELECT rating, COUNT(*) AS count FROM review_log
           WHERE userId = ? AND reviewedAt >= ? GROUP BY rating`,
          userId,
          since.toISOString(),
        )
      : await this.db.getAllAsync<{ rating: string; count: number }>(
          'SELECT rating, COUNT(*) AS count FROM review_log WHERE userId = ? GROUP BY rating',
          userId,
        );

    const counts: RatingCounts = { ...EMPTY_RATING_COUNTS };
    for (const row of rows) {
      const rating = RATING_NAMES.find((name) => name === row.rating);
      if (rating) counts[rating] = row.count;
    }
    return counts;
  }

  /** Cards that graduated from learning during the trailing seven days. */
  async cardsLearnedSince(userId: string, since: Date): Promise<number> {
    const rows = await this.db.getAllAsync<{ cardId: string; interval: number; previousState: string | null }>(
      `SELECT cardId, interval, previousState FROM review_log
       WHERE userId = ? AND reviewedAt >= ? AND interval >= 1`,
      userId,
      since.toISOString(),
    );
    const learned = new Set<string>();
    for (const row of rows) {
      const previous = row.previousState ? parseCardSnapshot(row.previousState) : null;
      const phase = previous ? schedulingStateFor(previous).phase : null;
      if (phase === 'new' || phase === 'learning') learned.add(row.cardId);
    }
    return learned.size;
  }

  /** Cards with the most Again answers, used to focus review effort. */
  async mostMissedCards(userId: string, limit = 5): Promise<MissedCard[]> {
    const rows = await this.db.getAllAsync<{ cardId: string; front: string; misses: number }>(
      `SELECT r.cardId, c.front, COUNT(*) AS misses
       FROM review_log r
       JOIN cards c ON c.id = r.cardId
       WHERE r.userId = ? AND r.rating = 'again' AND c.deleted = 0
       GROUP BY r.cardId, c.front
       ORDER BY misses DESC, c.front COLLATE NOCASE
       LIMIT ?`,
      userId,
      limit,
    );
    return rows.map((row) => ({ cardId: row.cardId, front: row.front, misses: row.misses }));
  }

  /** Review events waiting to be copied to the shared account. */
  async pendingReviewEvents(userId: string): Promise<ReviewEvent[]> {
    const rows = await this.db.getAllAsync<ReviewEventRow>(
      "SELECT eventId, cardId, userId, rating, interval, easeFactor, reviewedAt, syncStatus FROM review_log WHERE userId = ? AND syncStatus = 'pending'",
      userId,
    );
    return rows.map(toReviewEvent);
  }

  /** All local review events, used for idempotent union with remote history. */
  async listReviewEvents(userId: string): Promise<ReviewEvent[]> {
    const rows = await this.db.getAllAsync<ReviewEventRow>(
      'SELECT eventId, cardId, userId, rating, interval, easeFactor, reviewedAt, syncStatus FROM review_log WHERE userId = ?',
      userId,
    );
    return rows.map(toReviewEvent);
  }

  /**
   * Everything the statistics screen reads, in one pass.
   *
   * The windowing is left to the caller: `days` is the whole history, and the
   * core helpers slice it. Deciding here would mean a second round trip every
   * time the range selector moved.
   */
  async studyStats(userId: string, now: Date = new Date(), horizonDays = 14): Promise<StudyStats> {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 6);
    const [days, ratings, cards, decks, cardsLearnedThisWeek, mostMissedCards] = await Promise.all([
      this.reviewDays(userId, now),
      this.ratingCounts(userId),
      this.listAllCards(userId),
      this.listDecks(userId),
      this.cardsLearnedSince(userId, weekStart),
      this.mostMissedCards(userId),
    ]);

    return {
      days,
      ratings,
      forecast: forecast(cards, { days: horizonDays, now }),
      collection: collectionSummary(cards, decks.length, now),
      cardsLearnedThisWeek,
      mostMissedCards,
      decks: decks.map((deck) => ({
        deck,
        progress: deckProgress(
          cards.filter((card) => card.deckId === deck.id),
          now,
        ),
      })),
    };
  }

  /** Recalculate a deck's card count from the cards actually present. */
  async refreshDeckCount(deckId: string): Promise<void> {
    const deck = await this.getDeck(deckId);
    if (!deck) return;
    const row = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM cards WHERE deckId = ? AND deleted = 0',
      deckId,
    );
    const cardCount = row?.count ?? 0;
    if (cardCount === deck.cardCount) return;
    // The count is derived, so this is not a user edit and must not create a
    // sync conflict — the timestamp is left alone deliberately.
    await this.db.runAsync('UPDATE decks SET cardCount = ? WHERE id = ?', cardCount, deckId);
  }

  // --- example cache -------------------------------------------------------

  async getCachedExamples(word: string, language: string): Promise<ExampleCacheEntry | null> {
    const row = await this.db.getFirstAsync<{ examples: string; source: string; createdAt: string }>(
      'SELECT examples, source, createdAt FROM example_cache WHERE word = ? AND language = ?',
      normaliseWord(word),
      language,
    );
    if (!row) return null;
    return { examples: parseJsonArray(row.examples), source: row.source, createdAt: row.createdAt };
  }

  async cacheExamples(
    word: string,
    language: string,
    examples: string[],
    source: string,
  ): Promise<void> {
    // Generic fallback sentences are not worth caching: they cost nothing to
    // regenerate, and caching them would stop the real model from ever getting
    // a second chance once it becomes available.
    if (source === 'fallback' || examples.length === 0) return;
    await this.db.runAsync(
      `INSERT INTO example_cache (word, language, examples, source, createdAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (word, language) DO UPDATE SET
         examples = excluded.examples,
         source = excluded.source,
         createdAt = excluded.createdAt`,
      normaliseWord(word),
      language,
      JSON.stringify(examples),
      source,
      new Date().toISOString(),
    );
  }

  async clearExampleCache(): Promise<void> {
    await this.db.runAsync('DELETE FROM example_cache');
  }

  // --- sync ----------------------------------------------------------------

  async pendingDecks(userId: string): Promise<Deck[]> {
    const rows = await this.db.getAllAsync<DeckRow>(
      "SELECT * FROM decks WHERE userId = ? AND syncStatus = 'pending'",
      userId,
    );
    return rows.map(toDeck);
  }

  async pendingCards(userId: string): Promise<Card[]> {
    const rows = await this.db.getAllAsync<CardRow>(
      "SELECT * FROM cards WHERE userId = ? AND syncStatus = 'pending'",
      userId,
    );
    return rows.map(toCard);
  }

  async countPending(userId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      `SELECT
         (SELECT COUNT(*) FROM decks WHERE userId = ?1 AND syncStatus = 'pending') +
         (SELECT COUNT(*) FROM cards WHERE userId = ?1 AND syncStatus = 'pending') +
         (SELECT COUNT(*) FROM review_log WHERE userId = ?1 AND syncStatus = 'pending') AS count`,
      userId,
    );
    return row?.count ?? 0;
  }

  /**
   * Mark records as uploaded — but only if they have not changed since the
   * upload started. Comparing `lastModified` is what stops a review made during
   * the round trip from being marked synced and then never sent.
   */
  async markSynced(decks: Deck[], cards: Card[], reviewEvents: ReviewEvent[] = []): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const deck of decks) {
        await this.db.runAsync(
          "UPDATE decks SET syncStatus = 'synced' WHERE id = ? AND lastModified = ?",
          deck.id,
          deck.lastModified,
        );
      }
      for (const card of cards) {
        await this.db.runAsync(
          "UPDATE cards SET syncStatus = 'synced' WHERE id = ? AND lastModified = ?",
          card.id,
          card.lastModified,
        );
      }
      for (const event of reviewEvents) {
        await this.db.runAsync(
          "UPDATE review_log SET syncStatus = 'synced' WHERE eventId = ? AND syncStatus = 'pending'",
          event.eventId,
        );
      }
    });
  }

  /** Apply records that arrived from the server, already merged by the caller. */
  async applyRemote(
    decks: Deck[],
    cards: Card[],
    reviewEvents: ReviewEvent[] = [],
  ): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.writeDecks(decks.map((deck) => ({ ...deck, syncStatus: 'synced' as const })));
      await this.writeCards(cards.map((card) => ({ ...card, syncStatus: 'synced' as const })));
      for (const event of reviewEvents) {
        await this.db.runAsync(
          `INSERT INTO review_log (eventId, cardId, userId, rating, interval, easeFactor, reviewedAt, syncStatus)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'synced')
           ON CONFLICT (eventId) DO UPDATE SET
             cardId = excluded.cardId,
             userId = excluded.userId,
             rating = excluded.rating,
             interval = excluded.interval,
             easeFactor = excluded.easeFactor,
             reviewedAt = excluded.reviewedAt,
             syncStatus = 'synced'`,
          event.eventId,
          event.cardId,
          event.userId,
          event.rating,
          event.interval,
          event.easeFactor,
          event.reviewedAt,
        );
      }
    });
    for (const deckId of new Set(cards.map((card) => card.deckId))) {
      await this.refreshDeckCount(deckId);
    }
  }

  async getSyncMeta(userId: string): Promise<{ lastPulledAt?: string; lastPushedAt?: string }> {
    const row = await this.db.getFirstAsync<{ lastPulledAt: string | null; lastPushedAt: string | null }>(
      'SELECT lastPulledAt, lastPushedAt FROM sync_meta WHERE userId = ?',
      userId,
    );
    return {
      lastPulledAt: row?.lastPulledAt ?? undefined,
      lastPushedAt: row?.lastPushedAt ?? undefined,
    };
  }

  async setSyncMeta(userId: string, meta: { lastPulledAt?: string; lastPushedAt?: string }): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO sync_meta (userId, lastPulledAt, lastPushedAt)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (userId) DO UPDATE SET
         lastPulledAt = COALESCE(?2, lastPulledAt),
         lastPushedAt = COALESCE(?3, lastPushedAt)`,
      userId,
      meta.lastPulledAt ?? null,
      meta.lastPushedAt ?? null,
    );
  }

  /**
   * Re-home anonymous local data onto a real account after sign-in, so nothing
   * studied before signing in is stranded.
   */
  async claimLocalData(fromUserId: string, toUserId: string): Promise<number> {
    const now = new Date().toISOString();
    let moved = 0;
    await this.db.withTransactionAsync(async () => {
      const decks = await this.db.runAsync(
        "UPDATE decks SET userId = ?, lastModified = ?, syncStatus = 'pending' WHERE userId = ?",
        toUserId,
        now,
        fromUserId,
      );
      const cards = await this.db.runAsync(
        "UPDATE cards SET userId = ?, lastModified = ?, syncStatus = 'pending' WHERE userId = ?",
        toUserId,
        now,
        fromUserId,
      );
      const reviews = await this.db.runAsync(
        "UPDATE review_log SET userId = ?, syncStatus = 'pending' WHERE userId = ?",
        toUserId,
        fromUserId,
      );
      moved = decks.changes + cards.changes + reviews.changes;
    });
    return moved;
  }

  // --- internals -----------------------------------------------------------

  private async writeDecks(decks: Deck[]): Promise<void> {
    for (const deck of decks) {
      await this.db.runAsync(
        `INSERT INTO decks (id, userId, name, language, newCardsPerDay, maxReviewsPerDay,
                            reverseCards, showExamples, showGrammarNotes, showRelatedWords,
                            cardCount, createdAt, lastModified, syncStatus, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           userId = excluded.userId,
           name = excluded.name,
           language = excluded.language,
           newCardsPerDay = excluded.newCardsPerDay,
           maxReviewsPerDay = excluded.maxReviewsPerDay,
           reverseCards = excluded.reverseCards,
           showExamples = excluded.showExamples,
           showGrammarNotes = excluded.showGrammarNotes,
           showRelatedWords = excluded.showRelatedWords,
           cardCount = excluded.cardCount,
           lastModified = excluded.lastModified,
           syncStatus = excluded.syncStatus,
           deleted = excluded.deleted`,
        deck.id,
        deck.userId,
        deck.name,
        deck.language,
        deck.newCardsPerDay === undefined ? 20 : deck.newCardsPerDay,
        deck.maxReviewsPerDay === undefined ? 50 : deck.maxReviewsPerDay,
        deck.reverseCards ? 1 : 0,
        deck.showExamples !== false ? 1 : 0,
        deck.showGrammarNotes !== false ? 1 : 0,
        deck.showRelatedWords !== false ? 1 : 0,
        deck.cardCount,
        deck.createdAt,
        deck.lastModified,
        deck.syncStatus,
        deck.deleted ? 1 : 0,
      );
    }
  }

  private async writeCards(cards: Card[]): Promise<void> {
    for (const card of cards) {
      await this.db.runAsync(
        `INSERT INTO cards (id, deckId, userId, front, back, language, examples, grammarNotes, relatedWords, interval,
                            easeFactor, repetitions, phase, lapses, learningStep, leech,
                            introducedAt, dueDay, buriedUntil, suspended, nextReview, status, lastModified, syncStatus, deleted, starred, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           deckId = excluded.deckId,
           userId = excluded.userId,
           front = excluded.front,
           back = excluded.back,
           language = excluded.language,
           examples = excluded.examples,
           grammarNotes = excluded.grammarNotes,
           relatedWords = excluded.relatedWords,
           interval = excluded.interval,
           easeFactor = excluded.easeFactor,
           repetitions = excluded.repetitions,
           phase = excluded.phase,
           lapses = excluded.lapses,
           learningStep = excluded.learningStep,
           leech = excluded.leech,
           introducedAt = excluded.introducedAt,
           dueDay = excluded.dueDay,
           buriedUntil = excluded.buriedUntil,
           suspended = excluded.suspended,
           nextReview = excluded.nextReview,
           status = excluded.status,
           lastModified = excluded.lastModified,
           syncStatus = excluded.syncStatus,
           deleted = excluded.deleted,
           starred = excluded.starred,
           tags = excluded.tags`,
        card.id,
        card.deckId,
        card.userId,
        card.front,
        card.back,
        card.language,
        JSON.stringify(card.examples ?? []),
        JSON.stringify(card.grammarNotes ?? []),
        JSON.stringify(card.relatedWords ?? []),
        card.interval,
        card.easeFactor,
        card.repetitions,
        card.phase ?? 'new',
        card.lapses ?? 0,
        card.learningStep ?? 0,
        card.leech ? 1 : 0,
        card.introducedAt ?? null,
        card.dueDay ?? null,
        card.buriedUntil ?? null,
        card.suspended ? 1 : 0,
        card.nextReview,
        card.status,
        card.lastModified,
        card.syncStatus,
        card.deleted ? 1 : 0,
        card.starred ? 1 : 0,
        JSON.stringify(card.tags ?? []),
      );
    }
  }
}

// --- row mapping -----------------------------------------------------------

/** Fixed SQL identifiers; callers can only patch known card columns. */
const CARD_UPDATE_COLUMNS = [
  'deckId', 'userId', 'front', 'back', 'language', 'examples', 'grammarNotes',
  'relatedWords', 'interval', 'easeFactor', 'repetitions', 'phase', 'lapses',
  'learningStep', 'leech', 'introducedAt', 'dueDay', 'buriedUntil', 'suspended',
  'nextReview', 'status', 'lastModified', 'syncStatus', 'deleted', 'starred', 'tags',
] as const satisfies readonly (keyof Card)[];

interface DeckRow {
  id: string;
  userId: string;
  name: string;
  language: string;
  newCardsPerDay: number | null;
  maxReviewsPerDay: number | null;
  reverseCards: number;
  showExamples: number;
  showGrammarNotes: number;
  showRelatedWords: number;
  cardCount: number;
  createdAt: string;
  lastModified: string;
  syncStatus: string;
  deleted: number;
}

interface CardRow {
  id: string;
  deckId: string;
  userId: string;
  front: string;
  back: string;
  language: string;
  examples: string;
  grammarNotes: string;
  relatedWords: string;
  interval: number;
  easeFactor: number;
  repetitions: number;
  phase: string;
  lapses: number;
  learningStep: number;
  leech: number;
  introducedAt: string | null;
  dueDay: string | null;
  buriedUntil: string | null;
  suspended: number;
  starred: number;
  tags: string;
  nextReview: string;
  status: string;
  lastModified: string;
  syncStatus: string;
  deleted: number;
}

interface ReviewEventRow {
  eventId: string;
  cardId: string;
  userId: string;
  rating: string;
  interval: number;
  easeFactor: number;
  reviewedAt: string;
  syncStatus: string;
}

interface UndoRow {
  id: number;
  cardId: string;
  syncStatus: string;
  previousState: string;
}

interface ReviewCountRow {
  previousState: string | null;
  reviewedAt: string;
}

function toDeck(row: DeckRow): Deck {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    language: row.language as Deck['language'],
    newCardsPerDay: row.newCardsPerDay === undefined ? 20 : row.newCardsPerDay,
    maxReviewsPerDay: row.maxReviewsPerDay === undefined ? 50 : row.maxReviewsPerDay,
    reverseCards: Boolean(row.reverseCards),
    showExamples: row.showExamples !== 0,
    showGrammarNotes: row.showGrammarNotes !== 0,
    showRelatedWords: row.showRelatedWords !== 0,
    cardCount: row.cardCount,
    createdAt: row.createdAt,
    lastModified: row.lastModified,
    syncStatus: row.syncStatus as Deck['syncStatus'],
    ...(row.deleted ? { deleted: true } : {}),
  };
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    deckId: row.deckId,
    userId: row.userId,
    front: row.front,
    back: row.back,
    language: row.language as Card['language'],
    examples: parseJsonArray(row.examples),
    grammarNotes: parseJsonArray(row.grammarNotes),
    relatedWords: parseJsonArray(row.relatedWords),
    tags: parseJsonArray(row.tags),
    interval: row.interval,
    easeFactor: row.easeFactor,
    repetitions: row.repetitions,
    phase: row.phase as Card['phase'],
    lapses: row.lapses,
    learningStep: row.learningStep,
    nextReview: row.nextReview,
    status: row.status as Card['status'],
    lastModified: row.lastModified,
    syncStatus: row.syncStatus as Card['syncStatus'],
    ...(row.introducedAt ? { introducedAt: row.introducedAt } : {}),
    ...(row.dueDay
      ? { dueDay: row.dueDay }
      : row.phase === 'review'
        ? { dueDay: collectionDayKey(new Date(row.nextReview)) }
        : {}),
    ...(row.buriedUntil ? { buriedUntil: row.buriedUntil } : {}),
    starred: Boolean(row.starred),
    ...(row.suspended ? { suspended: true } : {}),
    ...(row.leech ? { leech: true } : {}),
    ...(row.deleted ? { deleted: true } : {}),
  };
}

function parseCardSnapshot(value: string): Card | null {
  try {
    const parsed = JSON.parse(value) as Card;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function toReviewEvent(row: ReviewEventRow): ReviewEvent {
  return {
    eventId: row.eventId,
    cardId: row.cardId,
    userId: row.userId,
    rating: row.rating as ReviewEvent['rating'],
    interval: row.interval,
    easeFactor: row.easeFactor,
    reviewedAt: row.reviewedAt,
    syncStatus: row.syncStatus as ReviewEvent['syncStatus'],
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Cache key normalisation, so "Hablar " and "hablar" share one entry. */
function normaliseWord(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * A SQLite date modifier that shifts a UTC timestamp onto the device's local
 * day, e.g. `-480 minutes` in California.
 *
 * The obvious spelling is SQLite's own `localtime` modifier, and it is not
 * used here on purpose: it needs the platform's timezone database, which the
 * wasm build behind expo-sqlite on the web does not reliably carry — the same
 * query would then bucket by UTC on the web and by local time on a phone, and
 * a streak would disagree with itself across a user's own devices. Passing the
 * offset explicitly makes every target agree.
 *
 * Historical rows are bucketed with today's offset, so the hour either side of
 * a daylight-saving change can land on the neighbouring day. Anki accepts the
 * same imprecision with its fixed day cutoff, and the alternative — a timezone
 * database in the bundle — is not worth 400 kB to move one review.
 */
function collectionDayModifier(now: Date): string {
  // `getTimezoneOffset` is minutes to add to local time to reach UTC, so the
  // modifier that goes the other way is its negation.
  return `${-now.getTimezoneOffset() - 4 * 60} minutes`;
}
