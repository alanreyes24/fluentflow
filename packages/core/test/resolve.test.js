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
  comer: [{ word: 'comer', gloss: 'to eat', pos: 'verb' }, { word: 'comer', gloss: 'to have lunch', pos: 'verb' }],
  molim: [{ word: 'molim', gloss: 'first-person singular present of moliti', lemma: 'moliti' }],
  moliti: [{ word: 'moliti', gloss: 'to pray', pos: 'verb' }, { word: 'moliti', gloss: 'to ask, beg', pos: 'verb' }],
  acordarse: [{ word: 'acordarse', gloss: '', lemma: 'acordar' }],
  acordar: [{ word: 'acordar', gloss: 'to agree', pos: 'verb' }],
  imanes: [{ word: 'imanes', gloss: '', lemma: 'imanar' }],
  imanar: [{ word: 'imanar', gloss: 'alternative form of imantar', pos: 'verb' }],
  imantar: [{ word: 'imantar', gloss: 'to magnetize', pos: 'verb' }],
  cacahuate: [{ word: 'cacahuate', gloss: 'alternative form of cacahuete (“peanut”)', pos: 'noun' }],
  cacahuete: [{ word: 'cacahuete', gloss: 'peanut', pos: 'noun' }],
  stići: [{ word: 'stići', gloss: 'alternative form of stȉgnuti' }],
  // Stress marks in pointer glosses are absent from the distilled headwords.
  stignuti: [{ word: 'stignuti', gloss: 'to arrive, reach', pos: 'verb' }],
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
  assert.equal(spanish[0].correctedWord, 'comer');
  assert.equal(bosnian[0].meaning, 'to pray, to ask, beg');
  assert.equal(bosnian[0].lemma, 'moliti');
  assert.equal(bosnian[0].correctedWord, 'moliti');
});

test('an alternate-form gloss is followed to its English meaning', async () => {
  const [resolved] = await resolveMeanings(['stići'], 'bs', { dictionary });

  assert.equal(resolved.meaning, 'to arrive, reach');
  assert.equal(resolved.lemma, 'stignuti');
  assert.equal(resolved.correctedWord, undefined);
  assert.equal(resolved.source, 'dictionary');
});

test('an infinitive stays unchanged even when the form table points elsewhere', async () => {
  const [resolved] = await resolveMeanings(['acordarse'], 'es', { dictionary });

  assert.equal(resolved.meaning, 'to agree');
  assert.equal(resolved.lemma, 'acordar');
  assert.equal(resolved.correctedWord, undefined);
});

test('an inflection can pass through one alternate-form pointer', async () => {
  const [resolved] = await resolveMeanings(['imanes'], 'es', { dictionary });

  assert.equal(resolved.meaning, 'to magnetize');
  assert.equal(resolved.lemma, 'imantar');
  assert.equal(resolved.correctedWord, 'imantar');
});

test('a translated hint in an alternate-form gloss is not part of its headword', async () => {
  const [resolved] = await resolveMeanings(['cacahuate'], 'es', { dictionary });

  assert.equal(resolved.meaning, 'peanut');
  assert.equal(resolved.lemma, 'cacahuete');
  assert.equal(resolved.correctedWord, undefined);
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

test('the model budget is checked before each batch, and dictionary work is kept', async () => {
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

test('a model request failure is retryable', async () => {
  const resolved = await resolveMeanings(['aaa', 'bbb'], 'es', {
    dictionary,
    infer: async () => {
      throw new Error('the runtime fell over');
    },
  });

  assert.equal(resolved[0].rejected, 'model-failed');
  assert.equal(resolved[1].rejected, 'model-failed');
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

test('450 unresolved words are split into bounded structured batches', async () => {
  const words = Array.from({ length: 450 }, (_, index) => `term-${index}`);
  const requests = [];
  const resolved = await resolveMeanings(words, 'es', {
    dictionary,
    infer: async (request) => {
      const batch = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
      requests.push({ batch, maxTokens: request.maxTokens });
      return JSON.stringify(batch.map((word) => ({
        word,
        correctedWord: word,
        meaning: 'translation',
      })));
    },
  });

  assert.deepEqual(requests.map(({ batch }) => batch.length), [100, 100, 100, 100, 50]);
  assert.deepEqual(requests.map(({ maxTokens }) => maxTokens), [4096, 4096, 4096, 4096, 4096]);
  assert.equal(resolved.filter((entry) => entry.source === 'model').length, 450);
});

test('one malformed batch does not discard successful neighboring batches', async () => {
  const words = Array.from({ length: 250 }, (_, index) => `term-${index}`);
  let request = 0;
  const resolved = await resolveMeanings(words, 'es', {
    dictionary,
    infer: async ({ prompt }) => {
      const batch = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      request++;
      if (request === 2) return '[truncated';
      return JSON.stringify(batch.map((word) => ({
        word,
        correctedWord: word,
        meaning: 'translation',
      })));
    },
  });

  assert.equal(resolved.slice(0, 100).every((entry) => entry.source === 'model'), true);
  assert.equal(resolved.slice(100, 200).every((entry) => entry.rejected === 'model-failed'), true);
  assert.equal(resolved.slice(200).every((entry) => entry.source === 'model'), true);
});

test('a deadline stops before the next batch and keeps completed batches', async () => {
  const words = Array.from({ length: 250 }, (_, index) => `term-${index}`);
  let clock = 0;
  let requests = 0;
  const resolved = await resolveMeanings(words, 'es', {
    dictionary,
    budgetMs: 700,
    now: () => clock,
    infer: async ({ prompt }) => {
      requests++;
      clock += 400;
      const batch = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      return JSON.stringify(batch.map((word) => ({
        word,
        correctedWord: word,
        meaning: 'translation',
      })));
    },
  });

  assert.equal(requests, 2);
  assert.equal(resolved.slice(0, 200).every((entry) => entry.source === 'model'), true);
  assert.equal(resolved.slice(200).every((entry) => entry.rejected === 'not-found'), true);
});

test('an aborted lookup starts no model batches', async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const resolved = await resolveMeanings(['one', 'two'], 'es', {
    dictionary,
    signal: controller.signal,
    infer: async () => {
      requests++;
      return '[]';
    },
  });

  assert.equal(requests, 0);
  assert.equal(resolved.every((entry) => entry.rejected === 'not-found'), true);
});

test('an omitted row is retryable while an explicit empty answer is rejected', async () => {
  const resolved = await resolveMeanings(['unknown', 'omitted'], 'es', {
    dictionary,
    infer: async () => JSON.stringify([
      { word: 'unknown', correctedWord: 'unknown', meaning: '' },
    ]),
  });

  assert.equal(resolved[0].rejected, 'model-rejected');
  assert.equal(resolved[1].rejected, 'model-failed');
});

test('an input that sanitizes to nothing is rejected without a model request', async () => {
  let requests = 0;
  const [resolved] = await resolveMeanings(['“”'], 'es', {
    dictionary,
    infer: async () => {
      requests++;
      return '[]';
    },
  });

  assert.equal(requests, 0);
  assert.equal(resolved.word, '“”');
  assert.equal(resolved.rejected, 'model-rejected');
});

test('results preserve the exact pasted identity and carry spelling corrections separately', async () => {
  const original = '  “almadura”  ';
  const [resolved] = await resolveMeanings([original], 'es', {
    dictionary,
    infer: async () => JSON.stringify([
      { word: 'almadura', correctedWord: 'armadura', meaning: 'armor' },
    ]),
  });

  assert.equal(resolved.word, original);
  assert.equal(resolved.correctedWord, 'armadura');
  assert.equal(resolved.meaning, 'armor');
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
