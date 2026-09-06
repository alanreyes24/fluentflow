import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planMerge,
  resolveConflict,
  pendingUploads,
  touch,
  softDelete,
  recomputeCardCounts,
  canonical,
  createCard,
  createDeck,
  reviewCard,
} from '../dist/index.js';

const T1 = '2024-09-03T10:00:00.000Z';
const T2 = '2024-09-03T11:00:00.000Z';

const card = (overrides) => ({
  id: 'c1',
  deckId: 'd1',
  userId: 'u1',
  front: 'hablar',
  back: 'to speak',
  language: 'es',
  examples: [],
  interval: 1,
  easeFactor: 2.5,
  repetitions: 1,
  nextReview: T1,
  status: 'learning',
  lastModified: T1,
  syncStatus: 'synced',
  ...overrides,
});

test('the newer lastModified wins', () => {
  const local = card({ interval: 6, lastModified: T2 });
  const remote = card({ interval: 1, lastModified: T1 });

  assert.deepEqual(resolveConflict(local, remote), {
    record: local,
    winner: 'local',
    conflicted: true,
  });
  assert.equal(resolveConflict(remote, local).winner, 'remote');
});

test('identical records are not reported as conflicts', () => {
  const result = resolveConflict(card(), card());

  assert.equal(result.conflicted, false);
  assert.equal(result.winner, 'remote');
});

test('syncStatus alone does not make two records differ', () => {
  const result = resolveConflict(card({ syncStatus: 'pending' }), card({ syncStatus: 'synced' }));

  assert.equal(result.conflicted, false);
  assert.equal(canonical(card({ syncStatus: 'pending' })), canonical(card({ syncStatus: 'synced' })));
});

test('a same-instant conflict resolves the same way on both devices', () => {
  const phone = card({ interval: 6, easeFactor: 2.6 });
  const laptop = card({ interval: 15, easeFactor: 2.36 });

  // Each device sees its own copy as "local" and the other as "remote".
  const onPhone = resolveConflict(phone, laptop);
  const onLaptop = resolveConflict(laptop, phone);

  assert.equal(canonical(onPhone.record), canonical(onLaptop.record), 'both must converge');
  assert.ok(onPhone.conflicted && onLaptop.conflicted);
});

test('a merge plan routes each record to the side that needs it', () => {
  const localOnly = card({ id: 'local-only', syncStatus: 'pending' });
  const remoteOnly = card({ id: 'remote-only' });
  const localNewer = card({ id: 'both-local', interval: 6, lastModified: T2 });
  const remoteOlder = card({ id: 'both-local', interval: 1, lastModified: T1 });
  const localOlder = card({ id: 'both-remote', interval: 1, lastModified: T1 });
  const remoteNewer = card({ id: 'both-remote', interval: 6, lastModified: T2 });
  const agreed = card({ id: 'agreed' });

  const plan = planMerge(
    [localOnly, localNewer, localOlder, agreed],
    [remoteOnly, remoteOlder, remoteNewer, agreed],
  );

  assert.deepEqual(plan.pushRemote.map((r) => r.id).sort(), ['both-local', 'local-only']);
  assert.deepEqual(plan.applyLocally.map((r) => r.id).sort(), ['both-remote', 'remote-only']);
  assert.equal(plan.merged.length, 5);
  assert.deepEqual(plan.conflicts.map((c) => c.id).sort(), ['both-local', 'both-remote']);

  // A record both sides already agree on causes no traffic in either direction.
  assert.ok(!plan.pushRemote.some((r) => r.id === 'agreed'));
  assert.ok(!plan.applyLocally.some((r) => r.id === 'agreed'));
});

test('the merge plan is idempotent', () => {
  const local = [card({ id: 'a', lastModified: T2 }), card({ id: 'b' })];
  const remote = [card({ id: 'b' }), card({ id: 'c' })];

  const first = planMerge(local, remote);
  const second = planMerge(first.merged, first.merged);

  assert.deepEqual(
    second.merged.map((r) => r.id).sort(),
    first.merged.map((r) => r.id).sort(),
  );
  assert.deepEqual(second.pushRemote, []);
  assert.deepEqual(second.applyLocally, []);
});

test('a delete propagates as a tombstone and can be overridden by a later edit', () => {
  const original = card();
  const deleted = softDelete(original, new Date(T1));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.syncStatus, 'pending');

  // The tombstone wins over an older edit on the other device.
  const olderEdit = card({ interval: 6, lastModified: '2024-09-03T09:00:00.000Z' });
  assert.equal(resolveConflict(olderEdit, deleted).record.deleted, true);

  // A newer edit on the other device wins over the tombstone: last write, not
  // "delete always wins".
  const newerEdit = card({ interval: 6, lastModified: T2 });
  assert.equal(resolveConflict(newerEdit, deleted).record.deleted, undefined);
});

test('a duplicate id in one collection keeps the newer row', () => {
  const stale = card({ interval: 1, lastModified: T1 });
  const fresh = card({ interval: 6, lastModified: T2 });

  const plan = planMerge([stale, fresh], []);

  assert.equal(plan.merged.length, 1);
  assert.equal(plan.merged[0].interval, 6);
});

test('only pending records are queued for upload', () => {
  const records = [card({ id: 'a' }), card({ id: 'b', syncStatus: 'pending' })];

  assert.deepEqual(pendingUploads(records).map((r) => r.id), ['b']);
});

test('touch stamps the time and marks the record dirty', () => {
  const stamped = touch(card(), new Date(T2));

  assert.equal(stamped.lastModified, T2);
  assert.equal(stamped.syncStatus, 'pending');
});

test('deck card counts are derived, not synced', () => {
  const deck = { ...createDeck({ userId: 'u1', name: 'Spanish', language: 'es' }), cardCount: 99 };
  const cards = [
    card({ id: 'a', deckId: deck.id }),
    card({ id: 'b', deckId: deck.id }),
    card({ id: 'c', deckId: deck.id, deleted: true }),
    card({ id: 'd', deckId: 'other' }),
  ];

  const [recomputed] = recomputeCardCounts([deck], cards);

  assert.equal(recomputed.cardCount, 2, 'deleted cards and other decks do not count');
});

test('two devices reviewing the same card converge on the later review', () => {
  const now = new Date(T1);
  const original = {
    ...createCard({
      userId: 'u1',
      deckId: 'd1',
      front: 'hablar',
      back: 'to speak',
      language: 'es',
      now,
    }),
    syncStatus: 'synced',
  };

  const onPhone = reviewCard(original, 'good', { now: new Date('2024-09-03T10:05:00.000Z') });
  const onLaptop = reviewCard(original, 'again', { now: new Date('2024-09-03T10:10:00.000Z') });

  const plan = planMerge([onPhone], [onLaptop]);

  assert.equal(plan.merged.length, 1);
  assert.equal(plan.merged[0].lastModified, onLaptop.lastModified);
  assert.equal(plan.merged[0].interval, 0, 'the later "again" wins');
  assert.deepEqual(plan.applyLocally.map((r) => r.id), [original.id]);
  assert.deepEqual(plan.pushRemote, []);
});
