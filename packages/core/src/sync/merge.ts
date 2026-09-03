import type { Card, Deck, IsoDate } from '../types.js';

/**
 * Last-write-wins reconciliation between the local SQLite mirror and Firestore.
 *
 * Two properties matter more than cleverness here:
 *
 *  1. **Convergence.** Two devices running this merge on the same pair of
 *     records must pick the same winner, including when `lastModified` is
 *     identical — otherwise they ping-pong writes at each other forever. Ties
 *     are broken by comparing a canonical serialisation, which is deterministic
 *     and needs no coordination.
 *  2. **Deletes propagate.** A delete is a normal write that sets `deleted`,
 *     not a missing row, because a missing row is indistinguishable from a row
 *     the other device has not uploaded yet.
 */

export interface Syncable {
  id: string;
  lastModified: IsoDate;
  deleted?: boolean;
}

export type MergeWinner = 'local' | 'remote';

export interface Resolution<T extends Syncable> {
  record: T;
  winner: MergeWinner;
  /** True when both sides had a copy and they differed. */
  conflicted: boolean;
}

/** Resolve one record that exists on both sides. */
export function resolveConflict<T extends Syncable>(local: T, remote: T): Resolution<T> {
  const localTime = timestamp(local.lastModified);
  const remoteTime = timestamp(remote.lastModified);
  const identical = canonical(local) === canonical(remote);

  if (localTime > remoteTime) {
    return { record: local, winner: 'local', conflicted: !identical };
  }
  if (remoteTime > localTime) {
    return { record: remote, winner: 'remote', conflicted: !identical };
  }

  if (identical) {
    return { record: remote, winner: 'remote', conflicted: false };
  }

  // Same instant, different content: both devices must reach the same answer
  // without talking to each other, so order by content.
  const winner = canonical(local) > canonical(remote) ? 'local' : 'remote';
  return { record: winner === 'local' ? local : remote, winner, conflicted: true };
}

export interface MergePlan<T extends Syncable> {
  /** The reconciled set, ready to become the local source of truth. */
  merged: T[];
  /** Records whose remote version won and must be written to SQLite. */
  applyLocally: T[];
  /** Records whose local version won and must be uploaded to Firestore. */
  pushRemote: T[];
  /** Records that differed on both sides; surfaced for logging, not for prompting. */
  conflicts: { id: string; winner: MergeWinner }[];
}

/**
 * Build a full two-way merge plan.
 *
 * @param local  every local record, including ones pending upload
 * @param remote every remote record for this user
 */
export function planMerge<T extends Syncable>(local: T[], remote: T[]): MergePlan<T> {
  const localById = indexById(local);
  const remoteById = indexById(remote);

  const merged: T[] = [];
  const applyLocally: T[] = [];
  const pushRemote: T[] = [];
  const conflicts: { id: string; winner: MergeWinner }[] = [];

  for (const [id, localRecord] of localById) {
    const remoteRecord = remoteById.get(id);
    if (!remoteRecord) {
      merged.push(localRecord);
      pushRemote.push(localRecord);
      continue;
    }

    const resolution = resolveConflict(localRecord, remoteRecord);
    merged.push(resolution.record);
    if (resolution.winner === 'remote') {
      if (resolution.conflicted || canonical(localRecord) !== canonical(remoteRecord)) {
        applyLocally.push(resolution.record);
      }
    } else {
      pushRemote.push(resolution.record);
    }
    if (resolution.conflicted) {
      conflicts.push({ id, winner: resolution.winner });
    }
  }

  for (const [id, remoteRecord] of remoteById) {
    if (localById.has(id)) continue;
    merged.push(remoteRecord);
    applyLocally.push(remoteRecord);
  }

  return { merged, applyLocally, pushRemote, conflicts };
}

/** Records the local device still owes the server. */
export function pendingUploads<T extends Syncable & { syncStatus?: string }>(records: T[]): T[] {
  return records.filter((record) => record.syncStatus === 'pending');
}

/** Mark a record as changed locally; every mutation path should go through this. */
export function touch<T extends Syncable & { syncStatus?: string }>(
  record: T,
  now: Date = new Date(),
): T {
  return { ...record, lastModified: now.toISOString(), syncStatus: 'pending' };
}

/** Soft-delete, so the tombstone can win a last-write-wins race. */
export function softDelete<T extends Syncable & { syncStatus?: string }>(
  record: T,
  now: Date = new Date(),
): T {
  return { ...touch(record, now), deleted: true };
}

/**
 * Recompute deck card counts after a merge. The count is derived rather than
 * synced: two devices adding one card each would otherwise both write
 * `cardCount: 11` and lose a card.
 */
export function recomputeCardCounts(decks: Deck[], cards: Card[]): Deck[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.deleted) continue;
    counts.set(card.deckId, (counts.get(card.deckId) ?? 0) + 1);
  }
  return decks.map((deck) => {
    const cardCount = counts.get(deck.id) ?? 0;
    return cardCount === deck.cardCount ? deck : { ...deck, cardCount };
  });
}

function indexById<T extends Syncable>(records: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const record of records) {
    const existing = map.get(record.id);
    // Defensive: a local table should never hold duplicate ids, but a bad merge
    // upstream should not silently pick an arbitrary one.
    if (!existing || timestamp(record.lastModified) > timestamp(existing.lastModified)) {
      map.set(record.id, record);
    }
  }
  return map;
}

function timestamp(value: IsoDate): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Stable serialisation used for equality and tie-breaking. Keys are sorted and
 * `syncStatus` is excluded, since it describes the local queue rather than the
 * record's content and differs between devices by definition.
 */
export function canonical(record: Syncable): string {
  const entries = Object.entries(record as unknown as Record<string, unknown>)
    .filter(([key]) => key !== 'syncStatus')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}
