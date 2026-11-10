import { randomUUID } from 'node:crypto';
import type { Card, Deck, ReviewEvent } from '@fluentflow/core';
import { normalizeCard, resolveConflict } from '@fluentflow/core';
import {
  EpochError,
  parseCursor,
  toStored,
  type PushResult,
  type Store,
  type SyncChanges,
  type SyncRecords,
} from './types.ts';

/**
 * Postgres-backed store: the hosted app's database on Railway.
 *
 * Each record is kept whole as `jsonb`, with the few fields the server queries
 * on (`id`, `last_modified`, `version`) lifted into columns. The record shapes
 * evolve with the app, and storing them whole means a new card field needs no
 * migration here — only validation in `validate.ts`.
 *
 * Every write for a user takes that user's `sync_users` row lock first, so
 * writes for one user are serialised and their versions are committed in
 * order. That is what makes "rows with version > cursor" an exact answer for
 * a pull: no write can commit a lower version after a reader has seen a higher
 * one.
 */

/** The slice of a SQL client this store needs; `pg` and PGlite both fit it. */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface SqlDatabase extends SqlClient {
  /** Run several statements with no parameters. */
  exec(text: string): Promise<void>;
  transaction<T>(task: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Rows per INSERT. Each batch is one JSON parameter, so this bounds its size. */
const INSERT_CHUNK = 500;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_users (
    user_id    text PRIMARY KEY,
    epoch      text NOT NULL,
    version    bigint NOT NULL,
    seeded_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS decks (
    user_id        text NOT NULL,
    id             text NOT NULL,
    last_modified  timestamptz NOT NULL,
    version        bigint NOT NULL,
    data           jsonb NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS decks_user_version ON decks (user_id, version);

  CREATE TABLE IF NOT EXISTS cards (
    user_id        text NOT NULL,
    id             text NOT NULL,
    deck_id        text NOT NULL,
    last_modified  timestamptz NOT NULL,
    version        bigint NOT NULL,
    data           jsonb NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS cards_user_version ON cards (user_id, version);

  CREATE TABLE IF NOT EXISTS review_events (
    user_id      text NOT NULL,
    event_id     text NOT NULL,
    card_id      text NOT NULL,
    reviewed_at  timestamptz NOT NULL,
    version      bigint NOT NULL,
    data         jsonb NOT NULL,
    PRIMARY KEY (user_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS review_events_user_version ON review_events (user_id, version);
`;

export class PostgresStore implements Store {
  private ready: Promise<void> | null = null;
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  /** Create the tables on first use. Idempotent, so every boot can run it. */
  private migrate(): Promise<void> {
    this.ready ??= this.db.exec(SCHEMA).then(
      () => undefined,
      (error: unknown) => {
        // Let the next request try again rather than caching the failure.
        this.ready = null;
        throw error;
      },
    );
    return this.ready;
  }

  async getEpoch(userId: string): Promise<string | null> {
    await this.migrate();
    const { rows } = await this.db.query<{ epoch: string }>(
      'SELECT epoch FROM sync_users WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.epoch ?? null;
  }

  async seed(userId: string, records: SyncRecords): Promise<{ epoch: string; cursor: string }> {
    await this.migrate();
    const epoch = randomUUID();
    return this.db.transaction(async (tx) => {
      // Upsert-and-lock in one statement, so two seeds cannot interleave.
      const { rows } = await tx.query<{ version: string }>(
        `INSERT INTO sync_users (user_id, epoch, version) VALUES ($1, $2, 1)
         ON CONFLICT (user_id) DO UPDATE
           SET epoch = EXCLUDED.epoch, version = sync_users.version + 1, seeded_at = now()
         RETURNING version`,
        [userId, epoch],
      );
      const version = Number(rows[0]!.version);

      for (const table of ['decks', 'cards', 'review_events']) {
        await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      }
      await insertDecks(tx, userId, version, dedupe(records.decks.map(toStored)));
      await insertCards(tx, userId, version, dedupe(records.cards.map(toStored)));
      await insertReviewEvents(tx, userId, version, records.reviewEvents.map(toStored));

      return { epoch, cursor: String(version) };
    });
  }

  async push(userId: string, epoch: string, records: SyncRecords): Promise<PushResult> {
    await this.migrate();
    return this.db.transaction(async (tx) => {
      const current = await lockUser(tx, userId, epoch);
      const version = current + 1;

      const decks = await resolveAgainstStored(tx, 'decks', userId, dedupe(records.decks.map(toStored)));
      const cards = await resolveAgainstStored(tx, 'cards', userId, dedupe(records.cards.map(toStored)));

      await insertDecks(tx, userId, version, decks.winners);
      await insertCards(tx, userId, version, cards.winners);
      const eventsWritten = await insertReviewEvents(
        tx,
        userId,
        version,
        records.reviewEvents.map(toStored),
      );

      if (decks.winners.length + cards.winners.length + eventsWritten > 0) {
        await tx.query('UPDATE sync_users SET version = $2 WHERE user_id = $1', [userId, version]);
      }
      return {
        rejected: { decks: decks.rejected, cards: cards.rejected.map(normalizeCard) },
      };
    });
  }

  async pull(userId: string, epoch: string, since?: string): Promise<SyncChanges> {
    await this.migrate();
    const after = parseCursor(since);
    return this.db.transaction(async (tx) => {
      // One snapshot for the cursor and the rows, so a write landing mid-pull
      // is either wholly in this answer or wholly in the next.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const { rows } = await tx.query<{ epoch: string; version: string }>(
        'SELECT epoch, version FROM sync_users WHERE user_id = $1',
        [userId],
      );
      const user = rows[0];
      if (!user || user.epoch !== epoch) throw new EpochError(user?.epoch ?? null);

      const read = async <T>(table: string) =>
        (
          await tx.query<{ data: T }>(
            `SELECT data FROM ${table} WHERE user_id = $1 AND version > $2`,
            [userId, after],
          )
        ).rows.map((row) => row.data);

      return {
        decks: await read<Deck>('decks'),
        cards: (await read<Card>('cards')).map(normalizeCard),
        reviewEvents: await read<ReviewEvent>('review_events'),
        cursor: String(Number(user.version)),
      };
    });
  }

  async check(): Promise<void> {
    await this.migrate();
    await this.db.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** Ensure the device is on the current epoch, and hold the user's write lock. */
async function lockUser(tx: SqlClient, userId: string, epoch: string): Promise<number> {
  const { rows } = await tx.query<{ epoch: string; version: string }>(
    'SELECT epoch, version FROM sync_users WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  const user = rows[0];
  if (!user || user.epoch !== epoch) throw new EpochError(user?.epoch ?? null);
  return Number(user.version);
}

/**
 * Split incoming records into those that replace the stored copy and the
 * stored copies that beat them. An identical re-upload is neither.
 */
async function resolveAgainstStored<T extends { id: string; lastModified: string }>(
  tx: SqlClient,
  table: 'decks' | 'cards',
  userId: string,
  records: T[],
): Promise<{ winners: T[]; rejected: T[] }> {
  const winners: T[] = [];
  const rejected: T[] = [];
  for (const chunk of chunks(records, INSERT_CHUNK)) {
    const { rows } = await tx.query<{ data: T }>(
      `SELECT data FROM ${table} WHERE user_id = $1 AND id = ANY($2::text[])`,
      [userId, chunk.map((record) => record.id)],
    );
    const stored = new Map(rows.map((row) => [row.data.id, row.data]));
    for (const record of chunk) {
      const existing = stored.get(record.id);
      if (!existing) {
        winners.push(record);
        continue;
      }
      const resolution = resolveConflict(record, existing);
      if (resolution.winner === 'local') winners.push(record);
      else if (resolution.conflicted) rejected.push(existing);
    }
  }
  return { winners, rejected };
}

async function insertDecks(tx: SqlClient, userId: string, version: number, decks: Deck[]) {
  for (const chunk of chunks(decks, INSERT_CHUNK)) {
    await tx.query(
      `INSERT INTO decks (user_id, id, last_modified, version, data)
       SELECT $1, r->>'id', (r->>'lastModified')::timestamptz, $2, r
       FROM jsonb_array_elements($3::jsonb) AS r
       ON CONFLICT (user_id, id) DO UPDATE
         SET last_modified = EXCLUDED.last_modified, version = EXCLUDED.version, data = EXCLUDED.data`,
      [userId, version, JSON.stringify(chunk)],
    );
  }
}

async function insertCards(tx: SqlClient, userId: string, version: number, cards: Card[]) {
  for (const chunk of chunks(cards, INSERT_CHUNK)) {
    await tx.query(
      `INSERT INTO cards (user_id, id, deck_id, last_modified, version, data)
       SELECT $1, r->>'id', r->>'deckId', (r->>'lastModified')::timestamptz, $2, r
       FROM jsonb_array_elements($3::jsonb) AS r
       ON CONFLICT (user_id, id) DO UPDATE
         SET deck_id = EXCLUDED.deck_id, last_modified = EXCLUDED.last_modified,
             version = EXCLUDED.version, data = EXCLUDED.data`,
      [userId, version, JSON.stringify(chunk)],
    );
  }
}

/** Review events are immutable: a known id is skipped. Returns how many were new. */
async function insertReviewEvents(
  tx: SqlClient,
  userId: string,
  version: number,
  events: ReviewEvent[],
): Promise<number> {
  let written = 0;
  for (const chunk of chunks(events, INSERT_CHUNK)) {
    const { rows } = await tx.query(
      `INSERT INTO review_events (user_id, event_id, card_id, reviewed_at, version, data)
       SELECT $1, r->>'eventId', r->>'cardId', (r->>'reviewedAt')::timestamptz, $2, r
       FROM jsonb_array_elements($3::jsonb) AS r
       ON CONFLICT (user_id, event_id) DO NOTHING
       RETURNING event_id`,
      [userId, version, JSON.stringify(chunk)],
    );
    written += rows.length;
  }
  return written;
}

function dedupe<T extends { id: string; lastModified: string }>(records: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing ? resolveConflict(record, existing).record : record);
  }
  return [...byId.values()];
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
