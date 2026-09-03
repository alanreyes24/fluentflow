import test from 'node:test';
import assert from 'node:assert/strict';
import { BpeTokenizer, tokenizerDataFromHuggingFace, METASPACE } from '../dist/index.js';

/**
 * A miniature Llama-shaped vocabulary. Real TinyLlama has 32000 entries; this
 * one is small enough to reason about while keeping every structural feature
 * that matters: metaspace words, multi-step merges, and byte fallback.
 */
function buildTokenizer(overrides = {}) {
  const pieces = [
    '<unk>', '<s>', '</s>',
    METASPACE, 'h', 'o', 'l', 'a', 'm', 'u', 'n', 'd', 'c', 'i', 'e', 's', 'r', 'j', 'k', 'g',
    'ho', 'la', 'hola', `${METASPACE}hola`,
    'mu', 'ndo', 'mundo', `${METASPACE}mundo`,
    `${METASPACE}k`, 'nji', 'ga', 'knjiga',
  ];
  const vocab = Object.fromEntries(pieces.map((piece, index) => [piece, index]));

  // Byte-fallback tokens occupy the tail of the vocabulary, as in Llama.
  for (let byte = 0; byte < 256; byte++) {
    vocab[`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`] = pieces.length + byte;
  }

  const merges = [
    'h o', 'l a', 'ho la',
    `${METASPACE} hola`,
    'm u', 'n d', 'nd o', 'mu ndo',
    `${METASPACE} mundo`,
    `${METASPACE} k`, 'n j', 'nj i', 'g a', `${METASPACE}k nji`, `${METASPACE}knji ga`,
  ];

  return new BpeTokenizer({
    vocab,
    merges,
    metaspace: true,
    byteFallback: true,
    specialTokens: { bos: '<s>', eos: '</s>', unk: '<unk>' },
    ...overrides,
  });
}

test('a word is merged into its single vocabulary entry', () => {
  const tokenizer = buildTokenizer();

  assert.deepEqual(tokenizer.encode('hola'), [tokenizer.tokenId(`${METASPACE}hola`)]);
});

test('spaces become metaspace, and the sequence gets a leading one', () => {
  const tokenizer = buildTokenizer();
  const ids = tokenizer.encode('hola mundo');

  assert.deepEqual(ids, [
    tokenizer.tokenId(`${METASPACE}hola`),
    tokenizer.tokenId(`${METASPACE}mundo`),
  ]);
});

test('encode and decode round-trip', () => {
  const tokenizer = buildTokenizer();

  assert.equal(tokenizer.decode(tokenizer.encode('hola mundo')), 'hola mundo');
  assert.equal(tokenizer.decode(tokenizer.encode('knjiga')), 'knjiga');
});

test('BOS and EOS are added only when asked for', () => {
  const tokenizer = buildTokenizer();

  const plain = tokenizer.encode('hola');
  const wrapped = tokenizer.encode('hola', { addBos: true, addEos: true });

  assert.deepEqual(wrapped, [tokenizer.bosId, ...plain, tokenizer.eosId]);
  // Special tokens are dropped on the way back out.
  assert.equal(tokenizer.decode(wrapped), 'hola');
  // Keeping the special tokens also keeps the metaspace that precedes the word,
  // which is exactly what the reference Llama tokenizer produces.
  assert.equal(tokenizer.decode(wrapped, { skipSpecialTokens: false }), '<s> hola</s>');
});

test('characters outside the vocabulary fall back to byte tokens', () => {
  const tokenizer = buildTokenizer();

  // "ñ" is not a vocabulary entry; UTF-8 encodes it as two bytes.
  const ids = tokenizer.encode('ñ');
  const byteIds = [0xc3, 0xb1].map((b) =>
    tokenizer.tokenId(`<0x${b.toString(16).toUpperCase()}>`),
  );

  assert.ok(byteIds.every((id) => ids.includes(id)), 'both bytes must be present');
  assert.ok(!ids.includes(tokenizer.unkId), 'byte fallback replaces <unk>');
});

test('multi-byte characters decode back to the original text', () => {
  const tokenizer = buildTokenizer();

  for (const text of ['ñ', 'čćžšđ', 'año']) {
    assert.equal(tokenizer.decode(tokenizer.encode(text)), text, text);
  }
});

test('without byte fallback, unknown characters become unk', () => {
  const tokenizer = buildTokenizer({ byteFallback: false });

  // The leading metaspace is still a real vocabulary entry; only the unknown
  // character collapses to <unk>.
  assert.deepEqual(tokenizer.encode('ñ'), [tokenizer.tokenId(METASPACE), tokenizer.unkId]);
});

test('merge rank decides the order, not the order pairs are found', () => {
  // "ndo" only exists because "n d" merges before "nd o"; reversing the ranks
  // would produce a different, wrong segmentation.
  const tokenizer = buildTokenizer();
  const ids = tokenizer.encode('mundo');

  assert.deepEqual(ids, [tokenizer.tokenId(`${METASPACE}mundo`)]);
});

test('encoding is cached per word without changing the result', () => {
  const tokenizer = buildTokenizer();

  const first = tokenizer.encode('hola mundo hola');
  const second = tokenizer.encode('hola mundo hola');

  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
});

test('a Hugging Face tokenizer.json is read into the expected shape', () => {
  const data = tokenizerDataFromHuggingFace({
    model: {
      vocab: { '<unk>': 0, '<s>': 1, '</s>': 2, [METASPACE]: 3, h: 4, o: 5 },
      // Newer files store merges as pairs rather than space-joined strings.
      merges: [['h', 'o'], 'o h'],
      byte_fallback: true,
    },
    added_tokens: [
      { content: '<unk>', id: 0, special: true },
      { content: '<s>', id: 1, special: true },
      { content: '</s>', id: 2, special: true },
      { content: '<|extra|>', id: 999, special: false },
    ],
  });

  assert.equal(data.merges[0], 'h o');
  assert.equal(data.specialTokens.bos, '<s>');
  assert.equal(data.specialTokens.eos, '</s>');
  assert.equal(data.byteFallback, true);
  assert.equal(data.vocab['<|extra|>'], 999, 'added tokens join the vocabulary');

  const tokenizer = new BpeTokenizer(data);
  assert.equal(tokenizer.bosId, 1);
  assert.equal(tokenizer.eosId, 2);
});

test('an empty string encodes to nothing surprising', () => {
  const tokenizer = buildTokenizer();

  assert.deepEqual(tokenizer.encode(''), [tokenizer.tokenId(METASPACE)]);
  assert.deepEqual(tokenizer.encode('', { addBos: true }), [
    tokenizer.bosId,
    tokenizer.tokenId(METASPACE),
  ]);
});
