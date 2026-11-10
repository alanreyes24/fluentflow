import { randomUUID } from 'node:crypto';
import type { Card, Deck, ReviewEvent } from '@fluentflow/core';
import { resolveConflict } from '@fluentflow/core';
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
 * In-memory store used in local mode and by the test suite. Same semantics as
 * the Postgres store: epochs, per-user versions and last-write-wins.
 */

interface Versioned<T> {
  record: T;
  version: number;
}

interface UserData {
  epoch: string;
  version: number;
  decks: Map<string, Versioned<Deck>>;
  cards: Map<string, Versioned<Card>>;
  reviewEvents: Map<string, Versioned<ReviewEvent>>;
}

export class MemoryStore implements Store {
  private readonly users = new Map<string, UserData>();

  async getEpoch(userId: string): Promise<string | null> {
    return this.users.get(userId)?.epoch ?? null;
  }

  async seed(userId: string, records: SyncRecords): Promise<{ epoch: string; cursor: string }> {
    const previous = this.users.get(userId);
    const data: UserData = {
      epoch: randomUUID(),
      version: (previous?.version ?? 0) + 1,
      decks: new Map(),
      cards: new Map(),
      reviewEvents: new Map(),
    };
    for (const deck of records.decks) data.decks.set(deck.id, { record: toStored(deck), version: data.version });
    for (const card of records.cards) data.cards.set(card.id, { record: toStored(card), version: data.version });
    for (const event of records.reviewEvents) {
      data.reviewEvents.set(event.eventId, { record: toStored(event), version: data.version });
    }
    this.users.set(userId, data);
    return { epoch: data.epoch, cursor: String(data.version) };
  }

  async push(userId: string, epoch: string, records: SyncRecords): Promise<PushResult> {
    const data = this.current(userId, epoch);
    const version = data.version + 1;
    let wrote = false;

    const rejectedDecks = upsert(data.decks, records.decks, version, () => (wrote = true));
    const rejectedCards = upsert(data.cards, records.cards, version, () => (wrote = true));
    for (const event of records.reviewEvents) {
      if (data.reviewEvents.has(event.eventId)) continue;
      data.reviewEvents.set(event.eventId, { record: toStored(event), version });
      wrote = true;
    }

    if (wrote) data.version = version;
    return { rejected: { decks: rejectedDecks, cards: rejectedCards } };
  }

  async pull(userId: string, epoch: string, since?: string): Promise<SyncChanges> {
    const data = this.current(userId, epoch);
    const after = parseCursor(since);
    const newer = <T>(map: Map<string, Versioned<T>>) =>
      [...map.values()].filter((entry) => entry.version > after).map((entry) => entry.record);
    return {
      decks: newer(data.decks),
      cards: newer(data.cards),
      reviewEvents: newer(data.reviewEvents),
      cursor: String(data.version),
    };
  }

  async close(): Promise<void> {
    this.users.clear();
  }

  private current(userId: string, epoch: string): UserData {
    const data = this.users.get(userId);
    if (!data || data.epoch !== epoch) throw new EpochError(data?.epoch ?? null);
    return data;
  }
}

function upsert<T extends { id: string; lastModified: string; syncStatus?: string }>(
  target: Map<string, Versioned<T>>,
  records: T[],
  version: number,
  onWrite: () => void,
): T[] {
  const rejected: T[] = [];
  for (const incoming of records) {
    const record = toStored(incoming);
    const existing = target.get(record.id);
    if (existing) {
      const resolution = resolveConflict(record, existing.record);
      if (resolution.winner === 'remote') {
        // Identical re-uploads are not rejections, just no-ops.
        if (resolution.conflicted) rejected.push(existing.record);
        continue;
      }
    }
    target.set(record.id, { record, version });
    onWrite();
  }
  return rejected;
}
