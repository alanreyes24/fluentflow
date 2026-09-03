import type { Card, Deck } from '@fluentflow/core';
import { resolveConflict } from '@fluentflow/core';
import type { Store } from './types.ts';

/**
 * In-memory store used in local mode and by the test suite.
 *
 * It applies the same last-write-wins rule as the client so that a stale
 * retry — the classic "client uploaded, reply was lost, client uploads the old
 * copy again" — cannot roll a newer record backwards.
 */
export class MemoryStore implements Store {
  private readonly decks = new Map<string, Map<string, Deck>>();
  private readonly cards = new Map<string, Map<string, Card>>();

  async listDecks(userId: string, since?: string): Promise<Deck[]> {
    return filterSince([...(this.decks.get(userId)?.values() ?? [])], since);
  }

  async listCards(userId: string, since?: string): Promise<Card[]> {
    return filterSince([...(this.cards.get(userId)?.values() ?? [])], since);
  }

  async putDecks(userId: string, decks: Deck[]): Promise<void> {
    upsertAll(bucket(this.decks, userId), decks);
  }

  async putCards(userId: string, cards: Card[]): Promise<void> {
    upsertAll(bucket(this.cards, userId), cards);
  }

  async close(): Promise<void> {
    this.decks.clear();
    this.cards.clear();
  }
}

function bucket<T>(map: Map<string, Map<string, T>>, userId: string): Map<string, T> {
  let entry = map.get(userId);
  if (!entry) {
    entry = new Map();
    map.set(userId, entry);
  }
  return entry;
}

function upsertAll<T extends { id: string; lastModified: string }>(
  target: Map<string, T>,
  records: T[],
): void {
  for (const record of records) {
    const existing = target.get(record.id);
    if (!existing) {
      target.set(record.id, record);
      continue;
    }
    target.set(record.id, resolveConflict(record, existing).record);
  }
}

function filterSince<T extends { lastModified: string }>(records: T[], since?: string): T[] {
  if (!since) return records;
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) return records;
  return records.filter((record) => Date.parse(record.lastModified) > cutoff);
}
