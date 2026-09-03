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

/** Strip client-only fields before anything is written to shared storage. */
export function toStored<T extends { syncStatus?: string }>(record: T): Omit<T, 'syncStatus'> {
  const { syncStatus: _ignored, ...rest } = record;
  return rest;
}
