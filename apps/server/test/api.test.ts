import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/store/memory.ts';
// The Anki fixture builder lives with the core tests; reusing it keeps the
// server exercising the exact archives the importer is tested against.
import { buildApkg, spanishNotes } from '../../../packages/core/test/helpers/anki-fixture.js';

let server: Server;
let baseUrl: string;
const store = new MemoryStore();

before(async () => {
  const config = loadConfig({ FLUENTFLOW_MODE: 'local', PORT: '0' } as NodeJS.ProcessEnv);
  const app = createApp({ config, store });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await store.close();
});

function call(path: string, init: RequestInit & { user?: string } = {}) {
  const { user = 'alice', headers, ...rest } = init;
  return fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      ...(user ? { authorization: `Bearer local:${user}` } : {}),
      ...(headers ?? {}),
    },
  });
}

function json(path: string, body: unknown, init: RequestInit & { user?: string } = {}) {
  return call(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

const deck = (overrides: Record<string, unknown> = {}) => ({
  id: 'deck-1',
  userId: 'alice',
  name: 'Spanish Verbs',
  language: 'es',
  cardCount: 1,
  createdAt: '2024-09-01T00:00:00.000Z',
  lastModified: '2024-09-03T10:00:00.000Z',
  syncStatus: 'pending',
  ...overrides,
});

const card = (overrides: Record<string, unknown> = {}) => ({
  id: 'card-1',
  deckId: 'deck-1',
  userId: 'alice',
  front: 'hablar',
  back: 'to speak',
  language: 'es',
  examples: ['Ella habla español.'],
  interval: 1,
  easeFactor: 2.5,
  repetitions: 1,
  nextReview: '2024-09-04T10:00:00.000Z',
  status: 'learning',
  lastModified: '2024-09-03T10:00:00.000Z',
  syncStatus: 'pending',
  ...overrides,
});

const review = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'event-1',
  cardId: 'card-1',
  userId: 'alice',
  rating: 'good',
  interval: 1,
  easeFactor: 2.5,
  reviewedAt: '2024-09-03T10:00:00.000Z',
  syncStatus: 'pending',
  ...overrides,
});

test('health does not require a token', async () => {
  const response = await call('/health', { user: '' });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).mode, 'local');
});

test('local API permits the development UI origins', async () => {
  for (const origin of ['http://localhost:8081', 'http://127.0.0.1:8081', 'app://fluentflow']) {
    const response = await call('/api/ai/status', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
});

test('local API does not grant browser access to an unrelated website', async () => {
  const response = await call('/api/ai/chat', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://untrusted.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('the sync endpoints reject an unauthenticated caller', async () => {
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  const cases: [string, RequestInit][] = [
    ['/api/sync/state', { method: 'GET' }],
    ['/api/sync/pull', { method: 'GET' }],
    ['/api/sync/push', post],
    ['/api/sync/seed', post],
    ['/api/import/apkg', { method: 'POST', body: Buffer.from('x') }],
  ];

  for (const [path, init] of cases) {
    const response = await call(path, { ...init, user: '' });
    assert.equal(response.status, 401, `${init.method} ${path}`);
  }
});

test('a malformed authorization header is rejected', async () => {
  for (const header of ['', 'Bearer', 'Bearer   ', 'Basic abc', 'local:alice']) {
    const response = await call('/api/sync/state', { user: '', headers: { authorization: header } });
    assert.equal(response.status, 401, JSON.stringify(header));
  }
});

// --- sync -------------------------------------------------------------------

async function seed(user: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await json('/api/sync/seed', body, { user });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).epoch;
}

async function pull(user: string, epoch: string, since?: string) {
  const query = new URLSearchParams({ epoch, ...(since ? { since } : {}) });
  return call(`/api/sync/pull?${query}`, { user });
}

test('a collection starts unseeded, and the seed becomes what every pull returns', async () => {
  const state = await (await call('/api/sync/state', { user: 'sam' })).json();
  assert.equal(state.epoch, null);

  const epoch = await seed('sam', {
    decks: [deck()],
    cards: [card()],
    reviewEvents: [review()],
  });
  assert.equal((await (await call('/api/sync/state', { user: 'sam' })).json()).epoch, epoch);

  const pulled = await (await pull('sam', epoch)).json();
  assert.equal(pulled.decks.length, 1);
  assert.equal(pulled.cards[0].front, 'hablar');
  assert.equal(pulled.reviewEvents[0].eventId, 'event-1');
  // The client-only queue flag is never persisted as "pending".
  assert.equal(pulled.cards[0].syncStatus, 'synced');
});

test('a second seed is refused unless it names the epoch it replaces', async () => {
  const first = await seed('tess', { cards: [card({ id: 'first' })] });

  const refused = await json('/api/sync/seed', { cards: [card({ id: 'second' })] }, { user: 'tess' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).epoch, first);

  const second = await seed('tess', { cards: [card({ id: 'second' })], replaceEpoch: first });
  assert.notEqual(second, first);
  const pulled = await (await pull('tess', second)).json();
  assert.deepEqual(pulled.cards.map((c: { id: string }) => c.id), ['second'], 'a seed replaces everything');
});

test('push and pull from a device on an old epoch answer 409 with the current one', async () => {
  const first = await seed('uma');
  const second = await seed('uma', { replaceEpoch: first });

  const pushed = await json('/api/sync/push', { epoch: first, cards: [card()] }, { user: 'uma' });
  assert.equal(pushed.status, 409);
  assert.equal((await pushed.json()).epoch, second);

  const pulled = await pull('uma', first);
  assert.equal(pulled.status, 409);
  assert.equal((await pulled.json()).error, 'epoch_mismatch');
});

test('pushing before anything was seeded answers 409 with no epoch', async () => {
  const response = await json('/api/sync/push', { epoch: 'whatever', cards: [card()] }, { user: 'vic' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).epoch, null);
});

test('a pushed change comes back on an incremental pull, and nothing else does', async () => {
  const epoch = await seed('wes', { cards: [card({ id: 'seeded' })] });
  const { cursor } = await (await pull('wes', epoch)).json();

  const pushed = await json('/api/sync/push', {
    epoch,
    cards: [card({ id: 'reviewed', lastModified: '2024-09-05T00:00:00.000Z' })],
    reviewEvents: [review({ eventId: 'event-wes', cardId: 'reviewed' })],
  }, { user: 'wes' });
  assert.equal(pushed.status, 200);

  const changes = await (await pull('wes', epoch, cursor)).json();
  assert.deepEqual(changes.cards.map((c: { id: string }) => c.id), ['reviewed']);
  assert.deepEqual(changes.reviewEvents.map((e: { eventId: string }) => e.eventId), ['event-wes']);
});

test('a stale push is refused and the server copy is handed back', async () => {
  const fresh = card({ id: 'race', interval: 6, lastModified: '2024-09-05T00:00:00.000Z' });
  const stale = card({ id: 'race', interval: 1, lastModified: '2024-09-01T00:00:00.000Z' });
  const epoch = await seed('xena', { cards: [fresh] });

  const response = await json('/api/sync/push', { epoch, cards: [stale] }, { user: 'xena' });
  const body = await response.json();
  assert.equal(body.rejected.cards[0].interval, 6);

  const pulled = await (await pull('xena', epoch)).json();
  assert.equal(pulled.cards[0].interval, 6);
});

test('users cannot see each other data, and a spoofed userId is ignored', async () => {
  const yara = await seed('yara', { decks: [deck({ id: 'spoof', userId: 'zed', name: 'Not Zeds' })] });
  const zed = await seed('zed');

  const zedData = await (await pull('zed', zed)).json();
  assert.equal(zedData.decks.length, 0, 'must not land in the account named in the body');
  const yaraData = await (await pull('yara', yara)).json();
  assert.equal(yaraData.decks[0].userId, 'yara');
  // Another user's epoch is not this user's epoch.
  assert.equal((await pull('zed', yara)).status, 409);
});

test('invalid records are rejected with per-field detail', async () => {
  const epoch = await seed('alice');
  const response = await json('/api/sync/push', {
    epoch,
    cards: [
      card({ id: 'bad-1', easeFactor: 'lots' }),
      card({ id: 'bad-2', language: 'fr' }),
      card({ id: 'bad-3', nextReview: 'whenever' }),
    ],
    reviewEvents: [review({ rating: 'meh' })],
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'invalid_request');
  assert.match(body.details.join(' '), /easeFactor must be a finite number/);
  assert.match(body.details.join(' '), /language must be one of: es, bs/);

  const events = await json('/api/sync/push', { epoch, reviewEvents: [review({ rating: 'meh' })] });
  assert.equal(events.status, 400);
  assert.match((await events.json()).details.join(' '), /rating must be one of/);
});

test('scheduler fields survive a round trip, and a legacy card is given a phase', async () => {
  const legacy = card({ id: 'legacy-1', interval: 15, repetitions: 4, status: 'learning' });
  delete (legacy as Record<string, unknown>).phase;
  const epoch = await seed('gina', {
    cards: [card({ id: 'sched-1', phase: 'relearning', lapses: 3, learningStep: 1, leech: true }), legacy],
  });

  const body = await (await pull('gina', epoch)).json();
  const sched = body.cards.find((c: { id: string }) => c.id === 'sched-1');
  assert.equal(sched.phase, 'relearning');
  assert.equal(sched.lapses, 3);
  assert.equal(sched.learningStep, 1);
  assert.equal(sched.leech, true);
  const old = body.cards.find((c: { id: string }) => c.id === 'legacy-1');
  assert.equal(old.phase, 'review', 'a day-level interval means it graduated');
});

test('a batch is rejected whole when any record is invalid', async () => {
  const epoch = await seed('frank');
  await json('/api/sync/push', {
    epoch,
    cards: [card({ id: 'good-one' }), card({ id: 'bad-one', interval: -5 })],
  }, { user: 'frank' });

  const body = await (await pull('frank', epoch)).json();
  assert.equal(body.cards.length, 0, 'a partial write would leave the client unsure what landed');
});

// --- Anki import ------------------------------------------------------------

test('importing an .apkg creates the deck and cards for the caller', async () => {
  const epoch = await seed('grace');
  const apkg = buildApkg({
    schema: 18,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    notes: spanishNotes(55),
  });

  const response = await call('/api/import/apkg?filename=Spanish%20A1.apkg', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: apkg,
    user: 'grace',
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.summary.cardsImported, 55);
  assert.equal(body.summary.detection.language, 'es');
  assert.equal(body.decks[0].cardCount, 55);
  assert.equal(body.stored, true);

  // And it really landed in the store, for this user only.
  const pulled = await (await pull('grace', epoch)).json();
  assert.equal(pulled.cards.length, 55);
  assert.ok(pulled.cards.every((c: { userId: string }) => c.userId === 'grace'));

  const heidi = await seed('heidi');
  const other = await (await pull('heidi', heidi)).json();
  assert.equal(other.cards.length, 0);
});

test('an import into an account that was never seeded is refused', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Bosanski'],
    fieldNames: ['Front', 'Back'],
    notes: [{ fields: ['raditi', 'to work'] }],
  });
  const response = await call('/api/import/apkg?filename=Bosanski.apkg', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: apkg,
    user: 'nobody-yet',
  });
  assert.equal(response.status, 409);
});

test('a dry-run import reports what it would do without writing', async () => {
  const epoch = await seed('ivan');
  const apkg = buildApkg({
    schema: 11,
    decks: ['Bosanski'],
    fieldNames: ['Front', 'Back'],
    notes: [{ fields: ['raditi', 'to work'] }],
  });

  const response = await call('/api/import/apkg?dryRun=true&filename=Bosanski.apkg', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: apkg,
    user: 'ivan',
  });

  const body = await response.json();
  assert.equal(body.stored, false);
  assert.equal(body.summary.detection.language, 'bs');

  const pulled = await (await pull('ivan', epoch)).json();
  assert.equal(pulled.cards.length, 0);
});

test('a corrupt archive returns an actionable 422', async () => {
  const response = await call('/api/import/apkg', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('not an apkg at all'),
    user: 'judy',
  });

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'not_a_zip');
  assert.match(body.message, /Export it again from Anki/i);
});

test('an empty upload is a 400, not a crash', async () => {
  const response = await call('/api/import/apkg', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(0),
    user: 'ken',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'empty_upload');
});

test('unknown routes return JSON, not an HTML error page', async () => {
  const response = await call('/api/nope');

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});

test('imported records come back as synced, not as pending uploads', async () => {
  const epoch = await seed('mallory');
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    notes: spanishNotes(20),
  });

  await call('/api/import/apkg?filename=Spanish%20A1.apkg', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: apkg,
    user: 'mallory',
  });

  const pulled = await (await pull('mallory', epoch)).json();

  // The importer marks its output `pending` because on a real device it is —
  // those records still have to reach the server. Once stored, they are the
  // server's copy, and a device pulling them owes nothing. Leaking `pending`
  // here made every device re-upload an entire imported deck.
  assert.equal(pulled.cards.length, 20);
  assert.ok(
    pulled.cards.every((c: { syncStatus: string }) => c.syncStatus === 'synced'),
    'no pulled card may claim to be pending',
  );
  assert.ok(pulled.decks.every((d: { syncStatus: string }) => d.syncStatus === 'synced'));
});
