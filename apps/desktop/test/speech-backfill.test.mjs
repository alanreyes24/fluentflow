import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';

/**
 * The shell's background audio run, which spends the user's Gemini credit on
 * its own: it must skip clips already on disk, make each distinct clip once,
 * slow down rather than give up on a rate limit, and stop on a refused key.
 *
 * Electron and the keychain-backed key store are stubbed; the Gemini API is a
 * fake `fetch`. Everything else, the vendored core included, is real.
 */

const userData = mkdtempSync(join(tmpdir(), 'fluentflow-speech-'));
after(() => rmSync(userData, { recursive: true, force: true }));

let apiKey = 'test-key';
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  if (request === './cloud' && parent?.filename?.endsWith('ai.js')) {
    return { apiKey: () => apiKey, model: () => undefined, status: () => ({}) };
  }
  if (request === './dictionary' && parent?.filename?.endsWith('ai.js')) return { status: () => ({}) };
  return originalLoad.call(this, request, parent, isMain);
};
const ai = createRequire(import.meta.url)('../ai.js');

const calls = [];
let respond = () => wavResponse();
globalThis.fetch = async (url, init) => {
  calls.push(JSON.parse(init.body).contents[0].parts[0].text);
  return respond();
};

function wavResponse() {
  const pcm = Buffer.from([1, 0, 2, 0]).toString('base64');
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm } }] } }] }),
    { status: 200 },
  );
}

/** Resolve once the run has nothing left to do. */
function run(items, voice) {
  return new Promise((resolve) => {
    void ai.prepareSpeech(items, voice, (status) => {
      if (!status.running) resolve(status);
    }).then((status) => {
      if (!status.running) resolve(status);
    });
  });
}

/**
 * Turn the event loop until `ready()` holds, moving the mocked clock by
 * `stepMs` between turns. The clip cache is real disk I/O, which finishes on
 * its own time, so a fixed number of turns is not enough on a slow CI runner;
 * this waits on the condition instead, for up to five seconds of real time.
 */
async function until(t, ready, stepMs = 0) {
  const started = performance.now();
  while (!ready()) {
    if (performance.now() - started > 5_000) throw new Error('timed out waiting for the backfill');
    await new Promise((resolve) => setImmediate(resolve));
    if (stepMs) t.mock.timers.tick(stepMs);
  }
}

beforeEach(() => {
  calls.length = 0;
  respond = () => wavResponse();
  apiKey = 'test-key';
  rmSync(join(userData, 'speech-cache'), { recursive: true, force: true });
});

test('every distinct card gets one clip on disk, and a second pass makes none', async () => {
  const items = [
    { text: 'Baš ti hvala.', language: 'bs' },
    { text: 'Baš ti hvala.', language: 'bs' },
    { text: ' fugaz ', language: 'es' },
    { text: 'tramposo', language: 'es' },
    { text: '', language: 'es' },
    { text: 'unsupported', language: 'fr' },
  ];

  const first = await run(items, 'Aoede');
  assert.equal(first.total, 3);
  assert.equal(first.ready, 3);
  assert.equal(first.failed, 0);
  assert.equal(calls.length, 3);
  assert.equal(readdirSync(join(userData, 'speech-cache')).length, 3);

  calls.length = 0;
  const second = await run(items, 'Aoede');
  assert.equal(second.ready, 3);
  assert.equal(calls.length, 0, 'clips already on disk are not paid for twice');
});

test('a rate limit slows the run down and retries instead of dropping the card', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let limited = 1;
  respond = () => (limited-- > 0 ? new Response('{}', { status: 429 }) : wavResponse());

  let status = null;
  void run([{ text: 'Da, da.', language: 'bs' }], 'Aoede').then((value) => {
    status = value;
  });
  // Let the 429 land, then let the back-off elapse.
  await until(t, () => status !== null, 20_000);
  assert.equal(status.ready, 1);
  assert.equal(status.failed, 0);
  assert.equal(calls.length, 2);
});

test('the daily cap pauses the run until the reset time, then it carries on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let capped = 1;
  const daily = JSON.stringify({
    error: {
      message: 'Quota exceeded for metric: generate_requests_per_model_per_day, limit: 100',
      details: [{ retryDelay: '3600s' }],
    },
  });
  respond = () => (capped-- > 0 ? new Response(daily, { status: 429 }) : wavResponse());

  const seen = [];
  let status = null;
  void ai.prepareSpeech([{ text: 'Da, da.', language: 'bs' }, { text: 'Da, je.', language: 'bs' }], 'Aoede', (value) => {
    seen.push(value);
    if (!value.running) status = value;
  });

  // The capped request lands without the clock moving: the run is paused.
  // The clock moves a second a turn: enough to clear any short back-off an
  // earlier test left in the shell's (module-wide) run, far short of the hour.
  await until(t, () => seen.some((value) => value.resumesAt), 1_000);
  const paused = seen.find((value) => value.resumesAt);
  assert.equal(paused.failed, 0, 'nothing is marked failed for hitting the cap');
  assert.ok(Date.parse(paused.resumesAt) - Date.now() >= 3_000_000, 'it waits for the reset Gemini gave');

  // Once the hour passes, the capped card is made and the run finishes.
  await until(t, () => status !== null, 10 * 60_000);
  assert.equal(status.ready, 2);
  assert.equal(status.failed, 0);
});

test('a refused key stops the run rather than failing every card one by one', async () => {
  respond = () => new Response('{}', { status: 403 });
  const items = Array.from({ length: 12 }, (_, i) => ({ text: `rečenica ${i}.`, language: 'bs' }));

  const status = await run(items, 'Aoede');
  assert.equal(status.ready, 0);
  assert.match(status.error, /API key was refused/);
  assert.ok(calls.length <= 4, `stopped after the first wave, made ${calls.length} calls`);
});

test('without a key nothing is attempted', async () => {
  apiKey = '';
  const status = await ai.prepareSpeech([{ text: 'Da.', language: 'bs' }], 'Aoede', () => undefined);
  assert.match(status.error, /Gemini API key/);
  assert.equal(calls.length, 0);
});
