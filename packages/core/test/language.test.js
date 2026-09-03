import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, stripHtml, splitExamples, mapFields, uuid, stableId } from '../dist/index.js';

test('a deck name that says the language is taken at its word', () => {
  for (const name of ['Spanish A1', 'Español – Verbos', 'Castellano Basico', '5000 Spanish Words']) {
    assert.equal(detectLanguage(name).language, 'es', name);
    assert.equal(detectLanguage(name).confidence, 'high', name);
  }

  for (const name of ['Bosnian Vocabulary', 'Bosanski jezik', 'Bosnia Travel Phrases']) {
    assert.equal(detectLanguage(name).language, 'bs', name);
  }
});

test('a locale tag in the deck name is a medium-confidence signal', () => {
  const result = detectLanguage('Core 2k [es-MX]');

  assert.equal(result.language, 'es');
  assert.equal(result.confidence, 'medium');
  assert.match(result.reason, /language tag/);
});

test('card text decides when the deck name says nothing', () => {
  const spanish = detectLanguage('Mi mazo', 'la niña pequeña ¿qué es esto? el corazón');
  assert.equal(spanish.language, 'es');
  assert.equal(spanish.confidence, 'medium');

  const bosnian = detectLanguage('Moj špil', 'čitam knjigu, šta radiš, đak');
  assert.equal(bosnian.language, 'bs');
});

test('with no signal at all the caller-supplied default is used', () => {
  const result = detectLanguage('Deck 1', '', 'bs');

  assert.equal(result.language, 'bs');
  assert.equal(result.confidence, 'low');
});

test('the deck name outranks the card text', () => {
  // A Spanish-named deck full of English glosses is still a Spanish deck.
  const result = detectLanguage('Spanish Vocabulary', 'the house, the book, to speak');

  assert.equal(result.language, 'es');
  assert.equal(result.confidence, 'high');
});

test('stripHtml flattens Anki field markup to one readable line', () => {
  assert.equal(stripHtml('<div>hola</div><div>mundo</div>'), 'hola mundo');
  assert.equal(stripHtml('a&nbsp;b &amp; c &#233;'), 'a b & c é');
  assert.equal(stripHtml('word[sound:x.mp3]<img src="y.png">'), 'word');
  assert.equal(stripHtml('<style>p{color:red}</style>text'), 'text');
  assert.equal(stripHtml('{{c1::hidden::hint}}'), 'hidden');
  assert.equal(stripHtml(''), '');
});

test('example fields split on line breaks, then on sentence boundaries', () => {
  assert.deepEqual(
    splitExamples('<div>Una frase.</div><div>Otra frase.</div>'),
    ['Una frase.', 'Otra frase.'],
  );
  assert.deepEqual(
    splitExamples('Primera frase aqui. Segunda frase aqui.'),
    ['Primera frase aqui.', 'Segunda frase aqui.'],
  );
  assert.deepEqual(splitExamples('- Con vinetas\n- Y otra mas'), ['Con vinetas', 'Y otra mas']);
  assert.deepEqual(splitExamples(''), []);
  // Never more than three, however many the field holds.
  assert.equal(splitExamples('A uno. B dos. C tres. D cuatro.').length, 3);
});

test('field mapping prefers names, then the sort field, then position', () => {
  assert.deepEqual(
    mapFields([
      { ord: 0, name: 'Expression' },
      { ord: 1, name: 'Meaning' },
      { ord: 2, name: 'Example Sentence' },
    ]),
    { frontIndex: 0, backIndex: 1, exampleIndex: 2, positional: false },
  );

  // Reversed layout: the names still win over the order.
  assert.deepEqual(
    mapFields([
      { ord: 0, name: 'Translation' },
      { ord: 1, name: 'Word' },
    ]),
    { frontIndex: 1, backIndex: 0, exampleIndex: null, positional: false },
  );

  // Nothing recognisable: fall back to the sort field and the next free slot.
  assert.deepEqual(
    mapFields([{ ord: 0, name: 'A' }, { ord: 1, name: 'B' }, { ord: 2, name: 'C' }], 1),
    { frontIndex: 1, backIndex: 0, exampleIndex: null, positional: true },
  );
});

test('uuid produces well-formed, unique v4 identifiers', () => {
  const ids = new Set(Array.from({ length: 500 }, uuid));

  assert.equal(ids.size, 500);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('stableId is deterministic, UUID-shaped and input-sensitive', () => {
  assert.equal(stableId('card', 'u1', 'Spanish', 42), stableId('card', 'u1', 'Spanish', 42));
  assert.notEqual(stableId('card', 'u1', 'Spanish', 42), stableId('card', 'u2', 'Spanish', 42));
  assert.notEqual(stableId('card', 'u1', 'Spanish', 42), stableId('deck', 'u1', 'Spanish', 42));
  assert.match(
    stableId('card', 'u1', 'Spanish', 42),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  // Distinct across a realistically sized collection.
  const ids = new Set(Array.from({ length: 5000 }, (_, i) => stableId('card', 'u1', 'Deck', i)));
  assert.equal(ids.size, 5000);
});
