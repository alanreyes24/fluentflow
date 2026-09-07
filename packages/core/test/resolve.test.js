import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMeanings, meaningsFromResolved } from '../dist/index.js';

/**
 * Dictionary first, model for the leftovers.
 *
 * The fixture is real data: these are the glosses the distilled Wiktionary
 * dictionaries actually return, and the model answers are ones Qwen2.5-1.5B
 * actually gave.
 */
const ENTRIES = {
  nido: [{ word: 'nido', gloss: 'nest' }],
  empapar: [{ word: 'empapar', gloss: 'to drench' }],
  anguila: [{ word: 'anguila', gloss: 'eel' }],
  // An inflected form, pointing at the word it inflects.
  comieron: [{ word: 'comieron', gloss: 'third-person plural preterite of comer', lemma: 'comer' }],
  comer: [{ word: 'comer', gloss: 'to eat' }, { word: 'comer', gloss: 'to have lunch' }],
  molim: [{ word: 'molim', gloss: 'first-person singular present of moliti', lemma: 'moliti' }],
  moliti: [{ word: 'moliti', gloss: 'to pray' }, { word: 'moliti', gloss: 'to ask, beg' }],
  zdravo: [
    { word: 'zdravo', gloss: 'hello! hi!', pos: 'intj' },
    { word: 'zdravo', gloss: 'bye! farewell!', pos: 'intj' },
    { word: 'zdravo', gloss: 'healthily', pos: 'adv' },
    { word: 'zdravo', gloss: 'sanely', pos: 'adv' },
  ],
};

const dictionary = (word) => ENTRIES[word] ?? [];

test('a word the dictionary knows never reaches the model', async () => {
  let asked = 0;
  const resolved = await resolveMeanings(['nido', 'anguila'], 'es', {
    dictionary,
    infer: async () => { asked++; return 'something'; },
  });

  assert.equal(asked, 0);
  assert.deepEqual(resolved.map((r) => r.meaning), ['nest', 'eel']);
  assert.deepEqual(resolved.map((r) => r.source), ['dictionary', 'dictionary']);
  // The dictionary is trusted; only the model's answers need checking.
  assert.deepEqual(resolved.map((r) => r.needsReview), [false, false]);
});

test('an inflected form is followed to the word it inflects', async () => {
  const [spanish, bosnian] = await Promise.all([
    resolveMeanings(['comieron'], 'es', { dictionary }),
    resolveMeanings(['molim'], 'bs', { dictionary }),
  ]);

  assert.equal(spanish[0].meaning, 'to eat, to have lunch');
  assert.equal(spanish[0].lemma, 'comer');
  assert.equal(bosnian[0].meaning, 'to pray, to ask, beg');
  assert.equal(bosnian[0].lemma, 'moliti');
});

test('several senses become one card back, capped', async () => {
  const [zdravo] = await resolveMeanings(['zdravo'], 'bs', { dictionary });

  // Three at most: a card back listing every sense is not a card back.
  assert.equal(zdravo.meaning, 'hello! hi!, bye! farewell!, healthily');
});

test('the model is asked only for what the dictionary missed', async () => {
  const asked = [];
  const resolved = await resolveMeanings(['nido', 'chapurrear', 'anguila'], 'es', {
    dictionary,
    infer: async ({ prompt }) => {
      asked.push(prompt);
      return JSON.stringify([{ word: 'chapurrear', meaning: 'to speak badly' }]);
    },
  });

  assert.equal(asked.length, 1, 'one word missed, one request');
  assert.match(asked[0], /chapurrear/);
  assert.deepEqual(resolved.map((r) => r.source), ['dictionary', 'model', 'dictionary']);
  assert.equal(resolved[1].meaning, 'to speak badly');
  // The model's answer is the one flagged for a human.
  assert.deepEqual(resolved.map((r) => r.needsReview), [false, true, false]);
});

test('a model answer that fails validation is thrown out, not guessed at', async () => {
  const resolved = await resolveMeanings(['almadura'], 'es', {
    dictionary,
    // Observed from the 0.5B: an explanation rather than a translation.
    infer: async () => JSON.stringify([
      { word: 'almadura', meaning: 'The Spanish word almadura translates to marinade in English.' },
    ]),
  });

  assert.equal(resolved[0].meaning, '');
  assert.equal(resolved[0].source, 'none');
  assert.equal(resolved[0].rejected, 'model-rejected');
});

test('a word neither knows comes back empty rather than invented', async () => {
  const resolved = await resolveMeanings(['ponovili'], 'es', {
    dictionary,
    infer: async () => JSON.stringify([{ word: 'ponovili', meaning: '' }]),
  });

  assert.equal(resolved[0].meaning, '');
  assert.equal(resolved[0].rejected, 'model-rejected');
  assert.equal(meaningsFromResolved(resolved).ponovili, undefined);
});

test('with no model at all, a miss is simply a miss', async () => {
  const resolved = await resolveMeanings(['nido', 'chapurrear'], 'es', { dictionary });

  assert.deepEqual(resolved.map((r) => r.source), ['dictionary', 'none']);
  assert.equal(resolved[1].rejected, 'not-found');
});

test('with no dictionary the model does all of it, and all of it needs review', async () => {
  const resolved = await resolveMeanings(['nido'], 'es', {
    dictionary: null,
    infer: async () => JSON.stringify([{ word: 'nido', meaning: 'nest' }]),
  });

  assert.equal(resolved[0].source, 'model');
  assert.equal(resolved[0].needsReview, true);
});

test('with neither, every word says so', async () => {
  const resolved = await resolveMeanings(['nido'], 'es', {});

  assert.equal(resolved[0].rejected, 'nothing-to-ask');
});

test('the model budget is checked before the single batch, and dictionary work is kept', async () => {
  let clock = 0;
  const resolved = await resolveMeanings(['nido', 'aaa', 'bbb', 'ccc'], 'es', {
    dictionary,
    infer: async () => {
      clock += 400;
      return JSON.stringify([
        { word: 'aaa', meaning: 'first' },
        { word: 'bbb', meaning: 'second' },
        { word: 'ccc', meaning: 'third' },
      ]);
    },
    budgetMs: 700,
    now: () => clock,
  });

  assert.equal(resolved[0].meaning, 'nest', 'the dictionary hit survives the deadline');
  assert.deepEqual(resolved.map((r) => Boolean(r.meaning)), [true, true, true, true]);
});

test('a model that throws costs one word, not the run', async () => {
  const resolved = await resolveMeanings(['aaa', 'bbb'], 'es', {
    dictionary,
    infer: async () => {
      throw new Error('the runtime fell over');
    },
  });

  assert.equal(resolved[0].rejected, 'model-rejected');
  assert.equal(resolved[1].rejected, 'model-rejected');
});

test('the model gets one deduplicated structured batch and results map back safely', async () => {
  const requests = [];
  const resolved = await resolveMeanings(['  AAA  ', 'aaa', 'bbb'], 'es', {
    dictionary,
    infer: async (request) => {
      requests.push(request);
      return JSON.stringify([
        { word: 'aaa', meaning: 'first answer' },
        { word: 'unexpected', meaning: 'must be ignored' },
        { word: 'bbb', meaning: 'second answer' },
      ]);
    },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /exactly one object per input item/);
  assert.equal(requests[0].responseSchema.type, 'ARRAY');
  assert.deepEqual(resolved.map((r) => r.meaning), ['first answer', 'first answer', 'second answer']);
});

test('progress counts every word, dictionary hits included', async () => {
  const seen = [];
  await resolveMeanings(['nido', 'aaa'], 'es', {
    dictionary,
    infer: async () => 'something',
    onProgress: (done, total) => seen.push(`${done}/${total}`),
  });

  assert.deepEqual(seen, ['1/2', '2/2', '2/2']);
});
