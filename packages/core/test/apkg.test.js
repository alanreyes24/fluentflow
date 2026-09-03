import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseApkg, ApkgError, MASTERED_INTERVAL_DAYS } from '../dist/index.js';
import {
  buildApkg,
  openWithNodeSqlite,
  openWithoutCollationRepair,
  spanishNotes,
  CRT,
} from './helpers/anki-fixture.js';

const NOW = new Date('2024-09-03T10:00:00.000Z');
const base = { open: openWithNodeSqlite, userId: 'user-1', now: NOW };

test('imports a 60-card schema-11 deck and preserves SM-2 scheduling', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back', 'Example'],
    notes: spanishNotes(60),
  });

  const result = await parseApkg(apkg, { ...base, filename: 'Spanish A1.apkg' });

  assert.equal(result.summary.schema, 11);
  assert.equal(result.summary.collectionFile, 'collection.anki2');
  assert.equal(result.summary.notesRead, 60);
  assert.equal(result.cards.length, 60);
  assert.equal(result.decks.length, 1);
  assert.equal(result.decks[0].cardCount, 60);
  assert.equal(result.decks[0].language, 'es');
  assert.equal(result.summary.detection.confidence, 'high');

  // Scheduling carried over from Anki, not reset to defaults.
  const mature = result.cards.find((c) => c.interval === 40);
  assert.ok(mature, 'a mature review card should survive the import');
  assert.equal(mature.easeFactor, 2.75, 'factor 2750 permille becomes ease 2.75');
  assert.equal(mature.status, 'mastered');
  assert.ok(mature.interval >= MASTERED_INTERVAL_DAYS);
  assert.ok(mature.repetitions >= 2, 'a graduated card must not restart the ladder');

  const young = result.cards.find((c) => c.interval === 5);
  assert.equal(young.easeFactor, 2.3);
  assert.equal(young.status, 'learning');

  const brandNew = result.cards.find((c) => c.status === 'new');
  assert.equal(brandNew.interval, 0);
  assert.equal(brandNew.easeFactor, 2.5, 'ease 0 in Anki means "never reviewed"');
  assert.equal(brandNew.nextReview, NOW.toISOString(), 'new cards are due now');
});

test('review due dates are rebuilt from the collection creation date', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    // due = 300 days after the collection was created
    notes: [{ fields: ['hablar', 'to speak'], type: 2, ivl: 30, factor: 2500, due: 300, reps: 8 }],
  });

  const { cards } = await parseApkg(apkg, base);

  assert.equal(cards.length, 1);
  assert.equal(cards[0].nextReview, new Date((CRT + 300 * 86400) * 1000).toISOString());
});

test('reads the modern schema-18 layout and ignores the downgrade stub', async () => {
  const apkg = buildApkg({
    schema: 18,
    decks: ['Bosanski::Glagoli', 'Bosanski::Imenice'],
    fieldNames: ['Word', 'Translation'],
    notes: [
      { fields: ['raditi', 'to work'], deck: 'Bosanski::Glagoli', type: 2, ivl: 12, factor: 2400, reps: 5 },
      { fields: ['knjiga', 'book'], deck: 'Bosanski::Imenice' },
    ],
  });

  const result = await parseApkg(apkg, { ...base, filename: 'Bosanski.apkg' });

  assert.equal(result.summary.schema, 18);
  assert.equal(result.summary.collectionFile, 'collection.anki21');
  assert.equal(result.cards.length, 2);
  assert.equal(result.summary.detection.language, 'bs');

  // Hierarchy is preserved, with the U+001F separator rendered back as `::`.
  const names = result.decks.map((d) => d.name).sort();
  assert.deepEqual(names, ['Bosanski::Glagoli', 'Bosanski::Imenice']);
  assert.ok(result.decks.every((d) => d.language === 'bs'));
});

test('flatten merges subdecks into a single deck', async () => {
  const apkg = buildApkg({
    schema: 18,
    decks: ['Spanish::Level 1', 'Spanish::Level 2'],
    fieldNames: ['Front', 'Back'],
    notes: [
      { fields: ['uno', 'one'], deck: 'Spanish::Level 1' },
      { fields: ['dos', 'two'], deck: 'Spanish::Level 2' },
    ],
  });

  const result = await parseApkg(apkg, { ...base, filename: 'Spanish Core.apkg', flatten: true });

  assert.equal(result.decks.length, 1);
  assert.equal(result.decks[0].name, 'Spanish Core');
  assert.equal(result.decks[0].cardCount, 2);
});

test('note types with unfamiliar field names fall back to field order', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Vocabulario'],
    noteTypeName: 'Custom Notetype',
    fieldNames: ['Campo A', 'Campo B'],
    notes: [{ fields: ['la ventana', 'the window'] }],
  });

  const result = await parseApkg(apkg, { ...base, language: 'es' });

  assert.deepEqual(result.summary.positionalNoteTypes, ['Custom Notetype']);
  assert.equal(result.cards[0].front, 'la ventana');
  assert.equal(result.cards[0].back, 'the window');
  assert.match(result.summary.warnings.join(' '), /Custom Notetype/);
});

test('named fields win over field order, and examples are split out', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish'],
    // Deliberately awkward order: the answer comes first.
    fieldNames: ['Meaning', 'Example Sentence', 'Word'],
    sortIndex: 2,
    notes: [
      {
        fields: [
          'to speak',
          '<div>Ella habla español.</div><div>Hablamos todos los días.</div>',
          'hablar',
        ],
      },
    ],
  });

  const { cards, summary } = await parseApkg(apkg, base);

  assert.deepEqual(summary.positionalNoteTypes, []);
  assert.equal(cards[0].front, 'hablar');
  assert.equal(cards[0].back, 'to speak');
  assert.deepEqual(cards[0].examples, ['Ella habla español.', 'Hablamos todos los días.']);
});

test('HTML, media tags and cloze markup are stripped from fields', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish'],
    fieldNames: ['Front', 'Back'],
    notes: [
      {
        fields: [
          '<div style="font-size:20px">el&nbsp;café</div>[sound:cafe.mp3]',
          '<b>the coffee</b><br><img src="cafe.jpg">',
        ],
      },
      { fields: ['{{c1::correr::verb}}', 'to run'] },
    ],
  });

  const { cards } = await parseApkg(apkg, base);
  const byBack = Object.fromEntries(cards.map((c) => [c.back, c.front]));

  assert.equal(byBack['the coffee'], 'el café');
  assert.equal(byBack['to run'], 'correr');
});

test('sibling cards from reverse templates collapse into one card', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish'],
    fieldNames: ['Front', 'Back'],
    notes: [
      { fields: ['gato', 'cat'], type: 2, ivl: 9, factor: 2500, reps: 4, extraTemplates: 1 },
      { fields: ['perro', 'dog'], extraTemplates: 2 },
    ],
  });

  const { cards, summary } = await parseApkg(apkg, base);

  assert.equal(cards.length, 2, 'one app card per note, not per Anki card');
  assert.equal(summary.siblingCardsMerged, 3);
  // Scheduling comes from the primary (ordinal 0) template.
  assert.equal(cards.find((c) => c.front === 'gato').interval, 9);
});

test('notes with an empty side are skipped and reported', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish'],
    fieldNames: ['Front', 'Back'],
    notes: [
      { fields: ['valido', 'valid'] },
      { fields: ['', 'orphan'] },
      { fields: ['huerfano', '   '] },
    ],
  });

  const { cards, summary } = await parseApkg(apkg, base);

  assert.equal(cards.length, 1);
  assert.equal(summary.cardsSkipped, 2);
  assert.match(summary.warnings.join(' '), /2 note\(s\) were skipped/);
});

test('importing the same file twice produces the same ids', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    notes: spanishNotes(12),
  });

  const first = await parseApkg(apkg, { ...base, filename: 'Spanish A1.apkg' });
  const second = await parseApkg(apkg, { ...base, filename: 'Spanish A1.apkg' });

  assert.deepEqual(first.cards.map((c) => c.id), second.cards.map((c) => c.id));
  assert.deepEqual(first.decks.map((d) => d.id), second.decks.map((d) => d.id));
  assert.equal(new Set(first.cards.map((c) => c.id)).size, first.cards.length, 'ids must be unique');
});

test('a different user importing the same file gets different ids', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    notes: spanishNotes(5),
  });

  const mine = await parseApkg(apkg, base);
  const theirs = await parseApkg(apkg, { ...base, userId: 'user-2' });

  assert.notEqual(mine.cards[0].id, theirs.cards[0].id);
});

test('an explicit language overrides detection', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    notes: [{ fields: ['kuca', 'house'] }],
  });

  const { decks, cards, summary } = await parseApkg(apkg, { ...base, language: 'bs' });

  assert.equal(decks[0].language, 'bs');
  assert.equal(cards[0].language, 'bs');
  assert.equal(summary.detection.reason, 'chosen by user');
});

test('a non-zip file is rejected with an actionable message', async () => {
  const junk = strToU8('this is definitely not an apkg');
  await assert.rejects(
    () => parseApkg(junk, base),
    (error) => {
      assert.ok(error instanceof ApkgError);
      assert.equal(error.code, 'NOT_A_ZIP');
      assert.match(error.message, /export it again from anki/i);
      return true;
    },
  );
});

test('the zstd-only export format is reported rather than silently failing', async () => {
  const apkg = zipSync({
    'collection.anki21b': strToU8('zstd payload'),
    media: strToU8('{}'),
  });

  await assert.rejects(
    () => parseApkg(apkg, base),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_ZSTD');
      assert.match(error.message, /Support older Anki versions/);
      return true;
    },
  );
});

test('a zip with no collection is rejected', async () => {
  const apkg = zipSync({ media: strToU8('{}'), 0: strToU8('audio') });

  await assert.rejects(() => parseApkg(apkg, base), { code: 'NO_COLLECTION' });
});

test('media files in the archive are counted', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish'],
    fieldNames: ['Front', 'Back'],
    notes: [{ fields: ['hola', 'hello'] }],
  });
  // Re-pack with two media blobs alongside the collection.
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(apkg);
  const withMedia = zipSync({ ...entries, 0: strToU8('mp3'), 1: strToU8('jpg') });

  const { summary } = await parseApkg(withMedia, base);
  assert.equal(summary.mediaCount, 2);
});

test('an opener that skips the collation repair degrades to positional mapping', async () => {
  const apkg = buildApkg({
    schema: 18,
    decks: ['Spanish'],
    fieldNames: ['Front', 'Back'],
    notes: [{ fields: ['la mesa', 'the table'] }],
  });

  const { cards, summary } = await parseApkg(apkg, {
    ...base,
    open: openWithoutCollationRepair,
    language: 'es',
  });

  // The `fields` table is unreadable without the repair, so field names are
  // lost — but the import still produces usable cards.
  assert.equal(cards.length, 1);
  assert.equal(cards[0].front, 'la mesa');
  assert.equal(cards[0].back, 'the table');
  assert.match(summary.warnings.join(' '), /mapped by position/);
});
