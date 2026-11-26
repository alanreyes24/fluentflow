import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SPEECH_MODEL,
  DEFAULT_SPEECH_VOICE,
  isWav,
  maxSpeechSeconds,
  pcmToWav,
  speechCacheKey,
  SpeechQuotaError,
  synthesizeSpeech,
} from '../dist/index.js';

function fakeGemini(capture, { status = 200, body } = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    capture.headers = init.headers;
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]).toString('base64');
    return new Response(
      JSON.stringify(body ?? {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }],
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  };
}

test('a clip comes back as a playable WAV of the PCM Gemini sent', async () => {
  const capture = {};
  const clip = await synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini(capture) }, ' Baš ti hvala. ', 'bs');

  assert.equal(clip.mimeType, 'audio/wav');
  assert.equal(clip.model, DEFAULT_SPEECH_MODEL);
  assert.equal(clip.voice, DEFAULT_SPEECH_VOICE);
  assert.equal(Buffer.from(clip.audio.slice(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(clip.audio.slice(8, 12)).toString('ascii'), 'WAVE');
  assert.equal(clip.audio.byteLength, 44 + 8);
  assert.equal(new DataView(clip.audio.buffer).getUint32(24, true), 24000);

  assert.match(capture.url, /gemini-3\.8-flash-tts:generateContent$/);
  assert.equal(capture.headers['x-goog-api-key'], 'k');
  assert.deepEqual(capture.body.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(
    capture.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    DEFAULT_SPEECH_VOICE,
  );
});

test('a finished WAV from Gemini 3 is passed through, provenance chunk and all, not wrapped again', async () => {
  // fmt + data + the C2PA chunk Gemini 3 appends after the audio.
  const pcm = new Uint8Array([1, 0, 2, 0]);
  const inner = pcmToWav(pcm);
  const c2pa = new Uint8Array([...Buffer.from('C2PA'), 4, 0, 0, 0, 9, 9, 9, 9]);
  const file = new Uint8Array([...inner, ...c2pa]);
  new DataView(file.buffer).setUint32(4, file.byteLength - 8, true);
  const body = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(file).toString('base64') } }] } }],
  };

  const clip = await synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini({}, { body }) }, 'Da.', 'bs');

  assert.deepEqual([...clip.audio], [...file]);
  assert.ok(isWav(clip.audio));
  // Exactly one RIFF header: a second one would play as a click and the
  // provenance chunk as static.
  assert.equal(Buffer.from(clip.audio).indexOf('RIFF', 1), -1);
});

test('only the card is sent as text; its language rides in languageCode', async () => {
  // Direction written into the text gets read aloud with single words.
  const capture = {};
  await synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini(capture) }, 'vibrar', 'es');
  assert.equal(capture.body.contents[0].parts[0].text, 'vibrar');
  assert.equal(capture.body.generationConfig.speechConfig.languageCode, 'es-ES');

  await synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini(capture) }, 'Baš ti hvala.', 'bs');
  assert.equal(capture.body.contents[0].parts[0].text, 'Baš ti hvala.');
  assert.equal(capture.body.generationConfig.speechConfig.languageCode, 'bs-BA');
  assert.equal(capture.body.systemInstruction, undefined);
});

test('a clip far longer than its card is refused, not kept', async () => {
  // 15 seconds of audio for one word: the model said more than the card.
  const pcm = Buffer.alloc(24000 * 2 * 15).toString('base64');
  const body = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm } }] } }],
  };
  await assert.rejects(
    synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini({}, { body }) }, 'vibrar', 'es'),
    (error) => error.status === 422,
  );
  assert.ok(maxSpeechSeconds('vibrar') < 15);
  assert.ok(maxSpeechSeconds('Baš ti hvala. Gdje je najbliža apoteka? Ovo je samo početak.') > 7.2);
});

test('the daily request cap is told apart from a short rate limit, with its reset time', async () => {
  const daily = {
    error: {
      message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 100. Please retry in 13h14m9.38s.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '47649s' }],
    },
  };
  await assert.rejects(
    synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini({}, { status: 429, body: daily }) }, 'Da.', 'bs'),
    (error) => error instanceof SpeechQuotaError && error.daily && error.retryAfterMs === 47_649_000,
  );

  const noDetails = { error: { message: daily.error.message } };
  await assert.rejects(
    synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini({}, { status: 429, body: noDetails }) }, 'Da.', 'bs'),
    (error) => error.daily && error.retryAfterMs === Math.ceil((13 * 3600 + 14 * 60 + 9.38) * 1000),
  );

  const burst = { error: { message: 'Resource exhausted: requests per minute.' } };
  await assert.rejects(
    synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini({}, { status: 429, body: burst }) }, 'Da.', 'bs'),
    (error) => error instanceof SpeechQuotaError && !error.daily,
  );
});

test('unknown voices and non-speech models fall back to the defaults', async () => {
  const capture = {};
  const clip = await synthesizeSpeech(
    { apiKey: 'k', voice: 'Nobody', model: 'gemini-3.1-flash-lite', fetchImpl: fakeGemini(capture) },
    'Da.',
    'bs',
  );
  assert.equal(clip.voice, DEFAULT_SPEECH_VOICE);
  assert.equal(clip.model, DEFAULT_SPEECH_MODEL);
});

test('missing keys, empty text and API errors are reported, not played', async () => {
  await assert.rejects(synthesizeSpeech({ apiKey: '' }, 'Da.', 'bs'), /Gemini API key/);
  await assert.rejects(synthesizeSpeech({ apiKey: 'k' }, '   ', 'bs'), /nothing to read/);
  await assert.rejects(
    synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini({}, { status: 429, body: {} }) }, 'Da.', 'bs'),
    /rate-limiting/,
  );
  await assert.rejects(
    synthesizeSpeech({ apiKey: 'k', fetchImpl: fakeGemini({}, { body: { candidates: [] } }) }, 'Da.', 'bs'),
    /no audio/,
  );
});

test('cache keys separate voices, models and languages', () => {
  const base = speechCacheKey('Da.', 'bs', 'Aoede', 'm');
  assert.notEqual(base, speechCacheKey('Da.', 'bs', 'Leda', 'm'));
  assert.notEqual(base, speechCacheKey('Da.', 'es', 'Aoede', 'm'));
  assert.notEqual(base, speechCacheKey('Da.', 'bs', 'Aoede', 'n'));
  assert.equal(base, speechCacheKey(' Da. ', 'bs', 'Aoede', 'm'));
  assert.equal(pcmToWav(new Uint8Array(0)).byteLength, 44);
});

test('a deck recording has one key whatever the voice, apart from every generated clip', async () => {
  const { recordedSpeechKey, audioMimeType } = await import('../dist/index.js');
  assert.equal(recordedSpeechKey(' Es lo que es. ', 'es'), recordedSpeechKey('Es lo que es.', 'es'));
  assert.notEqual(recordedSpeechKey('Da.', 'bs'), speechCacheKey('Da.', 'bs', DEFAULT_SPEECH_VOICE, DEFAULT_SPEECH_MODEL));
  assert.notEqual(recordedSpeechKey('Da.', 'bs'), recordedSpeechKey('Da.', 'es'));

  assert.equal(audioMimeType(pcmToWav(new Uint8Array(4))), 'audio/wav');
  assert.equal(audioMimeType(new Uint8Array([0x49, 0x44, 0x33, 4])), 'audio/mpeg');
  assert.equal(audioMimeType(new Uint8Array([0xff, 0xfb, 0x90, 0])), 'audio/mpeg');
  assert.equal(audioMimeType(new Uint8Array([...Buffer.from('OggS')])), 'audio/ogg');
});
