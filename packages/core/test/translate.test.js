import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTranslatePrompt,
  parseTranslation,
  translateWords,
  meaningsFrom,
  decode,
  shapeFromConfig,
} from '../dist/index.js';

/**
 * Word translation.
 *
 * The cases below are not invented: every rejected shape is one a real
 * Qwen2.5 run produced while this was being built.
 */

test('the prompt carries few-shot pairs in the family template', () => {
  const prompt = buildTranslatePrompt('empapar', 'es', 'qwen');

  assert.match(prompt, /<\|im_start\|>system/);
  assert.match(prompt, /Spanish-English dictionary/);
  assert.match(prompt, /hablar[\s\S]*to speak/);
  // It ends mid-turn, which is what makes the model answer rather than continue.
  assert.match(prompt, /<\|im_start\|>assistant\n$/);
  assert.match(prompt, /empapar/);
});

test('each family gets its own template, and Bosnian its own examples', () => {
  assert.match(buildTranslatePrompt('kuća', 'bs', 'tinyllama'), /<\|system\|>/);
  assert.match(buildTranslatePrompt('kuća', 'bs', 'qwen'), /Bosnian-English/);
  assert.match(buildTranslatePrompt('kuća', 'bs', 'qwen'), /govoriti/);
  assert.match(buildTranslatePrompt('kuća', 'bs', 'raw'), /^You are a Bosnian-English/);
});

test('a plain answer is taken as it is', () => {
  const result = parseTranslation('to soak', 'empapar');

  assert.equal(result.meaning, 'to soak');
  assert.equal(result.needsReview, true);
  assert.equal(result.rejected, undefined);
});

test('the decoration small models add is stripped', () => {
  assert.equal(parseTranslation('"to soak"', 'empapar').meaning, 'to soak');
  assert.equal(parseTranslation('«nest»', 'nido').meaning, 'nest');
  assert.equal(parseTranslation('empapar: to soak', 'empapar').meaning, 'to soak');
  assert.equal(parseTranslation('nido = nest', 'nido').meaning, 'nest');
  assert.equal(parseTranslation('  octopus  \nand also a dish', 'pulpo').meaning, 'octopus');
});

test('an explanation is not a translation', () => {
  // Observed verbatim from the 0.5B model.
  const result = parseTranslation('The Spanish word "empapar" translates to "to spread".', 'empapar');

  assert.equal(result.meaning, '');
  assert.equal(result.rejected, 'a-sentence');
});

test('an answer that repeats the word is rejected', () => {
  assert.equal(parseTranslation('empapar', 'empapar').rejected, 'echoed-the-word');
  assert.equal(parseTranslation('empapar means soak', 'empapar').rejected, 'echoed-the-word');
});

test('an empty or unknown answer is rejected rather than guessed at', () => {
  assert.equal(parseTranslation('', 'nido').rejected, 'empty');
  assert.equal(parseTranslation('   ', 'nido').rejected, 'empty');
  assert.equal(parseTranslation('?', 'lodazal').rejected, 'unknown');
});

test('an answer with no Latin letters is not an English translation', () => {
  assert.equal(parseTranslation('。。。', 'nido').rejected, 'not-english');
});

test('every generated meaning is marked for review, including good ones', () => {
  // The whole design rests on this: nothing the model says is trusted enough
  // to become a card without a person seeing it.
  for (const answer of ['to soak', 'nest', 'octopus']) {
    assert.equal(parseTranslation(answer, 'x').needsReview, true);
  }
});

test('a list is translated word by word, and progress is reported', () => {
  const seen = [];
  const progress = [];

  return translateWords(['nido', 'pulpo'], 'es', {
    infer: async ({ prompt }) => {
      seen.push(prompt);
      return prompt.includes('nido') ? 'nest' : 'octopus';
    },
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  }).then((results) => {
    assert.equal(seen.length, 2, 'one request per word, never a batch');
    assert.deepEqual(results.map((r) => r.meaning), ['nest', 'octopus']);
    assert.deepEqual(progress, ['1/2', '2/2']);
    assert.deepEqual(meaningsFrom(results), { nido: 'nest', pulpo: 'octopus' });
  });
});

test('a word whose inference throws does not take the rest of the list with it', async () => {
  const results = await translateWords(['nido', 'boom', 'pulpo'], 'es', {
    infer: async ({ prompt }) => {
      if (prompt.includes('boom')) throw new Error('the runtime fell over');
      return prompt.includes('nido') ? 'nest' : 'octopus';
    },
  });

  assert.deepEqual(results.map((r) => r.meaning), ['nest', '', 'octopus']);
  assert.deepEqual(meaningsFrom(results), { nido: 'nest', pulpo: 'octopus' });
});

test('the budget is a deadline for the list, and what is done is kept', async () => {
  let clock = 0;
  const results = await translateWords(['a', 'b', 'c'], 'es', {
    infer: async () => {
      clock += 400;
      return 'something';
    },
    budgetMs: 700,
    now: () => clock,
  });

  // Two ran; the third was past the deadline and comes back empty rather than
  // throwing away the two that succeeded.
  assert.deepEqual(results.map((r) => Boolean(r.meaning)), [true, true, false]);
});

test('shapeFromConfig reads the KV geometry, not the attention geometry', () => {
  // Qwen2.5-0.5B: 14 attention heads, 2 KV heads. Using 14 works for exactly
  // one token and then fails on a shape mismatch.
  const shape = shapeFromConfig({
    num_hidden_layers: 24,
    num_attention_heads: 14,
    num_key_value_heads: 2,
    hidden_size: 896,
  });

  assert.deepEqual(shape, { numLayers: 24, numKeyValueHeads: 2, headDim: 64 });
});

test('a config without the fields that decide the cache shape is an error', () => {
  assert.throws(() => shapeFromConfig({ num_hidden_layers: 24 }), /num_attention_heads/);
});

test('decode feeds the cache forward and stops on the eos token', async () => {
  const shape = { numLayers: 1, numKeyValueHeads: 1, headDim: 2 };
  const tokenizer = {
    eosId: 99,
    encode: () => [1, 2, 3],
    decode: (ids) => ids.map((id) => `t${id}`).join(''),
  };

  const runtime = { Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } } };
  const calls = [];
  // Emits token 7, then 8, then the eos.
  const script = [7, 8, 99];
  const session = {
    inputNames: ['input_ids', 'attention_mask', 'position_ids', 'past_key_values.0.key', 'past_key_values.0.value'],
    run: async (feeds) => {
      calls.push(feeds);
      const next = script[calls.length - 1];
      const logits = new Array(100).fill(0);
      logits[next] = 10;
      return {
        logits: { data: logits, dims: [1, 1, 100] },
        'present.0.key': { data: new Float32Array(2), dims: [1, 1, calls.length, 2] },
        'present.0.value': { data: new Float32Array(2), dims: [1, 1, calls.length, 2] },
      };
    },
  };

  const text = await decode(runtime, session, tokenizer, shape, {
    prompt: 'anything', stop: [], maxTokens: 10,
  });

  assert.equal(text, 't7t8');
  assert.equal(calls.length, 3);
  // The prompt goes in whole, then one token at a time — that is the cache working.
  assert.equal(calls[0].input_ids.dims[1], 3);
  assert.equal(calls[1].input_ids.dims[1], 1);
  // The attention mask covers prompt plus everything generated so far.
  assert.equal(calls[1].attention_mask.dims[1], 4);
  // Last step's present became this step's past.
  assert.equal(calls[1]['past_key_values.0.key'].dims[2], 1);
});

/**
 * A one-step decode over a fixed logit row, so what the sampler picks is the
 * only thing under test.
 */
async function pickOnce(logits, request) {
  const shape = { numLayers: 0, numKeyValueHeads: 1, headDim: 2 };
  const tokenizer = { eosId: -1, encode: () => [1], decode: (ids) => ids.join(',') };
  const runtime = { Tensor: class { constructor(t, d, dims) { this.data = d; this.dims = dims; } } };
  const session = {
    inputNames: ['input_ids', 'attention_mask'],
    run: async () => ({ logits: { data: logits, dims: [1, 1, logits.length] } }),
  };

  return decode(runtime, session, tokenizer, shape, {
    prompt: 'x',
    stop: [],
    maxTokens: 1,
    ...request,
  });
}

test('decoding is greedy by default, which is what a translation needs', async () => {
  const logits = [1, 5, 2, 9, 3];
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(await pickOnce(logits), '3', 'the highest-scoring token, every time');
  }
});

test('sampling can return something other than the top token', async () => {
  // Two near-equal front runners: greedy can only ever answer 3.
  const logits = [0, 0, 0, 10, 9.9];
  const seen = new Set();
  for (let seed = 0; seed < 30; seed++) {
    seen.add(await pickOnce(logits, { temperature: 0.8, topK: 40, seed }));
  }

  assert.deepEqual([...seen].sort(), ['3', '4']);
});

test('a seeded sample is reproducible, so a decode can be repeated', async () => {
  const logits = [1, 8, 3, 8.2, 7.5, 2];
  const first = await pickOnce(logits, { temperature: 1, seed: 12345 });
  const again = await pickOnce(logits, { temperature: 1, seed: 12345 });

  assert.equal(first, again);
});

test('top-k keeps the sampler away from the tail of the vocabulary', async () => {
  // One plausible token and a long tail of noise. With topK: 1 the tail must
  // never be reachable, however many times it is asked.
  const logits = new Array(500).fill(0.1);
  logits[42] = 12;

  for (let seed = 0; seed < 40; seed++) {
    assert.equal(await pickOnce(logits, { temperature: 2, topK: 1, seed }), '42');
  }
});

test('decode trims a stop sequence out of the text', async () => {
  const shape = { numLayers: 0, numKeyValueHeads: 1, headDim: 2 };
  const tokenizer = { eosId: -1, encode: () => [1], decode: (ids) => ids.map((i) => (i === 5 ? 'nest' : '\nmore')).join('') };
  const runtime = { Tensor: class { constructor(t, d, dims) { this.data = d; this.dims = dims; } } };
  const script = [5, 6];
  let step = 0;
  const session = {
    inputNames: ['input_ids', 'attention_mask'],
    run: async () => {
      const logits = new Array(10).fill(0);
      logits[script[step++]] = 10;
      return { logits: { data: logits, dims: [1, 1, 10] } };
    },
  };

  const text = await decode(runtime, session, tokenizer, shape, {
    prompt: 'x', stop: ['\n'], maxTokens: 5,
  });

  assert.equal(text, 'nest');
});
