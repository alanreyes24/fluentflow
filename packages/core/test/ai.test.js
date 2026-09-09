import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstruction,
  buildPrompt,
  parseExamples,
  containsWord,
  fallbackExamples,
  generateExamples,
  STOP_SEQUENCES,
} from '../dist/index.js';

test('the instruction names the word, the language and the output format', () => {
  const instruction = buildInstruction({ word: 'hablar', meaning: 'to speak', language: 'es' });

  assert.match(instruction, /hablar/);
  assert.match(instruction, /Spanish/);
  assert.match(instruction, /JSON array of strings/);
  assert.match(instruction, /to speak/);
  // The localised half keeps a small model producing the target language.
  assert.match(instruction, /frases naturales en español/);
  assert.match(instruction, /primera frase debe ser sencilla/);
  assert.match(instruction, /segunda debe ser más compleja/);
  assert.match(instruction, /colocación y la preposición más naturales/);
  assert.match(instruction, /no traduzcas literalmente del inglés/);
  assert.match(instruction, /entrar por la fuerza/);
  assert.match(instruction, /first sentence must be simple/);
  assert.match(instruction, /second sentence must be more complex/);
  assert.match(instruction, /12-20 words/);
  assert.match(instruction, /C1-C2 words or collocations/);
  assert.doesNotMatch(instruction, /Every sentence must|Cada frase debe/);
});

test('the prompt is the bare instruction, with no chat template around it', () => {
  const input = { word: 'raditi', language: 'bs' };

  // The hosted endpoint applies its own template. Control tokens here would be
  // text the model has to read past, which is why the wrappers are gone.
  assert.equal(buildPrompt(input), buildInstruction(input));
  assert.match(buildPrompt(input), /Prva rečenica treba biti jednostavna/);
  assert.match(buildPrompt(input), /Druga treba biti složenija/);
  assert.doesNotMatch(buildPrompt(input), /<\|/);
});

test('the Bosnian instruction asks for a sentence and an English translation per item', () => {
  const bs = buildInstruction({ word: 'raditi', language: 'bs' });
  assert.match(bs, /"sentence"/);
  assert.match(bs, /"translation"/);
  assert.match(bs, /English translation/);
  // The object shape replaces the bare string array for Bosnian only.
  assert.doesNotMatch(bs, /JSON array of strings/);
  assert.match(buildInstruction({ word: 'hablar', language: 'es' }), /JSON array of strings/);
});

const es = { word: 'hablar', language: 'es' };

test('clean JSON output parses directly', () => {
  const result = parseExamples('["Ella habla español.", "Hablamos todos los dias."]', es);

  assert.equal(result.strategy, 'json');
  assert.deepEqual(result.examples, ['Ella habla español.', 'Hablamos todos los dias.']);
});

test('a JSON array wrapped in chatter and markdown is recovered', () => {
  const raw = 'Sure! Here are two example sentences:\n```json\n["Ella habla espanol.", "Habla dos idiomas."]\n```\n';
  const result = parseExamples(raw, es);

  assert.deepEqual(result.examples, ['Ella habla espanol.', 'Habla dos idiomas.']);
});

test('a truncated array is repaired rather than discarded', () => {
  const raw = '["Ella habla espanol.", "Hablamos todos los dias.';
  const result = parseExamples(raw, es);

  assert.equal(result.strategy, 'bracket');
  assert.equal(result.examples[0], 'Ella habla espanol.');
});

test('a numbered list falls through to line parsing', () => {
  const raw = '1. Ella habla espanol muy bien.\n2. Hablamos todos los dias.\n';
  const result = parseExamples(raw, es);

  assert.equal(result.strategy, 'lines');
  assert.deepEqual(result.examples, ['Ella habla espanol muy bien.', 'Hablamos todos los dias.']);
});

test('chat-template markers left in the output are stripped', () => {
  const raw = '<|assistant|>\n["Ella habla espanol."]</s>';
  const result = parseExamples(raw, es);

  assert.deepEqual(result.examples, ['Ella habla espanol.']);
});

test('sentences that do not use the word are rejected', () => {
  const raw = '["El perro corre en el parque.", "Ella habla espanol."]';
  const result = parseExamples(raw, es);

  assert.deepEqual(result.examples, ['Ella habla espanol.']);
  assert.deepEqual(result.rejected, [
    { text: 'El perro corre en el parque.', reason: 'does not use the word' },
  ]);
});

test('sentences that are too short, too long or echo the prompt are rejected', () => {
  const raw = JSON.stringify([
    'Hablar.',
    'Generate 2 sentences using hablar in JSON array format please now',
    'Ella habla espanol con su madre.',
  ]);
  const result = parseExamples(raw, es);

  assert.deepEqual(result.examples, ['Ella habla espanol con su madre.']);
  assert.deepEqual(result.rejected.map((r) => r.reason).sort(), ['echoes the prompt', 'too short']);
});

test('duplicate sentences are collapsed', () => {
  const raw = '["Ella habla espanol.", "ella habla espanol", "Hablamos hoy juntos."]';
  const result = parseExamples(raw, es);

  assert.deepEqual(result.examples, ['Ella habla espanol.', 'Hablamos hoy juntos.']);
});

const bs = { word: 'knjiga', language: 'bs' };

test('Bosnian objects parse into sentences with aligned translations', () => {
  const raw = JSON.stringify([
    { sentence: 'Kupio sam novu knjigu.', translation: 'I bought a new book.' },
    { sentence: 'Ona čita knjigu koju joj je preporučio profesor.', translation: 'She is reading the book her professor recommended to her.' },
  ]);
  const result = parseExamples(raw, bs);

  assert.equal(result.strategy, 'json');
  assert.deepEqual(result.examples, [
    'Kupio sam novu knjigu.',
    'Ona čita knjigu koju joj je preporučio profesor.',
  ]);
  assert.deepEqual(result.translations, [
    'I bought a new book.',
    'She is reading the book her professor recommended to her.',
  ]);
});

test('a bare Bosnian string array still parses, with no translations', () => {
  const result = parseExamples(JSON.stringify(['Kupio sam novu knjigu.']), bs);
  assert.deepEqual(result.examples, ['Kupio sam novu knjigu.']);
  assert.equal(result.translations, undefined);
});

test('a rejected Bosnian sentence takes its translation with it, keeping the rest aligned', () => {
  const raw = JSON.stringify([
    { sentence: 'Pas trči po parku.', translation: 'The dog runs in the park.' },
    { sentence: 'Kupio sam novu knjigu.', translation: 'I bought a new book.' },
  ]);
  const result = parseExamples(raw, bs);
  assert.deepEqual(result.examples, ['Kupio sam novu knjigu.']);
  assert.deepEqual(result.translations, ['I bought a new book.']);
});

test('translations are all-or-nothing: one missing translation drops them all', () => {
  const raw = JSON.stringify([
    { sentence: 'Kupio sam novu knjigu.', translation: 'I bought a new book.' },
    { sentence: 'Ona čita knjigu koju joj je preporučio profesor.' },
  ]);
  const result = parseExamples(raw, bs);
  assert.equal(result.examples.length, 2);
  assert.equal(result.translations, undefined);
});

test('output with no usable sentence yields nothing rather than junk', () => {
  const result = parseExamples('I am sorry, I cannot help with that.', es);

  assert.equal(result.strategy, 'none');
  assert.deepEqual(result.examples, []);
});

test('word matching tolerates inflection in Spanish and Bosnian', () => {
  assert.ok(containsWord('Ella habla espanol.', 'hablar'), 'hablar -> habla');
  assert.ok(containsWord('Hablamos todos los dias.', 'hablar'));
  assert.ok(containsWord('Čitam knjigu svaki dan.', 'knjiga'), 'knjiga -> knjigu');
  assert.ok(containsWord('El café está caliente.', 'cafe'), 'diacritics are folded');
  assert.ok(!containsWord('El perro corre.', 'hablar'));
});

test('phrase matching tolerates inflection and the natural Spanish preposition variant', () => {
  assert.ok(
    containsWord('Entró por la fuerza en la casa cuando nadie miraba.', 'entrar a la fuerza en'),
  );
  assert.ok(
    parseExamples(
      JSON.stringify(['Entró por la fuerza en la casa cuando nadie miraba.']),
      { word: 'entrar a la fuerza en', language: 'es' },
    ).examples.length > 0,
  );
  assert.ok(!containsWord('La fuerza de la ley prevaleció.', 'entrar a la fuerza en'));
});

test('the fallback produces grammatical carrier sentences in the target language', () => {
  const spanish = fallbackExamples({ word: 'hablar', meaning: 'to speak', language: 'es' });
  assert.equal(spanish.length, 2);
  assert.equal(spanish[0], '«hablar» significa "to speak".');
  assert.ok(spanish.every((s) => s.includes('hablar')));

  const bosnian = fallbackExamples({ word: 'raditi', language: 'bs', count: 3 });
  assert.equal(bosnian.length, 3);
  assert.ok(bosnian.every((s) => s.includes('raditi')));
  assert.ok(bosnian.some((s) => s.includes('rečenici') || s.includes('riječ') || s.includes('sutra')));
});

test('the fallback is stable for the same word', () => {
  const a = fallbackExamples({ word: 'la casa', language: 'es' });
  const b = fallbackExamples({ word: 'la casa', language: 'es' });
  assert.deepEqual(a, b);
});

// --- the generation pipeline ------------------------------------------------

test('cached examples short-circuit inference entirely', async () => {
  let called = false;
  const result = await generateExamples(
    { word: 'hablar', language: 'es', cached: ['Ella habla español.', 'Hablamos hoy.'] },
    { infer: async () => { called = true; return ''; } },
  );

  assert.equal(result.source, 'cache');
  assert.equal(result.attempts, 0);
  assert.equal(called, false);
});

test('a good model response is used', async () => {
  const result = await generateExamples(
    { word: 'hablar', language: 'es' },
    { infer: async () => '["Ella habla espanol.", "Hablamos todos los dias."]' },
  );

  assert.equal(result.source, 'model');
  assert.equal(result.attempts, 1);
  assert.equal(result.examples.length, 2);
});

test('the request carries the instruction, the stops and a signal', async () => {
  let seen = null;
  await generateExamples(
    { word: 'raditi', language: 'bs' },
    {
      infer: async (request) => {
        seen = request;
        return '["Danas moram raditi do kasno."]';
      },
    },
  );

  assert.match(seen.prompt, /raditi/);
  assert.deepEqual(seen.stop, STOP_SEQUENCES);
  assert.ok(seen.signal, 'the request must be cancellable');
});

test('unusable model output falls back instead of showing nothing', async () => {
  const result = await generateExamples(
    { word: 'hablar', meaning: 'to speak', language: 'es' },
    { infer: async () => 'I am not sure what you mean.' },
  );

  assert.equal(result.source, 'fallback');
  assert.equal(result.examples.length, 2);
  assert.match(result.error, /no parsable sentences|rejected/);
});

test('a failed parse can be retried once before falling back', async () => {
  let call = 0;
  const result = await generateExamples(
    { word: 'hablar', language: 'es' },
    {
      retryOnParseFailure: true,
      infer: async () => (++call === 1 ? 'nope' : '["Ella habla espanol ahora."]'),
    },
  );

  assert.equal(result.source, 'model');
  assert.equal(result.attempts, 2);
});

test('a retry asks a different question, because a greedy decode repeats itself', async () => {
  const asked = [];
  await generateExamples(
    { word: 'hablar', language: 'es' },
    {
      retryOnParseFailure: true,
      infer: async (request) => {
        asked.push(request.prompt);
        return 'nothing usable here';
      },
    },
  );

  assert.equal(asked.length, 2);
  assert.notEqual(asked[0], asked[1], 'the second attempt must not repeat the first prompt');
  assert.match(asked[0], /Generate 2 example/);
  assert.match(asked[1], /Generate 3 example/);
});

test('the same sentence twice counts as one example and triggers the retry', async () => {
  let call = 0;
  const result = await generateExamples(
    { word: 'hablar', language: 'es' },
    {
      retryOnParseFailure: true,
      infer: async () =>
        ++call === 1
          ? '["Ella habla espanol.", "Ella habla espanol."]'
          : '["Ella habla espanol.", "Hablamos todos los dias."]',
    },
  );

  assert.equal(call, 2);
  assert.equal(result.source, 'model');
  assert.equal(result.examples.length, 2);
  assert.notEqual(result.examples[0], result.examples[1]);
});

test('one real sentence ships as a model result rather than two carrier phrases', async () => {
  const result = await generateExamples(
    { word: 'hablar', meaning: 'to speak', language: 'es' },
    { infer: async () => '["Ella habla espanol todos los dias."]' },
  );

  assert.equal(result.source, 'model');
  assert.deepEqual(result.examples, ['Ella habla espanol todos los dias.']);
  assert.match(result.error, /only 1 of 2/);
});

test('inference that blows the time budget is abandoned for the fallback', async () => {
  const started = Date.now();
  const result = await generateExamples(
    { word: 'hablar', language: 'es' },
    {
      budgetMs: 50,
      infer: (request) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('["Ella habla espanol."]'), 5000);
          request.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    },
  );

  assert.equal(result.source, 'fallback');
  assert.match(result.error, /budget/);
  assert.ok(Date.now() - started < 1000, 'the reveal must not wait for the model');
});

test("a caller's signal cancels the run, so a prefetch can get out of the way", async () => {
  // Speculative generation is started for cards the user has not reached. When
  // they reveal a different card the model has to be freed immediately, and
  // waiting out the budget would defeat the point of running early at all.
  const controller = new AbortController();
  let sawAbort = false;

  // Cancel once the inference is genuinely under way, which is what a reveal
  // landing on top of a running prefetch does.
  const started = Date.now();
  setTimeout(() => controller.abort(), 10);

  const result = await generateExamples(
    { word: 'hablar', language: 'es' },
    {
      // The desktop shell's budget, which is the whole point: thirty seconds is
      // the right ceiling for a generation somebody wants, and far too long to
      // wait for one nobody does.
      budgetMs: 30000,
      signal: controller.signal,
      infer: (request) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('["Ella habla espanol."]'), 5000);
          request.signal.addEventListener('abort', () => {
            sawAbort = true;
            clearTimeout(timer);
            // What a real decode loop does when its signal goes: stop where it
            // is and hand back what it had, which is nothing usable this early.
            resolve('');
          });
        }),
    },
  );

  assert.ok(sawAbort, 'the inference must be told to stop');
  assert.equal(result.source, 'fallback');
  assert.ok(Date.now() - started < 1000, 'cancelling must not wait out the budget');
});

test('a signal already aborted never starts the model at all', async () => {
  const controller = new AbortController();
  controller.abort();

  let asked = false;
  const result = await generateExamples(
    { word: 'hablar', language: 'es' },
    {
      signal: controller.signal,
      infer: async (request) => {
        asked = true;
        assert.ok(request.signal.aborted, 'the inference sees the cancellation');
        return '';
      },
    },
  );

  assert.ok(asked);
  assert.equal(result.source, 'fallback');
});

test('a thrown inference error falls back rather than surfacing to the UI', async () => {
  const result = await generateExamples(
    { word: 'raditi', language: 'bs' },
    { infer: async () => { throw new Error('ONNX session not initialised'); } },
  );

  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'ONNX session not initialised');
  assert.ok(result.examples.length > 0);
});

test('with no model available the fallback is used with no delay', async () => {
  const result = await generateExamples({ word: 'hablar', language: 'es' }, { infer: null });

  assert.equal(result.source, 'fallback');
  assert.equal(result.durationMs, 0);
  assert.equal(result.attempts, 0);
});
