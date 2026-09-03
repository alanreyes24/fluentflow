import type { SQLiteDatabase } from 'expo-sqlite';
import {
  createCard,
  createDeck,
  deckProgress,
  dueCards,
  recomputeCardCounts,
  reviewCard,
  softDelete,
  touch,
  type Card,
  type Deck,
  type DeckProgress,
  type RatingName,
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

  async listAllCards(userId: string): Promise<Card[]> {
    const rows = await this.db.getAllAsync<CardRow>(
      'SELECT * FROM cards WHERE userId = ? AND deleted = 0',
      userId,
    );
    return rows.map(toCard);
  }

  async getCard(id: string): Promise<Card | null> {
    const row = await this.db.getFirstAsync<CardRow>('SELECT * FROM cards WHERE id = ?', id);
    return row ? toCard(row) : null;
  }

  /**
   * The study queue for a deck.
   *
   * `limit` exists so a deck with 10 000 cards does not deserialise every one
   * of them to show the next card.
   */
  async dueCards(deckId: string, now: Date = new Date(), limit = 200): Promise<Card[]> {
    const rows = await this.db.getAllAsync<CardRow>(
      `SELECT * FROM cards
       WHERE deckId = ? AND deleted = 0 AND nextReview <= ?
       ORDER BY nextReview
       LIMIT ?`,
      deckId,
      now.toISOString(),
      limit,
    );
    return rows.map(toCard);
  }

  /** Cards that are not due yet, for the "study ahead" path. */
  async upcomingCards(deckId: string, now: Date = new Date(), limit = 50): Promise<Card[]> {
    const rows = await this.db.getAllAsync<CardRow>(
      `SELECT * FROM cards
       WHERE deckId = ? AND deleted = 0 AND nextReview > ?
       ORDER BY nextReview
       LIMIT ?`,
      deckId,
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
  ): Promise<Card> {
    const card = createCard({
      userId,
      deckId: deck.id,
      front,
      back,
      language: deck.language,
      examples,
    });
    await this.saveCards([card]);
    await this.refreshDeckCount(deck.id);
    return card;
  }

  async updateCard(card: Card, changes: Partial<Card>): Promise<Card> {
    const updated = touch({ ...card, ...changes });
    await this.saveCards([updated]);
    return updated;
  }

  async deleteCard(card: Card): Promise<void> {
    await this.saveCards([softDelete(card)]);
    await this.refreshDeckCount(card.deckId);
  }

  /** Apply a review: update scheduling, and record it for the stats screen. */
  async rateCard(card: Card, rating: RatingName, now: Date = new Date()): Promise<Card> {
    const reviewed = reviewCard(card, rating, now);
    await this.db.withTransactionAsync(async () => {
      await this.writeCards([reviewed]);
      await this.db.runAsync(
        `INSERT INTO review_log (cardId, userId, rating, interval, easeFactor, reviewedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        reviewed.id,
        reviewed.userId,
        rating,
        reviewed.interval,
        reviewed.easeFactor,
        now.toISOString(),
      );
    });
    return reviewed;
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
         (SELECT COUNT(*) FROM cards WHERE userId = ?1 AND syncStatus = 'pending') AS count`,
      userId,
    );
    return row?.count ?? 0;
  }

  /**
   * Mark records as uploaded — but only if they have not changed since the
   * upload started. Comparing `lastModified` is what stops a review made during
   * the round trip from being marked synced and then never sent.
   */
  async markSynced(decks: Deck[], cards: Card[]): Promise<void> {
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
    });
  }

  /** Apply records that arrived from the server, already merged by the caller. */
  async applyRemote(decks: Deck[], cards: Card[]): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.writeDecks(decks.map((deck) => ({ ...deck, syncStatus: 'synced' as const })));
      await this.writeCards(cards.map((card) => ({ ...card, syncStatus: 'synced' as const })));
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
      moved = decks.changes + cards.changes;
    });
    return moved;
  }

  // --- internals -----------------------------------------------------------

  private async writeDecks(decks: Deck[]): Promise<void> {
    for (const deck of decks) {
      await this.db.runAsync(
        `INSERT INTO decks (id, userId, name, language, cardCount, createdAt, lastModified, syncStatus, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           userId = excluded.userId,
           name = excluded.name,
           language = excluded.language,
           cardCount = excluded.cardCount,
           lastModified = excluded.lastModified,
           syncStatus = excluded.syncStatus,
           deleted = excluded.deleted`,
        deck.id,
        deck.userId,
        deck.name,
        deck.language,
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
        `INSERT INTO cards (id, deckId, userId, front, back, language, examples, interval,
                            easeFactor, repetitions, nextReview, status, lastModified, syncStatus, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           deckId = excluded.deckId,
           userId = excluded.userId,
           front = excluded.front,
           back = excluded.back,
           language = excluded.language,
           examples = excluded.examples,
           interval = excluded.interval,
           easeFactor = excluded.easeFactor,
           repetitions = excluded.repetitions,
           nextReview = excluded.nextReview,
           status = excluded.status,
           lastModified = excluded.lastModified,
           syncStatus = excluded.syncStatus,
           deleted = excluded.deleted`,
        card.id,
        card.deckId,
        card.userId,
        card.front,
        card.back,
        card.language,
        JSON.stringify(card.examples ?? []),
        card.interval,
        card.easeFactor,
        card.repetitions,
        card.nextReview,
        card.status,
        card.lastModified,
        card.syncStatus,
        card.deleted ? 1 : 0,
      );
    }
  }
}

// --- row mapping -----------------------------------------------------------

interface DeckRow {
  id: string;
  userId: string;
  name: string;
  language: string;
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
  interval: number;
  easeFactor: number;
  repetitions: number;
  nextReview: string;
  status: string;
  lastModified: string;
  syncStatus: string;
  deleted: number;
}

function toDeck(row: DeckRow): Deck {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    language: row.language as Deck['language'],
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
    interval: row.interval,
    easeFactor: row.easeFactor,
    repetitions: row.repetitions,
    nextReview: row.nextReview,
    status: row.status as Card['status'],
    lastModified: row.lastModified,
    syncStatus: row.syncStatus as Card['syncStatus'],
    ...(row.deleted ? { deleted: true } : {}),
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
