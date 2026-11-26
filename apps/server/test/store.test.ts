import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Card, Deck, ReviewEvent } from '@fluentflow/core';
import { MemoryStore } from '../src/store/memory.ts';
import { PostgresStore, type SqlDatabase } from '../src/store/postgres.ts';
import { EpochError, type Store } from '../src/store/types.ts';

/**
 * The store contract, run against both implementations. The Postgres store is
 * exercised on PGlite — real Postgres compiled to WebAssembly — so the SQL
 * that runs on Railway is the SQL under test, with no server to provision.
 */

function pglite(): SqlDatabase {
  const db = new PGlite();
  return {
    query: (text, params) => db.query(text, params) as never,
    exec: async (text) => {
      await db.exec(text);
    },
    transaction: (task) => db.transaction((tx) => task({ query: (t, p) => tx.query(t, p) as never })),
    close: () => db.close(),
  };
}

const implementations: [string, () => Store][] = [
  ['memory', () => new MemoryStore()],
  ['postgres', () => new PostgresStore(pglite())],
];

const deck = (overrides: Partial<Deck> = {}): Deck => ({
  id: 'deck-1',
  userId: 'u',
  name: 'Spanish',
  language: 'es',
  newCardsPerDay: 20,
  maxReviewsPerDay: 50,
  reverseCards: false,
  showExamples: true,
  showGrammarNotes: true,
  showRelatedWords: true,
  cardCount: 1,
  createdAt: '2024-09-01T00:00:00.000Z',
  lastModified: '2024-09-01T00:00:00.000Z',
  syncStatus: 'pending',
  ...overrides,
});

const card = (overrides: Partial<Card> = {}): Card => ({
  id: 'card-1',
  deckId: 'deck-1',
  userId: 'u',
  front: 'hablar',
  back: 'to speak',
  language: 'es',
  examples: [],
  grammarNotes: [],
  relatedWords: [],
  interval: 1,
  easeFactor: 2.5,
  repetitions: 1,
  phase: 'review',
  lapses: 0,
  learningStep: 0,
  nextReview: '2024-09-04T10:00:00.000Z',
  status: 'learning',
  lastModified: '2024-09-03T10:00:00.000Z',
  syncStatus: 'pending',
  ...overrides,
});

const review = (overrides: Partial<ReviewEvent> = {}): ReviewEvent => ({
  eventId: 'event-1',
  cardId: 'card-1',
  userId: 'u',
  rating: 'good',
  interval: 1,
  easeFactor: 2.5,
  reviewedAt: '2024-09-03T10:00:00.000Z',
  syncStatus: 'pending',
  ...overrides,
});

const empty = { decks: [], cards: [], reviewEvents: [] };

for (const [name, create] of implementations) {
  describe(`${name} store`, () => {
    let store: Store;
    before(() => {
      store = create();
    });
    after(() => store.close());

    test('read-aloud clips are stored by key, byte for byte, and never overwritten', async () => {
      assert.equal(await store.getSpeechClip('clip-1'), null);
      const wav = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 255]);
      await store.putSpeechClip('clip-1', wav);
      assert.deepEqual([...(await store.getSpeechClip('clip-1'))!], [...wav]);
      // A second clip for the same key (a retry, another device) keeps the first.
      await store.putSpeechClip('clip-1', new Uint8Array([9]));
      assert.deepEqual([...(await store.getSpeechClip('clip-1'))!], [...wav]);
    });

    test('a user has no epoch until seeded', async () => {
      assert.equal(await store.getEpoch('fresh'), null);
      await assert.rejects(store.pull('fresh', 'x'), EpochError);
      await assert.rejects(store.push('fresh', 'x', empty), EpochError);
    });

    test('a seed is pulled back whole and stored as synced', async () => {
      const { epoch } = await store.seed('a', {
        decks: [deck()],
        cards: [card(), card({ id: 'card-2', deleted: true })],
        reviewEvents: [review(), review({ eventId: 'event-2' })],
      });
      assert.equal(await store.getEpoch('a'), epoch);

      const pulled = await store.pull('a', epoch);
      assert.equal(pulled.decks.length, 1);
      assert.equal(pulled.cards.length, 2, 'tombstones are part of the collection');
      assert.equal(pulled.reviewEvents.length, 2);
      assert.ok(pulled.cards.every((c) => c.syncStatus === 'synced'));
      assert.equal(pulled.cards.find((c) => c.id === 'card-2')?.deleted, true);
    });

    test('a reseed replaces everything and retires the old epoch', async () => {
      const first = await store.seed('b', { ...empty, cards: [card({ id: 'old' })] });
      const second = await store.seed('b', { ...empty, cards: [card({ id: 'new' })] });
      assert.notEqual(first.epoch, second.epoch);

      await assert.rejects(store.pull('b', first.epoch), (error: unknown) => {
        return error instanceof EpochError && error.epoch === second.epoch;
      });
      const pulled = await store.pull('b', second.epoch);
      assert.deepEqual(pulled.cards.map((c) => c.id), ['new']);
    });

    test('an incremental pull returns exactly what changed after the cursor', async () => {
      const { epoch } = await store.seed('c', { ...empty, cards: [card({ id: 'seeded' })] });
      const { cursor } = await store.pull('c', epoch);

      await store.push('c', epoch, {
        ...empty,
        cards: [card({ id: 'seeded', interval: 9, lastModified: '2024-09-09T00:00:00.000Z' })],
        reviewEvents: [review({ eventId: 'later', cardId: 'seeded' })],
      });

      const changes = await store.pull('c', epoch, cursor);
      assert.deepEqual(changes.cards.map((c) => [c.id, c.interval]), [['seeded', 9]]);
      assert.deepEqual(changes.reviewEvents.map((e) => e.eventId), ['later']);
      assert.ok(Number(changes.cursor) > Number(cursor));

      const nothing = await store.pull('c', epoch, changes.cursor);
      assert.equal(nothing.cards.length + nothing.reviewEvents.length + nothing.decks.length, 0);
    });

    test('an older write loses and the stored copy is handed back', async () => {
      const fresh = card({ interval: 6, lastModified: '2024-09-05T00:00:00.000Z' });
      const { epoch } = await store.seed('d', { ...empty, cards: [fresh] });
      const { cursor } = await store.pull('d', epoch);

      const result = await store.push('d', epoch, {
        ...empty,
        cards: [card({ interval: 1, lastModified: '2024-09-01T00:00:00.000Z' })],
      });
      assert.equal(result.rejected.cards[0]?.interval, 6);

      const after = await store.pull('d', epoch, cursor);
      assert.equal(after.cards.length, 0, 'nothing was written');
    });

    test('re-sending the same batch writes nothing and rejects nothing', async () => {
      const { epoch } = await store.seed('e', empty);
      const batch = { decks: [deck()], cards: [card()], reviewEvents: [review()] };
      await store.push('e', epoch, batch);
      const { cursor } = await store.pull('e', epoch);

      const again = await store.push('e', epoch, batch);
      assert.deepEqual(again.rejected, { decks: [], cards: [] });
      const changes = await store.pull('e', epoch, cursor);
      assert.equal(changes.cards.length + changes.decks.length + changes.reviewEvents.length, 0);
      assert.equal(changes.cursor, cursor);
    });

    test('users are isolated from each other', async () => {
      const one = await store.seed('f1', { ...empty, cards: [card({ id: 'shared-id' })] });
      const two = await store.seed('f2', { ...empty, cards: [card({ id: 'shared-id', front: 'otro' })] });
      assert.equal((await store.pull('f1', one.epoch)).cards[0]?.front, 'hablar');
      assert.equal((await store.pull('f2', two.epoch)).cards[0]?.front, 'otro');
      await assert.rejects(store.pull('f2', one.epoch), EpochError);
    });

    test('settings merge one at a time, need no seed, and stay per user', async () => {
      const T1 = '2026-11-18T10:00:00.000Z';
      const T2 = '2026-11-18T11:00:00.000Z';
      assert.deepEqual(await store.getSettings('s1'), {});

      await store.mergeSettings('s1', { theme: { value: 'dark', updatedAt: T2 }, dailyGoal: { value: 20, updatedAt: T1 } });
      // Another device changed only the goal, later; and an older theme.
      const merged = await store.mergeSettings('s1', {
        dailyGoal: { value: 40, updatedAt: T2 },
        theme: { value: 'light', updatedAt: T1 },
      });
      const expected = { dailyGoal: { value: 40, updatedAt: T2 }, theme: { value: 'dark', updatedAt: T2 } };
      assert.deepEqual(merged, expected);
      assert.deepEqual(await store.getSettings('s1'), expected);
      assert.deepEqual(await store.getSettings('s2'), {});

      // Re-seeding the collection leaves settings alone.
      await store.seed('s1', empty);
      assert.deepEqual(await store.getSettings('s1'), expected);
    });
  });
}
