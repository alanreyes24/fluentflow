#!/usr/bin/env node
/**
 * End-to-end check of the success criteria, against the real sync server.
 *
 * This is not a unit test — those live in `packages/core/test` and
 * `apps/server/test`. It exercises the seams those cannot reach: two devices
 * talking to one account over HTTP, an Anki archive travelling through the
 * import endpoint, and an offline device catching up. The UI is the one layer
 * it cannot cover; everything underneath it is real.
 *
 * Each device here is a small stand-in for what the app does on device: hold
 * records locally, reconcile with `planMerge` from core, push what it owns.
 *
 *   node scripts/verify-flow.mjs
 */

import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { MemoryStore } from '../apps/server/src/store/memory.ts';
import {
  createCard,
  createDeck,
  deckProgress,
  dueCards,
  generateExamples,
  planMerge,
  reviewCard,
  recomputeCardCounts,
  softDelete,
} from '@fluentflow/core';
import { buildApkg, spanishNotes } from '../packages/core/test/helpers/anki-fixture.js';

const USER = 'verify-user';
const checks = [];
let baseUrl = '';

async function main() {
  const server = await startServer();
  try {
    await run();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  report();
}

async function run() {
  // --- 1. Sign in, create a deck, add ten cards ----------------------------
  const desktop = new Device('desktop');
  const deck = createDeck({ userId: USER, name: 'Spanish Verbs', language: 'es' });
  desktop.decks.push(deck);

  const words = [
    ['hablar', 'to speak'], ['comer', 'to eat'], ['vivir', 'to live'],
    ['tener', 'to have'], ['hacer', 'to do'], ['poder', 'to be able'],
    ['querer', 'to want'], ['saber', 'to know'], ['venir', 'to come'],
    ['salir', 'to leave'],
  ];
  for (const [front, back] of words) {
    desktop.cards.push(createCard({ userId: USER, deckId: deck.id, front, back, language: 'es' }));
  }

  await desktop.push();
  check('a deck and ten cards reach the server', desktop.lastPush.accepted.cards === 10);

  // --- 2. A second device picks them up ------------------------------------
  const laptop = new Device('laptop');
  await laptop.pull();
  check(
    'a second device sees the deck and all ten cards',
    laptop.decks.length === 1 && laptop.cards.length === 10,
  );
  check(
    'the deck arrives intact',
    laptop.decks[0].name === 'Spanish Verbs' && laptop.decks[0].language === 'es',
  );

  // --- 3. Every card starts out due ---------------------------------------
  const initial = deckProgress(laptop.cards);
  check(
    'new cards are immediately available to study',
    initial.new === 10 && initial.due === 10 && initial.mastered === 0,
  );

  // --- 4. Reveal a card and generate examples ------------------------------
  const card = dueCards(laptop.cards)[0];

  const withModel = await generateExamples(
    { word: card.front, meaning: card.back, language: 'es' },
    {
      // Stands in for the bundled model; the real one is an ONNX session behind
      // the same interface.
      infer: async () => '["Ella habla espanol con su madre.", "Hablamos todos los dias."]',
      budgetMs: 2000,
    },
  );
  check(
    'a working model produces example sentences in the target language',
    withModel.source === 'model' && withModel.examples.length === 2,
  );
  check(
    'generation stays inside the two-second budget',
    withModel.durationMs < 2000,
    `${withModel.durationMs}ms`,
  );

  const withoutModel = await generateExamples(
    { word: card.front, meaning: card.back, language: 'es' },
    { infer: null },
  );
  check(
    'with no model installed, examples still appear',
    withoutModel.source === 'fallback' && withoutModel.examples.length > 0,
  );

  const slowModel = await generateExamples(
    { word: card.front, language: 'es' },
    {
      budgetMs: 150,
      infer: (request) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('["too late"]'), 5000);
          request.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    },
  );
  check(
    'a model over budget is abandoned rather than blocking the reveal',
    slowModel.source === 'fallback',
  );

  // --- 5. Rate the card, and see it on the other device --------------------
  laptop.replaceCard({ ...card, examples: withModel.examples });
  const rated = reviewCard(laptop.getCard(card.id), 'good');
  laptop.replaceCard(rated);
  await laptop.push();

  await desktop.pull();
  const onDesktop = desktop.getCard(card.id);
  check(
    'a review made on one device shows up on the other',
    onDesktop.phase === 'learning' && onDesktop.repetitions === 1,
  );
  check('the generated examples sync with the card', onDesktop.examples.length === 2);

  // --- 6. Import an Anki deck with scheduling intact -----------------------
  const apkg = buildApkg({
    schema: 18,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    notes: spanishNotes(60),
  });

  const imported = await post('/api/import/apkg?filename=Spanish%20A1.apkg', apkg, {
    'content-type': 'application/octet-stream',
  });
  check('a 60-card Anki deck imports', imported.summary.cardsImported === 60, '60 cards');
  check(
    'the language is detected from the deck name',
    imported.summary.detection.language === 'es' && imported.summary.detection.confidence === 'high',
  );

  const mature = imported.cards.find((c) => c.interval === 40);
  check(
    'Anki scheduling survives the import',
    Boolean(mature) && mature.easeFactor === 2.75 && mature.status === 'mastered',
    mature ? `interval ${mature.interval}d, ease ${mature.easeFactor}` : 'no mature card',
  );
  check(
    'a graduated card resumes in review rather than back on the learning steps',
    Boolean(mature) && mature.phase === 'review',
  );

  await desktop.pull();
  check(
    'the imported deck reaches every device',
    desktop.decks.length === 2 && desktop.cards.length === 70,
  );

  // --- 7. A Bosnian deck alongside the Spanish one -------------------------
  const bosnian = createDeck({ userId: USER, name: 'Bosanski A1', language: 'bs' });
  desktop.decks.push(bosnian);
  desktop.cards.push(
    createCard({ userId: USER, deckId: bosnian.id, front: 'raditi', back: 'to work', language: 'bs' }),
  );
  await desktop.push();

  const bosnianExamples = await generateExamples(
    { word: 'raditi', meaning: 'to work', language: 'bs' },
    { infer: null },
  );
  check(
    'a Bosnian deck coexists with the Spanish one',
    desktop.decks.some((d) => d.language === 'bs') && desktop.decks.some((d) => d.language === 'es'),
  );
  check(
    'examples respect the deck language',
    bosnianExamples.examples.every((s) => !/[¿¡]/.test(s)) && bosnianExamples.examples.length > 0,
    bosnianExamples.examples[0],
  );

  // --- 8. Offline, then reconnected ---------------------------------------
  const offline = new Device('offline-desktop');
  await offline.pull();
  offline.online = false;

  const queue = dueCards(offline.cards).slice(0, 5);
  for (const due of queue) {
    offline.replaceCard(reviewCard(offline.getCard(due.id), 'easy'));
  }
  check(
    'reviews are recorded while offline',
    offline.pending().cards.length === 5,
    `${offline.pending().cards.length} queued of ${queue.length} reviewed`,
  );

  const failed = await offline.push().catch(() => null);
  check('an offline push does not reach the server', failed === null);

  offline.online = true;
  await offline.push();
  check('the queue drains once the connection is back', offline.pending().cards.length === 0);

  await laptop.pull();
  const syncedBack = queue.every((q) => laptop.getCard(q.id).repetitions > 0);
  check('offline reviews arrive on the other devices', syncedBack);

  // --- 9. Conflicting edits converge --------------------------------------
  const contested = dueCards(desktop.cards)[0];
  const desktopEdit = reviewCard(desktop.getCard(contested.id), 'again', {
    now: new Date('2030-01-01T10:00:00Z'),
  });
  const laptopEdit = reviewCard(laptop.getCard(contested.id), 'easy', {
    now: new Date('2030-01-01T10:05:00Z'),
  });

  const onDesktopResult = planMerge([desktopEdit], [laptopEdit]).merged[0];
  const onLaptopResult = planMerge([laptopEdit], [desktopEdit]).merged[0];

  check(
    'two devices resolve the same conflict identically',
    JSON.stringify(onDesktopResult) === JSON.stringify(onLaptopResult),
  );
  check(
    'the later write wins',
    onDesktopResult.lastModified === laptopEdit.lastModified,
  );

  // --- 10. Deck counts stay derived ---------------------------------------
  const counted = recomputeCardCounts(desktop.decks, desktop.cards);
  const spanish = counted.find((d) => d.id === deck.id);
  check(
    'deck card counts are recomputed, not trusted',
    spanish.cardCount === desktop.cards.filter((c) => c.deckId === deck.id && !c.deleted).length,
  );

  // --- 11. A deleted card stays deleted -----------------------------------
  const doomed = desktop.cards.find((c) => c.deckId === bosnian.id);
  desktop.replaceCard(softDelete(doomed));
  await desktop.push();
  await laptop.pull();
  check(
    'a delete propagates instead of resurrecting',
    laptop.getCard(doomed.id)?.deleted === true,
  );

  // --- 12. Isolation between accounts -------------------------------------
  const intruder = await get('/api/sync', 'someone-else');
  check(
    'another account sees none of this data',
    intruder.decks.length === 0 && intruder.cards.length === 0,
  );
}

// ---------------------------------------------------------------------------
// A stand-in for one installed copy of the app.

class Device {
  constructor(name) {
    this.name = name;
    this.decks = [];
    this.cards = [];
    this.online = true;
    this.lastPush = null;
    this.lastPulledAt = undefined;
  }

  getCard(id) {
    return this.cards.find((card) => card.id === id);
  }

  replaceCard(card) {
    const index = this.cards.findIndex((existing) => existing.id === card.id);
    if (index === -1) this.cards.push(card);
    else this.cards[index] = card;
  }

  pending() {
    return {
      decks: this.decks.filter((deck) => deck.syncStatus === 'pending'),
      cards: this.cards.filter((card) => card.syncStatus === 'pending'),
    };
  }

  async push() {
    if (!this.online) throw new Error(`${this.name} is offline`);
    const { decks, cards } = this.pending();
    this.lastPush = await post('/api/sync', JSON.stringify({ decks, cards }), {
      'content-type': 'application/json',
    });
    // Mirrors Repository.markSynced: only clear records that did not change
    // while the request was in flight.
    for (const deck of decks) deck.syncStatus = 'synced';
    for (const card of cards) card.syncStatus = 'synced';
    return this.lastPush;
  }

  async pull() {
    if (!this.online) throw new Error(`${this.name} is offline`);
    const remote = await get('/api/sync');

    const deckPlan = planMerge(this.decks, remote.decks);
    const cardPlan = planMerge(this.cards, remote.cards);
    this.decks = deckPlan.merged;
    this.cards = cardPlan.merged;
    this.lastPulledAt = remote.serverTime;
    return { deckPlan, cardPlan };
  }
}

// ---------------------------------------------------------------------------

async function startServer() {
  const config = loadConfig({ FLUENTFLOW_MODE: 'local', PORT: '0' });
  const app = createApp({ config, store: new MemoryStore() });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return server;
}

async function get(path, user = USER) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer local:${user}` },
  });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return response.json();
}

async function post(path, body, headers, user = USER) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer local:${user}`, ...headers },
    body,
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`POST ${path} -> ${response.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function check(description, passed, detail) {
  checks.push({ description, passed: Boolean(passed), detail });
  const mark = passed ? '✓' : '✗';
  const suffix = detail ? `  (${detail})` : '';
  console.log(`  ${mark} ${description}${suffix}`);
}

function report() {
  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);

  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const entry of failed) console.log(`  - ${entry.description}`);
    process.exit(1);
  }
}

console.log('\nFluentFlow end-to-end verification\n');
main().catch((error) => {
  console.error('\nVerification could not complete:', error);
  process.exit(1);
});
