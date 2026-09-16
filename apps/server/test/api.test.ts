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
  const cases: [string, RequestInit][] = [
    ['/api/sync', { method: 'GET' }],
    ['/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['/api/import/apkg', { method: 'POST', body: Buffer.from('x') }],
  ];

  for (const [path, init] of cases) {
    const response = await call(path, { ...init, user: '' });
    assert.equal(response.status, 401, `${init.method} ${path}`);
  }
});

test('a malformed authorization header is rejected', async () => {
  for (const header of ['', 'Bearer', 'Bearer   ', 'Basic abc', 'local:alice']) {
    const response = await call('/api/sync', { user: '', headers: { authorization: header } });
    assert.equal(response.status, 401, JSON.stringify(header));
  }
});

test('a pushed deck and card come back on the next pull', async () => {
  const pushed = await json('/api/sync', { decks: [deck()], cards: [card()] });
  assert.equal(pushed.status, 200);
  assert.deepEqual((await pushed.json()).accepted, { decks: 1, cards: 1 });

  const pulled = await (await call('/api/sync')).json();
  assert.equal(pulled.decks.length, 1);
  assert.equal(pulled.cards.length, 1);
  assert.equal(pulled.cards[0].front, 'hablar');
  // The client-only queue flag is never persisted as "pending".
  assert.equal(pulled.cards[0].syncStatus, 'synced');
});

test('users cannot see each other data', async () => {
  await json('/api/sync', { decks: [deck({ id: 'bob-deck', name: 'Bosanski' })] }, { user: 'bob' });

  const alice = await (await call('/api/sync')).json();
  const bob = await (await call('/api/sync', { user: 'bob' })).json();

  assert.ok(!alice.decks.some((d: { id: string }) => d.id === 'bob-deck'));
  assert.deepEqual(bob.decks.map((d: { id: string }) => d.id), ['bob-deck']);
});

test('a spoofed userId in the body is replaced by the token owner', async () => {
  await json('/api/sync', {
    decks: [deck({ id: 'spoof', userId: 'bob', name: 'Not Bobs' })],
  });

  const bob = await (await call('/api/sync', { user: 'bob' })).json();
  const alice = await (await call('/api/sync')).json();

  assert.ok(!bob.decks.some((d: { id: string }) => d.id === 'spoof'), 'must not land in bob account');
  const stored = alice.decks.find((d: { id: string }) => d.id === 'spoof');
  assert.equal(stored.userId, 'alice');
});

test('an incremental pull returns only what changed', async () => {
  await json('/api/sync', {
    cards: [card({ id: 'old', lastModified: '2024-09-01T00:00:00.000Z' })],
  }, { user: 'carol' });
  await json('/api/sync', {
    cards: [card({ id: 'new', lastModified: '2024-09-05T00:00:00.000Z' })],
  }, { user: 'carol' });

  const response = await call('/api/sync?since=2024-09-02T00:00:00.000Z', { user: 'carol' });
  const body = await response.json();

  assert.deepEqual(body.cards.map((c: { id: string }) => c.id), ['new']);
});

test('a stale re-upload cannot roll back a newer record', async () => {
  const fresh = card({ id: 'race', interval: 6, lastModified: '2024-09-05T00:00:00.000Z' });
  const stale = card({ id: 'race', interval: 1, lastModified: '2024-09-01T00:00:00.000Z' });

  await json('/api/sync', { cards: [fresh] }, { user: 'dave' });
  await json('/api/sync', { cards: [stale] }, { user: 'dave' });

  const body = await (await call('/api/sync', { user: 'dave' })).json();
  assert.equal(body.cards[0].interval, 6);
});

test('pushing the same batch twice is a no-op', async () => {
  const payload = { decks: [deck({ id: 'idem' })], cards: [card({ id: 'idem-card', deckId: 'idem' })] };

  await json('/api/sync', payload, { user: 'erin' });
  await json('/api/sync', payload, { user: 'erin' });

  const body = await (await call('/api/sync', { user: 'erin' })).json();
  assert.equal(body.decks.length, 1);
  assert.equal(body.cards.length, 1);
});

test('invalid records are rejected with per-field detail', async () => {
  const response = await json('/api/sync', {
    cards: [
      card({ id: 'bad-1', easeFactor: 'lots' }),
      card({ id: 'bad-2', language: 'fr' }),
      card({ id: 'bad-3', nextReview: 'whenever' }),
    ],
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'invalid_request');
  assert.equal(body.details.length, 3);
  assert.match(body.details.join(' '), /easeFactor must be a finite number/);
  assert.match(body.details.join(' '), /language must be one of: es, bs/);
  assert.match(body.details.join(' '), /nextReview must be an ISO-8601 date/);
});

test('scheduler fields survive a round trip, and a bad phase is rejected', async () => {
  await json(
    '/api/sync',
    {
      cards: [
        card({ id: 'sched-1', phase: 'relearning', lapses: 3, learningStep: 1, leech: true }),
      ],
    },
    { user: 'gina' },
  );

  const body = await (await call('/api/sync', { user: 'gina' })).json();
  assert.equal(body.cards[0].phase, 'relearning');
  assert.equal(body.cards[0].lapses, 3);
  assert.equal(body.cards[0].learningStep, 1);
  assert.equal(body.cards[0].leech, true);

  const response = await json('/api/sync', { cards: [card({ id: 'sched-2', phase: 'limbo' })] });
  assert.equal(response.status, 400);
  const rejected = await response.json();
  assert.match(rejected.details.join(' '), /phase must be one of/);
});

test('a card from a client with no scheduler fields is given a phase', async () => {
  // The old client sent interval, ease and repetitions and nothing else; the
  // card has to arrive schedulable rather than half-filled.
  const legacy = card({ id: 'legacy-1', interval: 15, repetitions: 4, status: 'learning' });
  delete (legacy as Record<string, unknown>).phase;

  await json('/api/sync', { cards: [legacy] }, { user: 'hank' });

  const body = await (await call('/api/sync', { user: 'hank' })).json();
  assert.equal(body.cards[0].phase, 'review', 'a day-level interval means it graduated');
  assert.equal(body.cards[0].lapses, 0);
  assert.equal(body.cards[0].learningStep, 0);
});

test('a valid batch is rejected whole when any record is invalid', async () => {
  await json('/api/sync', {
    cards: [card({ id: 'good-one' }), card({ id: 'bad-one', interval: -5 })],
  }, { user: 'frank' });

  const body = await (await call('/api/sync', { user: 'frank' })).json();
  assert.equal(body.cards.length, 0, 'a partial write would leave the client unsure what landed');
});

// --- Anki import ------------------------------------------------------------

test('importing an .apkg creates the deck and cards for the caller', async () => {
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
  const pulled = await (await call('/api/sync', { user: 'grace' })).json();
  assert.equal(pulled.cards.length, 55);
  assert.ok(pulled.cards.every((c: { userId: string }) => c.userId === 'grace'));

  const other = await (await call('/api/sync', { user: 'heidi' })).json();
  assert.equal(other.cards.length, 0);
});

test('a dry-run import reports what it would do without writing', async () => {
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

  const pulled = await (await call('/api/sync', { user: 'ivan' })).json();
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

  const pulled = await (await call('/api/sync', { user: 'mallory' })).json();

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
