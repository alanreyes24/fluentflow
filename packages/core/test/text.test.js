import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextCards, buildTextImport } from '../dist/index.js';

const fronts = (result) => result.entries.map((entry) => entry.front);
const backs = (result) => result.entries.map((entry) => entry.back);

test('a tab-separated paste from a spreadsheet becomes cards', () => {
  const result = parseTextCards('hablar\tto speak\ncasa\thouse\nniño\tchild');

  assert.equal(result.format, 'delimited');
  assert.equal(result.separator, 'tab');
  assert.deepEqual(fronts(result), ['hablar', 'casa', 'niño']);
  assert.deepEqual(backs(result), ['to speak', 'house', 'child']);
  assert.equal(result.skippedCount, 0);
});

test('a dash list keeps punctuation that belongs to the meaning', () => {
  // The meaning contains both a comma and a hyphen. Splitting once on the
  // spaced dash is the only reading that does not lose half of it.
  const result = parseTextCards('casa - house, home\nbien-estar - well-being');

  assert.equal(result.separator, 'dash');
  assert.deepEqual(backs(result), ['house, home', 'well-being']);
});

test('a CSV keeps quoted commas and drops the heading row', () => {
  const result = parseTextCards('Word,Meaning\nhablar,"to speak, to talk"\ncasa,house');

  assert.equal(result.separator, 'comma');
  assert.equal(result.headerSkipped, true);
  assert.deepEqual(fronts(result), ['hablar', 'casa']);
  assert.equal(backs(result)[0], 'to speak, to talk');
});

test('a heading that names the meaning first swaps the columns', () => {
  const result = parseTextCards('English,Spanish\nto speak,hablar\nhouse,casa');

  assert.equal(result.headerSkipped, true);
  assert.deepEqual(fronts(result), ['hablar', 'casa']);
  assert.deepEqual(backs(result), ['to speak', 'house']);
  assert.match(result.warnings.join(' '), /swapped/);
});

test('swap: true reverses a list written meaning-first', () => {
  const result = parseTextCards('to speak - hablar', { swap: true });

  assert.deepEqual(fronts(result), ['hablar']);
  assert.deepEqual(backs(result), ['to speak']);
});

test('a Markdown table loses its empty edge columns', () => {
  const result = parseTextCards('| hablar | to speak |\n| casa | house |');

  assert.equal(result.separator, 'pipe');
  assert.deepEqual(fronts(result), ['hablar', 'casa']);
  assert.deepEqual(backs(result), ['to speak', 'house']);
});

test('extra columns are dropped rather than folded into the meaning', () => {
  // Anki's own CSV export puts tags in a third column.
  const result = parseTextCards('hablar\tto speak\tverb::a1\ncasa\thouse\tnoun');

  assert.deepEqual(backs(result), ['to speak', 'house']);
  assert.match(result.warnings.join(' '), /more than two columns/);
});

test('paragraphs separated by blank lines are one card each', () => {
  const result = parseTextCards('hablar\nto speak\n\ncasa\nhouse, home\nas in a building');

  assert.equal(result.format, 'blocks');
  assert.equal(result.separator, null);
  assert.deepEqual(fronts(result), ['hablar', 'casa']);
  assert.deepEqual(backs(result), ['to speak', 'house, home as in a building']);
});

test('a line with no meaning on it is skipped and reported, not guessed at', () => {
  const result = parseTextCards('hablar\tto speak\ncasa\nniño\tchild');

  assert.deepEqual(fronts(result), ['hablar', 'niño']);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(result.skipped, [{ line: 2, text: 'casa', reason: 'no-separator' }]);
});

test('the same word twice is imported once', () => {
  const result = parseTextCards('hablar - to speak\nHABLAR - to talk\nhablár - to say');

  assert.deepEqual(fronts(result), ['hablar']);
  assert.equal(result.duplicates, 2);
  assert.equal(result.skipped[0].reason, 'duplicate');
});

test('words already in the deck are reported as duplicates, not added again', () => {
  const result = parseTextCards('hablar - to speak\ncasa - house', {
    existingFronts: ['Hablar'],
  });

  assert.deepEqual(fronts(result), ['casa']);
  assert.equal(result.duplicates, 1);
});

test('comments, bullets and list numbering are not part of the card', () => {
  const result = parseTextCards('# my list\n1. hablar - to speak\n- casa - house\n// note');

  assert.deepEqual(fronts(result), ['hablar', 'casa']);
  assert.equal(result.linesRead, 2);
});

test('markup pasted from a web page is flattened', () => {
  const result = parseTextCards('<b>hablar</b>\tto&nbsp;speak');

  assert.deepEqual(fronts(result), ['hablar']);
  assert.deepEqual(backs(result), ['to speak']);
});

test('prose is skipped rather than turned into an unusable card', () => {
  const sentence = `${'word '.repeat(40)} - meaning`;
  const result = parseTextCards(`hablar - to speak\n${sentence}`);

  assert.deepEqual(fronts(result), ['hablar']);
  assert.equal(result.skipped[0].reason, 'too-long');
});

test('a paste is capped, and says so', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `word${i}\tmeaning${i}`).join('\n');
  const result = parseTextCards(lines, { maxCards: 10 });

  assert.equal(result.entries.length, 10);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.skipped[0].reason, 'over-limit');
  assert.match(result.warnings.join(' '), /Stopped at 10 cards/);
});

test('a large paste is accepted by the default limit', () => {
  const result = parseTextCards(
    Array.from({ length: 2700 }, (_, index) => `word-${index}`).join('\n'),
  );

  assert.equal(result.entries.length, 2700);
  assert.equal(result.skippedCount, 0);
  assert.doesNotMatch(result.warnings.join(' '), /Stopped at/);
});

test('an empty paste is empty, not an error', () => {
  const result = parseTextCards('   \n\n# only a comment\n');

  assert.equal(result.format, 'empty');
  assert.deepEqual(result.entries, []);
  assert.equal(result.linesRead, 0);
});

test('a forced separator overrides detection', () => {
  // Detection would read this as a dash list; the user says it is a colon list.
  const result = parseTextCards('a - b: c', { separator: 'colon' });

  assert.deepEqual(fronts(result), ['a - b']);
  assert.deepEqual(backs(result), ['c']);
});

test('buildTextImport creates a deck whose language comes from the words', () => {
  const result = buildTextImport('čitati\tto read\nšta\twhat\nđak\tpupil', {
    userId: 'u1',
    deckName: 'My list',
    now: new Date('2024-09-05T10:00:00.000Z'),
  });

  assert.equal(result.decks.length, 1);
  assert.equal(result.decks[0].name, 'My list');
  assert.equal(result.decks[0].language, 'bs');
  assert.equal(result.decks[0].cardCount, 3);
  assert.equal(result.cards.length, 3);
  assert.equal(result.cards[0].deckId, result.decks[0].id);
  assert.equal(result.cards[0].language, 'bs');
  assert.equal(result.cards[0].status, 'new');
  assert.equal(result.summary.cardsImported, 3);
  assert.equal(result.summary.detection.language, 'bs');
});

test('a chosen language wins over detection', () => {
  const result = buildTextImport('čitati\tto read', {
    userId: 'u1',
    deckName: 'My list',
    language: 'es',
  });

  assert.equal(result.decks[0].language, 'es');
  assert.equal(result.summary.detection.reason, 'chosen by user');
});

test('pasting the same list again maps onto the same cards', () => {
  const text = 'hablar\tto speak\ncasa\thouse';
  const options = { userId: 'u1', deckName: 'Spanish' };

  const first = buildTextImport(text, options);
  const second = buildTextImport(`${text}\nniño\tchild`, options);

  assert.deepEqual(
    second.cards.slice(0, 2).map((card) => card.id),
    first.cards.map((card) => card.id),
  );
  assert.equal(second.decks[0].id, first.decks[0].id);
});

test('adding to an existing deck creates no deck and follows its language', () => {
  const result = buildTextImport('hablar\tto speak', {
    userId: 'u1',
    deck: { id: 'deck-1', language: 'bs' },
  });

  assert.deepEqual(result.decks, []);
  assert.equal(result.cards[0].deckId, 'deck-1');
  assert.equal(result.cards[0].language, 'bs');
});

test('imported cards owe the server an upload', () => {
  const result = buildTextImport('hablar\tto speak', { userId: 'u1', deckName: 'Spanish' });

  assert.equal(result.cards[0].syncStatus, 'pending');
  assert.equal(result.decks[0].syncStatus, 'pending');
});

test('a bare word list is a list of words, not one enormous card', () => {
  // The paste that found this: twelve words, no separators, no blank lines.
  // Read as paragraphs it became a single card with eleven words on its back.
  const result = parseTextCards(
    'encestar\nindicadores\nnido\nvertido\ntambalearse\npulpo\nanguila\nlodazal\nempapar\nbrote',
  );

  assert.equal(result.format, 'words');
  assert.equal(result.entries.length, 10);
  assert.equal(result.needsMeaning, 10);
  assert.deepEqual(result.entries[0], { front: 'encestar', back: '', line: 1 });
  assert.equal(result.skippedCount, 0);
  assert.match(result.warnings.join(' '), /No meanings found/);
});

test('a paragraph longer than a card is not read as one', () => {
  const result = parseTextCards('one\ntwo\nthree\nfour\nfive\nsix');

  assert.equal(result.format, 'words');
  assert.equal(result.entries.length, 6);
});

test('two- and three-line paragraphs are still cards', () => {
  const result = parseTextCards('hablar\nto speak\n\ncasa\nhouse\na building');

  assert.equal(result.format, 'blocks');
  assert.deepEqual(result.entries.map((entry) => entry.front), ['hablar', 'casa']);
  assert.equal(result.needsMeaning, 0);
});

test('supplied meanings turn a word list into cards, and the rest are reported', () => {
  const result = buildTextImport('nido\nempapar\nlodazal', {
    userId: 'u1',
    deckName: 'Spanish',
    meanings: { nido: 'nest', empapar: 'to soak' },
  });

  assert.equal(result.cards.length, 2);
  assert.deepEqual(
    result.cards.map((card) => `${card.front}=${card.back}`),
    ['nido=nest', 'empapar=to soak'],
  );
  // A card with a blank back is not a card, so the third is not written.
  assert.equal(result.summary.withoutMeaning, 1);
  assert.equal(result.summary.cardsSkipped, 1);
});

test('a meaning in the paste beats one supplied for the same word', () => {
  const result = buildTextImport('nido - nest', {
    userId: 'u1',
    deckName: 'Spanish',
    meanings: { nido: 'WRONG' },
  });

  assert.equal(result.cards[0].back, 'nest');
});

test('model spelling corrections apply only to bare-word entries', () => {
  const corrected = buildTextImport('almadura', {
    userId: 'u1',
    deckName: 'Spanish',
    language: 'es',
    meanings: { almadura: 'armor' },
    correctedFronts: { almadura: 'armadura' },
  });
  const explicit = buildTextImport('mal escrito - supplied meaning', {
    userId: 'u1',
    deckName: 'Spanish',
    language: 'es',
    correctedFronts: { 'mal escrito': 'bien escrito' },
  });

  assert.equal(corrected.cards[0].front, 'armadura');
  assert.equal(explicit.cards[0].front, 'mal escrito');
});

test('dictionary infinitives apply even when the paste supplies a meaning', () => {
  const result = buildTextImport('comieron - they ate', {
    userId: 'u1',
    deckName: 'Spanish',
    language: 'es',
    normalizedFronts: { comieron: 'comer' },
  });

  assert.equal(result.cards[0].front, 'comer');
  assert.equal(result.cards[0].back, 'they ate');
});

test('an unchanged spelling wins when a correction creates a duplicate', () => {
  const result = buildTextImport('angila\nanguila', {
    userId: 'u1',
    deckName: 'Spanish',
    language: 'es',
    meanings: { angila: 'guessed eel', anguila: 'eel' },
    correctedFronts: { angila: 'anguila' },
  });

  assert.deepEqual(result.cards.map((card) => `${card.front}=${card.back}`), ['anguila=eel']);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.summary.cardsSkipped, 1);
});
