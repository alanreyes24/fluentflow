import type { Card, Deck } from '@fluentflow/core';

/**
 * Persistence contract. Two implementations exist: Firestore for real use and
 * an in-memory store for local development and tests. Keeping the interface
 * this small is deliberate — the sync protocol does full-collection pulls and
 * batched idempotent writes, nothing that needs a query language.
 */
export interface Store {
  listDecks(userId: string, since?: string): Promise<Deck[]>;
  listCards(userId: string, since?: string): Promise<Card[]>;
  /** Upsert by id. Must be idempotent: the client retries after a lost reply. */
  putDecks(userId: string, decks: Deck[]): Promise<void>;
  putCards(userId: string, cards: Card[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Normalise a record on its way into shared storage.
 *
 * `syncStatus` describes one device's upload queue, so it has no meaning on the
 * server — but it cannot simply be dropped either, because a client that reads
 * a record back without it would have to invent a value. Every stored record is
 * therefore stamped `synced`.
 *
 * This runs at the storage boundary rather than in the route handlers on
 * purpose. The sync endpoint normalises as a side effect of validation, but the
 * Anki importer builds its records in core (where they are correctly marked
 * `pending`, because on a real device they are) and hands them straight to the
 * store. Without this, every device that pulled an imported deck would believe
 * it owed the server an upload of all of it.
 */
export function toStored<T extends { syncStatus?: string }>(record: T): T {
  return record.syncStatus === 'synced' ? record : { ...record, syncStatus: 'synced' };
}
