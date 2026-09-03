import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * Local database schema and migrations.
 *
 * SQLite is the source of truth on device. Every read the UI performs and every
 * write a review produces goes here first; Firestore is a replica that catches
 * up when the network allows. That ordering is what makes the app usable on a
 * train, and it is why `syncStatus` is a local column that never leaves.
 *
 * Migrations run in order and are recorded in `user_version`, so upgrading an
 * installed app never re-runs a completed step.
 */

export const DATABASE_NAME = 'fluentflow.db';

type Migration = (db: SQLiteDatabase) => Promise<void>;

const migrations: Migration[] = [
  // 1 — decks, cards and the sync bookkeeping they need.
  async (db) => {
    await db.execAsync(`
      CREATE TABLE decks (
        id            TEXT PRIMARY KEY NOT NULL,
        userId        TEXT NOT NULL,
        name          TEXT NOT NULL,
        language      TEXT NOT NULL,
        cardCount     INTEGER NOT NULL DEFAULT 0,
        createdAt     TEXT NOT NULL,
        lastModified  TEXT NOT NULL,
        syncStatus    TEXT NOT NULL DEFAULT 'pending',
        deleted       INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE cards (
        id            TEXT PRIMARY KEY NOT NULL,
        deckId        TEXT NOT NULL,
        userId        TEXT NOT NULL,
        front         TEXT NOT NULL,
        back          TEXT NOT NULL,
        language      TEXT NOT NULL,
        examples      TEXT NOT NULL DEFAULT '[]',
        interval      REAL NOT NULL DEFAULT 0,
        easeFactor    REAL NOT NULL DEFAULT 2.5,
        repetitions   INTEGER NOT NULL DEFAULT 0,
        nextReview    TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'new',
        lastModified  TEXT NOT NULL,
        syncStatus    TEXT NOT NULL DEFAULT 'pending',
        deleted       INTEGER NOT NULL DEFAULT 0
      );

      -- The study queue is "my cards, in this deck, due before now", and the
      -- deck list needs per-deck counts. Both are hot paths on every launch.
      CREATE INDEX idx_cards_due ON cards (userId, deckId, deleted, nextReview);
      CREATE INDEX idx_cards_deck ON cards (deckId, deleted);
      CREATE INDEX idx_decks_user ON decks (userId, deleted);

      -- Partial indexes keep the upload queue scan proportional to what is
      -- actually pending rather than to collection size.
      CREATE INDEX idx_cards_pending ON cards (userId) WHERE syncStatus = 'pending';
      CREATE INDEX idx_decks_pending ON decks (userId) WHERE syncStatus = 'pending';

      CREATE TABLE sync_meta (
        userId        TEXT PRIMARY KEY NOT NULL,
        lastPulledAt  TEXT,
        lastPushedAt  TEXT
      );
    `);
  },

  // 2 — generated example sentences, cached independently of the card.
  async (db) => {
    await db.execAsync(`
      -- Examples are cached by (word, language) rather than by card id so the
      -- same word in two decks only costs one inference, and so the cache
      -- survives a card being deleted and re-imported.
      CREATE TABLE example_cache (
        word       TEXT NOT NULL,
        language   TEXT NOT NULL,
        examples   TEXT NOT NULL,
        source     TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        PRIMARY KEY (word, language)
      );
    `);
  },

  // 3 — review history, for the statistics screen and for debugging scheduling.
  async (db) => {
    await db.execAsync(`
      CREATE TABLE review_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        cardId      TEXT NOT NULL,
        userId      TEXT NOT NULL,
        rating      TEXT NOT NULL,
        interval    REAL NOT NULL,
        easeFactor  REAL NOT NULL,
        reviewedAt  TEXT NOT NULL
      );

      CREATE INDEX idx_review_log_user ON review_log (userId, reviewedAt);
    `);
  },
];

export async function migrate(db: SQLiteDatabase): Promise<void> {
  // WAL keeps a long study session's writes from blocking the reads that
  // populate the next card.
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;

  while (version < migrations.length) {
    const migration = migrations[version];
    if (!migration) break;
    await db.withTransactionAsync(async () => {
      await migration(db);
    });
    version++;
    // PRAGMA does not accept bound parameters, and `version` is a loop counter
    // over a fixed-length array, so interpolation is safe here.
    await db.execAsync(`PRAGMA user_version = ${version}`);
  }
}

export const SCHEMA_VERSION = migrations.length;
