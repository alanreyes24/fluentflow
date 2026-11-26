'use strict';

/**
 * Where a word's meaning and its example sentences come from.
 *
 *  - `resolve` fills in the meanings a pasted word list does not carry.
 *  - `examples` writes sentences showing a word in use, for a card reveal.
 *
 * Two sources answer them, in this order:
 *
 *  1. **The dictionary**, for meanings only. It is a Wiktionary-derived SQLite
 *     file read in this process, and on the twelve Spanish words this was
 *     measured against it got all twelve right in 2 ms — including saying "I
 *     don't know" to a Bosnian word and to a typo, which is the thing no model
 *     will do for you. So it is the engine and the model is the tail behind it,
 *     not the other way round.
 *  2. **A hosted model**, for the words the dictionary misses and for every
 *     example sentence. No lookup table contains a sentence, so there the model
 *     has no competition and is the source rather than the fallback.
 *
 * What keeps that honest is validation rather than trust: core rejects a
 * sentence that does not contain the word it was meant to demonstrate, and
 * marks every model-supplied *meaning* as needing review while the
 * dictionary's are not.
 *
 * **There used to be a third source, and removing it is the point of this
 * file's current shape.** A 1.2 GB Qwen2.5-1.5B ran here under
 * `onnxruntime-node`, and it worked — but it answered about ten words in
 * fourteen against the dictionary's twelve in twelve, took 5–7 s a card against
 * about 1.9 s, wrote Bosnian that was not really Bosnian, forced the macOS
 * build to arm64 because onnxruntime-node has no x64 binary, added 88 MB to the
 * installer, and created its session on the main thread — which is Chromium's
 * browser process, so a cold start stalled window input for seconds. The hosted
 * model costs about five cents per thousand cards and is better on every one of
 * those axes except working on a plane.
 *
 * Both jobs still run here rather than in the renderer. The renderer is the
 * Expo web export: it has a content security policy in the way because it draws
 * user-supplied deck content, and it must never hold the API key. It asks for
 * finished sentences and gets them.
 */

const { existsSync, readdirSync } = require('node:fs');
const { appendFile, mkdir, readFile, writeFile } = require('node:fs/promises');
const crypto = require('node:crypto');
const { app } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const dictionary = require('./dictionary');
const cloud = require('./cloud');

/**
 * Load core from the vendored build when there is one, as `src/apkg.js` does.
 *
 * A packaged app also carries a `node_modules/@fluentflow/core` copied in when
 * it was first built, and `refresh-desktop.mjs` never updates `node_modules`.
 * Importing the bare specifier left an installed app writing prompts and
 * validating examples with that first build's core, whatever had been pushed
 * since. In the repository `vendor/` may not exist yet, so the workspace
 * package is the fallback.
 */
const VENDORED_CORE = path.join(__dirname, 'vendor', 'core', 'index.js');

function loadCore() {
  return existsSync(VENDORED_CORE)
    ? import(pathToFileURL(VENDORED_CORE).href)
    : import('@fluentflow/core');
}

/**
 * An inference function backed by the user's hosted model, or null.
 *
 * Null means no API key is configured, and every caller treats it as "there is
 * nothing to ask" — which is what it means now that there is no local model
 * behind it.
 *
 * @param core           the loaded `@fluentflow/core` module
 * @param responseSchema a schema the answer must fill, for the JSON-array shape
 *                       example generation wants. Omitted for translation,
 *                       whose answer is a bare phrase.
 */
function remoteInference(core, responseSchema, onUsage) {
  const key = cloud.apiKey();
  if (!key) return null;

  try {
    return core.createRemoteInference({
      apiKey: key,
      model: cloud.model(),
      responseSchema,
      onUsage,
    });
  } catch (error) {
    // A key that cannot even build a client (empty after decryption, no fetch
    // in this runtime) is a configuration problem, not a per-request failure.
    console.warn(`[fluentflow] hosted model unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Find a meaning for every word.
 *
 * Every definition comes from the hosted model. Without an API key, nothing
 * is defined: the dictionary is never a silent fallback for card backs.
 *
 * `useModel: false` is the other mode: a free, offline dictionary lookup that
 * callers use only to turn a conjugated front into its infinitive.
 *
 * @param words     the words, in the deck's language
 * @param language  'es' or 'bs'
 * @param onProgress called as words are resolved, for the progress bar
 * @param useModel  false for the dictionary-only infinitive check, which bills nothing
 * @returns meanings plus measured Gemini usage when the model was called
 */
async function resolve(words, language, onProgress, useModel = true) {
  const core = await loadCore();
  const usages = [];

  // With a model, every definition is the model's. The dictionary is only for
  // the free infinitive check a caller asks for with useModel=false.
  const infer = useModel
    ? remoteInference(core, undefined, (usage) => usages.push(usage))
    : null;
  const lookup = !useModel && dictionary.status().languages[language]
    ? (word) => dictionary.lookup(language, word)
    : null;

  const meanings = await core.resolveMeanings(words, language, { dictionary: lookup, infer, onProgress });
  return { meanings, usage: core.combineModelUsage(usages) };
}

/**
 * How long a card reveal may spend generating example sentences.
 *
 * Ten seconds, against a measured 0.6–3.3 s for a hosted Flash-Lite. Anything
 * past that is not a slow answer, it is a network that is not going to produce
 * one, and a carrier sentence is waiting behind it. The old local path allowed
 * thirty because a decode loop grinding through a graph on the CPU genuinely
 * needed it.
 */
const EXAMPLE_BUDGET_MS = 10000;

/**
 * Two sentences of Spanish run to about 50 tokens, and the response schema ends
 * the answer at the closing bracket anyway. The headroom is for a longer word.
 */
const EXAMPLE_MAX_TOKENS = 128;

/**
 * Bosnian sentences come back paired with an English translation, so each item
 * is roughly two sentences of text plus the object scaffolding. Give the answer
 * room to close its JSON rather than be truncated mid-translation.
 */
const EXAMPLE_MAX_TOKENS_WITH_TRANSLATION = 320;

/**
 * Write example sentences showing the word in use.
 *
 * A missing API key is not an error and does not throw: core answers with
 * written carrier sentences, and the UI labels them as offline. Neither is a
 * cancelled run — core returns whatever it had reached, exactly as it does for
 * a spent budget, and the renderer knows it cancelled and discards the result.
 * See `ai:examples:cancel` in main.js.
 *
 * @param request `{ word, meaning, language, count }`
 * @param signal  abandons the request when the renderer no longer wants it
 * @returns a `GenerateExamplesResult`: sentences, and which source wrote them
 */
async function examples(request, signal) {
  const core = await loadCore();
  const { word, meaning, language, count = 2 } = request ?? {};

  return core.generateExamples(
    { word, meaning, language, count },
    {
      infer: remoteInference(core, core.examplesSchemaFor(language)),
      budgetMs: EXAMPLE_BUDGET_MS,
      maxTokens: language === 'bs' ? EXAMPLE_MAX_TOKENS_WITH_TRANSLATION : EXAMPLE_MAX_TOKENS,
      signal,
      // Off on purpose: given a response schema the model returns usable
      // sentences on the first attempt nearly every time (6/6 when measured),
      // and a retry is a second billed request. Core still keeps the best
      // partial answer, so a short result is not thrown away.
      retryOnParseFailure: false,
    },
  );
}

/** What the UI needs to decide what to offer: both sources, separately. */
function sources() {
  return { dictionary: dictionary.status(), cloud: cloud.status() };
}

async function chat(messages) {
  const core = await loadCore();
  return core.chatWithGemini({ apiKey: cloud.apiKey(), model: cloud.model() }, messages);
}

/**
 * Read-aloud audio for one card, as WAV bytes.
 *
 * Clips are cached on disk under the app's data folder, keyed by model, voice,
 * language and text, so a sentence is generated (and billed) once and replays
 * offline after that. Concurrent requests for the same clip share one call,
 * which matters because the study screen prefetches the next card.
 */
const speechInFlight = new Map();

function speechCacheDir() {
  return path.join(app.getPath('userData'), 'speech-cache');
}

/** Where one clip lives on disk, and the name it is cached under. */
function speechClipPath(core, text, language, voice) {
  const model = process.env.GEMINI_SPEECH_MODEL || core.DEFAULT_SPEECH_MODEL;
  const chosenVoice = core.isSpeechVoice(voice) ? voice : core.DEFAULT_SPEECH_VOICE;
  const name = crypto
    .createHash('sha256')
    .update(core.speechCacheKey(text, language, chosenVoice, model))
    .digest('hex');
  return { name, model, voice: chosenVoice, file: path.join(speechCacheDir(), `${name}.wav`) };
}

/**
 * Where a recording that came with a deck lives. It is keyed by text and
 * language only, so it is found whatever voice is chosen, and it is read
 * before any generated clip.
 */
function recordingPath(core, text, language) {
  const name = crypto.createHash('sha256').update(core.recordedSpeechKey(text, language)).digest('hex');
  return { name, file: path.join(speechCacheDir(), `${name}.recording`) };
}

/** Keep a deck's own recordings (handed over by the importer) on disk. */
async function saveRecordings(recordings) {
  const core = await loadCore();
  await mkdir(speechCacheDir(), { recursive: true });
  let saved = 0;
  for (const recording of recordings ?? []) {
    if (!recording?.text || !(recording.audio instanceof Uint8Array)) continue;
    await writeFile(recordingPath(core, recording.text, recording.language).file, recording.audio);
    saved++;
  }
  return saved;
}

/**
 * Deck recordings go up to the sync server so the web build plays them too.
 * The page drives it (it holds the sign-in token); the shell lists what has
 * not gone up yet for that account and remembers what has.
 */
function recordingUploadLog(userId) {
  const name = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
  return path.join(app.getPath('userData'), 'recording-uploads', `${name}.txt`);
}

async function uploadedRecordings(userId) {
  try {
    return new Set((await readFile(recordingUploadLog(userId), 'utf8')).split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Up to `limit` recordings this account has not uploaded, as `{ id, audio }` (base64). */
async function pendingRecordings(userId, limit = 50) {
  if (!userId || !existsSync(speechCacheDir())) return [];
  const done = await uploadedRecordings(userId);
  const pending = readdirSync(speechCacheDir())
    .filter((file) => file.endsWith('.recording'))
    .map((file) => file.slice(0, -'.recording'.length))
    .filter((id) => /^[0-9a-f]{64}$/.test(id) && !done.has(id))
    .slice(0, Math.max(1, Math.min(100, limit)));
  return Promise.all(pending.map(async (id) => ({
    id,
    audio: (await readFile(path.join(speechCacheDir(), `${id}.recording`))).toString('base64'),
  })));
}

async function markRecordingsUploaded(userId, ids) {
  const valid = (ids ?? []).filter((id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id));
  if (!userId || valid.length === 0) return;
  const log = recordingUploadLog(userId);
  await mkdir(path.dirname(log), { recursive: true });
  await appendFile(log, `${valid.join('\n')}\n`);
}

async function speech({ text, language, voice }) {
  const core = await loadCore();
  const { name, model, voice: chosenVoice, file } = speechClipPath(core, text, language, voice);
  const dir = speechCacheDir();

  const pending = speechInFlight.get(name);
  if (pending) return pending;

  const work = (async () => {
    for (const candidate of [recordingPath(core, text, language).file, file]) {
      try {
        return new Uint8Array(await readFile(candidate));
      } catch {
        // Not on disk.
      }
    }
    const clip = await core.synthesizeSpeech(
      { apiKey: cloud.apiKey(), model, voice: chosenVoice },
      text,
      language,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(file, clip.audio);
    return clip.audio;
  })();
  speechInFlight.set(name, work);
  try {
    return await work;
  } finally {
    speechInFlight.delete(name);
  }
}

/**
 * Background audio for a whole collection.
 *
 * The page hands over every card's front (on launch, and again whenever cards
 * are imported, added, edited or synced in); whatever is not on disk yet is
 * generated a few at a time. Asking again while a run is going replaces its
 * to-do list rather than starting a second run, and finished clips are on
 * disk, so a run cut short by quitting picks up where it stopped.
 *
 * Rate limits slow it down instead of stopping it: a 429 halves how many run
 * at once and waits before retrying. The daily request cap (100 a day on the
 * first paid tier) pauses the whole run until the reset time Gemini gives,
 * with nothing marked failed. A refused key stops the run, since every later
 * request would be refused too.
 */
const SPEECH_MAX_CONCURRENCY = 4;
const SPEECH_RETRY_LIMIT = 6;
const backfill = {
  queue: [],
  queued: new Set(),
  running: 0,
  concurrency: SPEECH_MAX_CONCURRENCY,
  total: 0,
  ready: 0,
  failed: 0,
  error: null,
  pausedUntil: 0,
  /** Set while the daily cap is hit: when the run picks up again. */
  resumesAt: null,
  stopped: false,
  onProgress: null,
  voice: undefined,
};

function backfillStatus() {
  return {
    total: backfill.total,
    ready: backfill.ready,
    failed: backfill.failed,
    remaining: backfill.queue.length + backfill.running,
    running: backfill.running > 0 || backfill.queue.length > 0,
    error: backfill.error,
    resumesAt: backfill.resumesAt && backfill.resumesAt > Date.now() ? new Date(backfill.resumesAt).toISOString() : null,
  };
}

function reportBackfill() {
  backfill.onProgress?.(backfillStatus());
}

/**
 * @param items      `{ text, language }` for every card, duplicates allowed
 * @param voice      the voice clips should be made in
 * @param onProgress called with {@link backfillStatus} as clips finish
 */
async function prepareSpeech(items, voice, onProgress) {
  const core = await loadCore();
  if (!cloud.apiKey()) {
    backfill.error = 'Add a Gemini API key in Settings to make card audio.';
    onProgress?.(backfillStatus());
    return backfillStatus();
  }

  const cached = new Set(existsSync(speechCacheDir()) ? readdirSync(speechCacheDir()) : []);
  const wanted = new Map();
  for (const item of items ?? []) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const language = item?.language;
    if (!text || text.length > core.MAX_SPEECH_CHARACTERS || (language !== 'bs' && language !== 'es')) continue;
    const { name } = speechClipPath(core, text, language, voice);
    wanted.set(name, { name, text, language, recording: `${recordingPath(core, text, language).name}.recording` });
  }

  // A card whose deck came with a recording needs nothing made.
  const missing = [...wanted.values()].filter((item) => !cached.has(`${item.name}.wav`) && !cached.has(item.recording));
  backfill.voice = voice;
  backfill.onProgress = onProgress;
  backfill.stopped = false;
  // A daily-cap pause outlives a new to-do list; the cap has not reset.
  const paused = backfill.resumesAt && backfill.resumesAt > Date.now();
  backfill.error = paused ? backfill.error : null;
  backfill.total = wanted.size;
  backfill.ready = wanted.size - missing.length;
  backfill.failed = 0;
  // Replace the to-do list. Clips already being made finish on their own.
  backfill.queue = missing.filter((item) => !speechInFlight.has(item.name));
  backfill.queued = new Set(backfill.queue.map((item) => item.name));
  backfill.concurrency = paused ? 1 : SPEECH_MAX_CONCURRENCY;
  reportBackfill();
  pumpBackfill();
  return backfillStatus();
}

function pumpBackfill() {
  while (!backfill.stopped && backfill.running < backfill.concurrency && backfill.queue.length > 0) {
    const item = backfill.queue.shift();
    backfill.running++;
    void makeClip(item).finally(() => {
      backfill.running--;
      reportBackfill();
      pumpBackfill();
    });
  }
}

async function makeClip(item, attempt = 0) {
  const wait = backfill.pausedUntil - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (backfill.stopped) return;
  try {
    await speech({ text: item.text, language: item.language, voice: backfill.voice });
    backfill.ready++;
    if (backfill.resumesAt && Date.now() >= backfill.resumesAt) {
      backfill.resumesAt = null;
      backfill.error = null;
    }
  } catch (error) {
    const status = error?.status;
    if (error?.daily) {
      // Out of requests for today. Put the card back and wait for the reset;
      // the cards already waiting behind this one wait too.
      const until = Date.now() + Math.max(60_000, error.retryAfterMs ?? 3_600_000);
      backfill.pausedUntil = Math.max(backfill.pausedUntil, until);
      backfill.resumesAt = backfill.pausedUntil;
      backfill.error = error.message;
      backfill.concurrency = 1;
      reportBackfill();
      return makeClip(item, attempt);
    }
    if (status === 422) {
      // The model said more than the card. Asking again costs a request
      // from a small daily allowance, so it is left for the next pass.
      backfill.failed++;
      backfill.error = error.message;
      return;
    }
    if (status === 401 || status === 403) {
      backfill.stopped = true;
      backfill.error = error.message;
      backfill.queue = [];
      return;
    }
    if ((status === 429 || status === undefined || status >= 500) && attempt < SPEECH_RETRY_LIMIT) {
      if (status === 429) {
        backfill.concurrency = Math.max(1, Math.floor(backfill.concurrency / 2));
        backfill.pausedUntil = Date.now() + Math.max(error?.retryAfterMs ?? 0, 15_000 * (attempt + 1));
      } else {
        backfill.pausedUntil = Date.now() + 3_000 * (attempt + 1);
      }
      return makeClip(item, attempt + 1);
    }
    backfill.failed++;
    backfill.error = error.message;
  }
}

module.exports = {
  sources,
  resolve,
  examples,
  chat,
  speech,
  saveRecordings,
  pendingRecordings,
  markRecordingsUploaded,
  prepareSpeech,
  backfillStatus,
};
