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

const dictionary = require('./dictionary');
const cloud = require('./cloud');

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
 * The dictionary answers what it can and the hosted model is asked only about
 * the leftovers, which means a list of ordinary words costs nothing and makes
 * no network request at all.
 *
 * `useModel` is how the import screen keeps that promise visible. It runs this
 * once with the flag off — free, offline, instant, and it covers most word
 * lists outright — and only offers to spend the user's key on what is left
 * over, behind one button naming the words it will send. Defaulting to true
 * keeps every other caller behaving as it did.
 *
 * @param words     the words, in the deck's language
 * @param language  'es' or 'bs'
 * @param onProgress called as words are resolved, for the progress bar
 * @param useModel  false to answer from the dictionary alone and bill nothing
 * @param modelOnly skip the dictionary and ask the hosted model for a fresh answer
 * @returns meanings plus measured Gemini usage when the model was called
 */
async function resolve(words, language, onProgress, useModel = true, modelOnly = false) {
  const core = await import('@fluentflow/core');
  const usages = [];

  const lookup = !modelOnly && dictionary.status().languages[language]
    ? (word) => dictionary.lookup(language, word)
    : null;

  // Peek: if the dictionary covers everything, nothing is sent anywhere.
  const missing = lookup ? words.filter((word) => lookup(word).length === 0) : words;

  const infer = useModel && missing.length > 0
    ? remoteInference(core, undefined, (usage) => usages.push(usage))
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
  const core = await import('@fluentflow/core');
  const { word, meaning, language, count = 2 } = request ?? {};

  return core.generateExamples(
    { word, meaning, language, count },
    {
      infer: remoteInference(core, core.EXAMPLES_SCHEMA),
      budgetMs: EXAMPLE_BUDGET_MS,
      maxTokens: EXAMPLE_MAX_TOKENS,
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

module.exports = { sources, resolve, examples };
