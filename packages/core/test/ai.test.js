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
  assert.match(instruction, /frases sencillas en español/);
});

test('each model family gets its own chat template', () => {
  const input = { word: 'raditi', language: 'bs' };

  const tinyllama = buildPrompt(input, 'tinyllama');
  assert.match(tinyllama, /^<\|system\|>/);
  assert.match(tinyllama, /<\|assistant\|>\n$/);

  const phi2 = buildPrompt(input, 'phi2');
  assert.match(phi2, /^Instruct: /);
  assert.match(phi2, /\nOutput:$/);

  assert.equal(buildPrompt(input, 'raw'), buildInstruction(input));
  assert.ok(STOP_SEQUENCES.tinyllama.includes('</s>'));
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

test('the prompt handed to the model matches the configured family', async () => {
  let seen = null;
  await generateExamples(
    { word: 'raditi', language: 'bs' },
    {
      family: 'phi2',
      infer: async (request) => {
        seen = request;
        return '["Danas moram raditi do kasno."]';
      },
    },
  );

  assert.match(seen.prompt, /^Instruct: /);
  assert.deepEqual(seen.stop, STOP_SEQUENCES.phi2);
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
