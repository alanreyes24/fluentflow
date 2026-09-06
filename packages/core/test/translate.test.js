import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTranslatePrompt,
  parseTranslation,
  translateWords,
  meaningsFrom,
} from '../dist/index.js';

/**
 * Word translation.
 *
 * The cases below are not invented: every rejected shape is one a real model
 * run produced while this was being built.
 */

test('the prompt carries few-shot pairs and ends mid-pair', () => {
  const prompt = buildTranslatePrompt('empapar', 'es');

  assert.match(prompt, /Spanish-English dictionary/);
  assert.match(prompt, /hablar = to speak/);
  // Ending on `word =` is what makes the model answer rather than continue.
  assert.match(prompt, /empapar =$/);
});

test('each language gets its own few-shot examples', () => {
  assert.match(buildTranslatePrompt('kuća', 'bs'), /^You are a Bosnian-English/);
  assert.match(buildTranslatePrompt('kuća', 'bs'), /govoriti = to speak/);
  assert.doesNotMatch(buildTranslatePrompt('kuća', 'bs'), /hablar/);
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
