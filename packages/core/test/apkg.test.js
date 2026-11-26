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
/** Learning cards store `due` as epoch seconds; ten minutes from NOW. */
const EPOCH_SOON = Math.floor(NOW.getTime() / 1000) + 600;
const base = { open: openWithNodeSqlite, userId: 'user-1', now: NOW };

test('imports a 60-card schema-11 deck and preserves its Anki scheduling', async () => {
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
  assert.equal(mature.phase, 'review', 'a graduated card must not restart in learning');

  const young = result.cards.find((c) => c.interval === 5);
  assert.equal(young.easeFactor, 2.3);
  assert.equal(young.status, 'learning');

  const brandNew = result.cards.find((c) => c.status === 'new');
  assert.equal(brandNew.interval, 0);
  assert.equal(brandNew.easeFactor, 2.5, 'ease 0 in Anki means "never reviewed"');
  assert.equal(brandNew.nextReview, NOW.toISOString(), 'new cards are due now');
});

test('the four Anki card types import as the four scheduling phases', async () => {
  const apkg = buildApkg({
    schema: 18,
    decks: ['Spanish A1'],
    fieldNames: ['Front', 'Back'],
    notes: [
      { fields: ['nuevo', 'new'], type: 0 },
      // A learning card on its last step, due in ten minutes.
      { fields: ['aprender', 'to learn'], type: 1, due: EPOCH_SOON, ivl: -600, left: 1001, reps: 1 },
      { fields: ['hablar', 'to speak'], type: 2, ivl: 30, factor: 2400, due: 300, reps: 8, lapses: 2 },
      { fields: ['olvidar', 'to forget'], type: 3, ivl: 4, factor: 2100, due: EPOCH_SOON, reps: 12, lapses: 5 },
    ],
  });

  const result = await parseApkg(apkg, { ...base, language: 'es' });
  const byFront = new Map(result.cards.map((c) => [c.front, c]));

  assert.equal(byFront.get('nuevo').phase, 'new');
  assert.equal(byFront.get('aprender').phase, 'learning');
  assert.equal(byFront.get('aprender').learningStep, 1, 'one step left means the last step');
  assert.equal(byFront.get('aprender').interval, 0, 'a sub-day interval is not a day interval');

  const review = byFront.get('hablar');
  assert.equal(review.phase, 'review');
  assert.equal(review.lapses, 2, "Anki's lapse count drives leech detection here too");
  assert.equal(review.repetitions, 8, 'reps is Anki reps, not a consecutive-success count');
  assert.equal(review.status, 'mastered');

  const relearning = byFront.get('olvidar');
  assert.equal(relearning.phase, 'relearning');
  assert.equal(relearning.learningStep, 0);
  assert.equal(relearning.interval, 4, 'the interval waiting after relearning is preserved');
  assert.equal(relearning.status, 'learning');
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

test('a sentence deck maps Sentence to the front and keeps Anki\'s new-card order', async () => {
  // The field layout of AnkiWeb's "Bosnian Sentences" deck (1159030937).
  const fieldNames = [
    'Sentence', 'Sentence (English)', 'Sentence (Search Field)', 'Language Code', 'Language', '[1]', '[2]',
  ];
  const sentence = (bs, en) => [bs, en, bs, 'bs', 'Serbo-Croatian', '', ''];
  const apkg = buildApkg({
    schema: 11,
    decks: ['Bosnian Sentences'],
    noteTypeName: 'Sentences',
    fieldNames,
    // Stored out of order: Anki's new-card position, not the note id, is the
    // easiest-to-hardest order the deck was published in.
    notes: [
      { fields: sentence('Gdje je najbliža apoteka?', 'Where is the nearest pharmacy?'), due: 2 },
      { fields: sentence('Baš ti hvala.', 'Thank you very much.'), due: 0 },
      { fields: sentence('Idem.', "I'm going."), due: 1 },
      {
        fields: [
          'Ovo je samo početak. <br> To je samo početak.', 'This is just the beginning.',
          'Ovo je samo početak.  /  To je samo početak.', 'bs', 'Serbo-Croatian', '', '',
        ],
        due: 3,
      },
    ],
  });

  const { cards, decks, summary } = await parseApkg(apkg, base);

  assert.deepEqual(summary.positionalNoteTypes, []);
  assert.equal(decks[0].language, 'bs');
  assert.deepEqual(
    cards.map((card) => [card.front, card.back]),
    [
      ['Baš ti hvala.', 'Thank you very much.'],
      ['Idem.', "I'm going."],
      ['Gdje je najbliža apoteka?', 'Where is the nearest pharmacy?'],
      // Alternative phrasings stay apart rather than reading as one sentence.
      ['Ovo je samo početak. / To je samo početak.', 'This is just the beginning.'],
    ],
  );
  // The search-field copy of the sentence is not an example of itself.
  assert.ok(cards.every((card) => card.examples.length === 0));
  // The sentence already is the example, so the deck does not ask for more.
  assert.equal(decks[0].showExamples, false);
});

test('vocabulary decks with an example Sentence field keep the word on the front', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish'],
    fieldNames: ['Word', 'Meaning', 'Sentence'],
    notes: [{ fields: ['hablar', 'to speak', 'Ella habla español.'] }],
  });

  const { cards, decks } = await parseApkg(apkg, base);

  assert.equal(cards[0].front, 'hablar');
  assert.deepEqual(cards[0].examples, ['Ella habla español.']);
  assert.equal(decks[0].showExamples, true);
});

test('a chosen deck name puts every card in one new deck of that name', async () => {
  const apkg = buildApkg({
    schema: 18,
    decks: ['Bosnian', 'Bosnian::Level 2'],
    fieldNames: ['Front', 'Back'],
    notes: [
      { fields: ['kuća', 'house'] },
      { fields: ['voda', 'water'], deck: 'Bosnian::Level 2' },
    ],
  });

  const plain = await parseApkg(apkg, base);
  const named = await parseApkg(apkg, { ...base, deckName: '  Bosnian sentences ' });

  assert.equal(named.decks.length, 1);
  assert.equal(named.decks[0].name, 'Bosnian sentences');
  assert.equal(named.decks[0].language, 'bs');
  assert.ok(named.cards.every((card) => card.deckId === named.decks[0].id));
  // A different name is a different deck, never the one called "Bosnian".
  assert.ok(!plain.decks.some((deck) => deck.id === named.decks[0].id));
});

/** The note type of a Tatoeba-built cloze deck, as AnkiWeb ships it. */
const TATOEBA_FIELDS = [
  'EnglishSentenceID', 'SpanishSentenceID', 'EnglishSentence', 'SpanishSentence', 'ClozeWord',
  'Difficulty', 'Text', 'Audio', 'NumberOfSpanishWords', 'Extra', 'Other',
];

function tatoebaNote(english, spanish, cloze, sound, difficulty = '10', due = 0) {
  return {
    due,
    fields: [
      '2528426', '2760065', english, spanish, cloze, difficulty,
      spanish.replace(cloze, `{{c1::${cloze}}}`), sound ? `[sound:${sound}]` : '', '4', '', '',
    ],
  };
}

test('a Tatoeba deck reads its Spanish sentence (not the ID or cloze word), easiest first', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish sentences'],
    fieldNames: TATOEBA_FIELDS,
    sortIndex: 5,
    // The stored new-card order is stale: the hardest sentence sits first.
    notes: [
      tatoebaNote('There were several accidents.', 'Hubo varios accidentes.', 'accidentes', '', '42084', 1),
      tatoebaNote('It is what it is.', 'Es lo que es.', 'lo', '', '10', 2),
      tatoebaNote('And why not?', '¿Y por qué no?', 'qué', '', '13', 3),
    ],
  });

  const { cards, decks, summary } = await parseApkg(apkg, base);

  // Easiest first, by the deck's own Difficulty field.
  assert.deepEqual(cards.map((card) => [card.front, card.back]), [
    ['Es lo que es.', 'It is what it is.'],
    ['¿Y por qué no?', 'And why not?'],
    ['Hubo varios accidentes.', 'There were several accidents.'],
  ]);
  assert.equal(decks[0].language, 'es');
  assert.deepEqual(summary.positionalNoteTypes, []);
});

test('recordings of the front come back on request, keyed by the card they read', async () => {
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 1, 2, 3]);
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish sentences'],
    fieldNames: TATOEBA_FIELDS,
    notes: [
      tatoebaNote('It is what it is.', 'Es lo que es.', 'lo', 'arh 1.mp3'),
      tatoebaNote('And why not?', '¿Y por qué no?', 'qué', 'missing.mp3'),
      tatoebaNote('Sit down.', 'Siéntate.', 'Siéntate'),
    ],
    media: { 'arh 1.mp3': mp3 },
  });

  const asked = await parseApkg(apkg, { ...base, recordings: true });
  assert.equal(asked.summary.recordingsFound, 1);
  assert.equal(asked.recordings.length, 1);
  assert.equal(asked.recordings[0].text, 'Es lo que es.');
  assert.equal(asked.recordings[0].language, 'es');
  assert.deepEqual([...asked.recordings[0].audio], [...mp3]);

  // Not asked for, the audio is left in the archive.
  const plain = await parseApkg(apkg, base);
  assert.equal(plain.recordings, undefined);
  assert.equal(plain.summary.recordingsFound, 1);
});

test('a word deck uses the word recording, not the example sentence one', async () => {
  const apkg = buildApkg({
    schema: 11,
    decks: ['Spanish'],
    fieldNames: ['Word', 'Meaning', 'Sentence', 'Sentence Audio', 'Word Audio'],
    notes: [{ fields: ['hablar', 'to speak', 'Ella habla.', '[sound:s.mp3]', '[sound:w.mp3]'] }],
    media: { 's.mp3': strToU8('sentence'), 'w.mp3': strToU8('word') },
  });

  const { recordings } = await parseApkg(apkg, { ...base, recordings: true });
  assert.equal(recordings.length, 1);
  assert.equal(new TextDecoder().decode(recordings[0].audio), 'word');
});
