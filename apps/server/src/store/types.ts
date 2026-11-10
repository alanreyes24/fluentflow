import type { Card, Deck, ReviewEvent } from '@fluentflow/core';

/**
 * Persistence contract for the sync API.
 *
 * The server's database is the one source of truth for a user's collection.
 * Devices keep a local copy so studying works offline, but what the server
 * holds is what every device converges on.
 *
 * Two ideas carry the protocol:
 *
 *  - **Epoch.** A user's collection is created once, by a *seed*: one device
 *    uploads everything it has and that becomes the server's copy. The seed
 *    stamps a new epoch. A device whose local copy was not built from the
 *    current epoch throws its copy away and downloads the server's, so after a
 *    seed every device holds exactly what the server holds.
 *  - **Version.** Every write bumps a per-user counter and stamps the rows it
 *    touched with it. A pull asks for rows newer than the version it last saw,
 *    which is exact: it does not depend on any device's clock.
 */

export interface SyncRecords {
  decks: Deck[];
  cards: Card[];
  reviewEvents: ReviewEvent[];
}

export interface SyncChanges extends SyncRecords {
  /** The version to pass as `since` on the next pull. */
  cursor: string;
}

export interface PushResult {
  /**
   * Records the server kept its own copy of because that copy was newer.
   * The client applies these so it does not keep a version the server refused.
   */
  rejected: { decks: Deck[]; cards: Card[] };
}

export interface Store {
  /** The current epoch, or null if the user's collection was never seeded. */
  getEpoch(userId: string): Promise<string | null>;
  /** Replace the user's whole collection and start a new epoch. */
  seed(userId: string, records: SyncRecords): Promise<{ epoch: string; cursor: string }>;
  /**
   * Last-write-wins upsert. Must be idempotent: clients retry after a lost
   * reply. Throws {@link EpochError} unless `epoch` is the current one.
   */
  push(userId: string, epoch: string, records: SyncRecords): Promise<PushResult>;
  /**
   * Everything changed after `since`, or everything when `since` is absent.
   * Throws {@link EpochError} unless `epoch` is the current one.
   */
  pull(userId: string, epoch: string, since?: string): Promise<SyncChanges>;
  /** Resolves when the store can serve requests; rejects with why it cannot. */
  check(): Promise<void>;
  close(): Promise<void>;
}

/** The user's collection has not been seeded yet, or was re-seeded since. */
export class EpochError extends Error {
  readonly epoch: string | null;
  constructor(epoch: string | null) {
    super(epoch ? 'This device is out of date with the server.' : 'Nothing has been uploaded yet.');
    this.name = 'EpochError';
    this.epoch = epoch;
  }
}

/** No database is configured for this deployment. */
export class StoreUnavailableError extends Error {
  constructor(message = 'The sync database is not configured on this server.') {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

/**
 * Normalise a record on its way into shared storage.
 *
 * `syncStatus` describes one device's upload queue, so it has no meaning on the
 * server — but it cannot simply be dropped either, because a client that reads
 * a record back without it would have to invent a value. Every stored record is
 * therefore stamped `synced`.
 */
export function toStored<T extends { syncStatus?: string }>(record: T): T {
  return record.syncStatus === 'synced' ? record : { ...record, syncStatus: 'synced' };
}

/** A version cursor from the query string; anything unparsable means "from the start". */
export function parseCursor(since: string | undefined): number {
  if (!since) return 0;
  const value = Number(since);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
