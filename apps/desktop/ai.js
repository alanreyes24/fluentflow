'use strict';

/**
 * The on-device model, and the two jobs it does.
 *
 *  - `resolve` fills in the meanings a pasted word list does not carry.
 *  - `examples` writes sentences showing a word in use, for a card reveal.
 *
 * They want opposite things from the same model, which is why they are tuned
 * separately. Translation is a lookup the model is bad at: on twelve Spanish
 * words the bilingual dictionary got all twelve right in 2 ms and the model got
 * about seven in 21 seconds, so there the model is the long tail behind the
 * dictionary and every answer it gives is marked for review. Generation has no
 * dictionary to lose to — no lookup table contains a sentence — and the model
 * is good at it, so there it is the only source and its output is used directly.
 * What keeps that honest is validation, not trust: core rejects a sentence that
 * does not contain the word it was meant to demonstrate.
 *
 * Both run here, in the main process, rather than in the renderer. The renderer
 * is the Expo web export and its inference path (`onnxruntime-react-native`) is
 * a native *mobile* module that cannot load here — which is why the desktop
 * build used to fall back to carrier sentences on every reveal.
 * `onnxruntime-node` does load here, where there is a real Node runtime and no
 * content security policy in the way.
 *
 * It also keeps a 1 GB session and a decode loop off the UI thread. Both jobs
 * are seconds of work — a long paste is a minute of it — and in the renderer
 * that would freeze the window for the duration instead of leaving the rating
 * buttons live while the sentences arrive.
 *
 * The decode loop and the prompting are `@fluentflow/core`'s, the same code the
 * phone runs. Only the runtime and the file paths differ.
 *
 * The model is not bundled. It is over a gigabyte, which would be most of the
 * installer, so it lives in the user data directory and
 * `npm run fetch-model` puts it there.
 */

const { app } = require('electron');
const path = require('node:path');
const { existsSync, readFileSync } = require('node:fs');
const dictionary = require('./dictionary');

const MODEL_FILES = ['model.onnx', 'tokenizer.json', 'config.json'];

/** Chat templates differ per family, and the wrong one produces fluent nonsense. */
const FAMILY_BY_MODEL_TYPE = {
  qwen2: 'qwen',
  qwen3: 'qwen',
  llama: 'tinyllama',
  phi: 'phi2',
};

let loaded = null;

function modelDir() {
  return (
    process.env.FLUENTFLOW_MODEL_DIR ||
    path.join(app.getPath('userData'), 'models')
  );
}

/** What the UI needs to know before offering to translate anything. */
function status() {
  const dir = modelDir();
  const missing = MODEL_FILES.filter((file) => !existsSync(path.join(dir, file)));

  if (missing.length > 0) {
    return {
      available: false,
      dir,
      reason: `No model in ${dir} (missing ${missing.join(', ')}). Run: npm run fetch-model`,
    };
  }

  try {
    const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return {
      available: true,
      dir,
      name: config._name_or_path || 'local model',
      family: FAMILY_BY_MODEL_TYPE[config.model_type] || 'raw',
    };
  } catch (error) {
    return { available: false, dir, reason: `The model config could not be read: ${error.message}` };
  }
}

/**
 * Load the runtime, the tokenizer and the session once, and keep them.
 *
 * Session creation is the expensive part — several seconds for a graph this
 * size — and a word list means one request per word. Paying it per word would
 * make a twelve-word paste take a minute of setup and a few seconds of work.
 */
async function load() {
  if (loaded) return loaded;

  const state = status();
  if (!state.available) throw new Error(state.reason);

  const ort = require('onnxruntime-node');
  const core = await import('@fluentflow/core');

  const tokenizerJson = JSON.parse(readFileSync(path.join(state.dir, 'tokenizer.json'), 'utf8'));
  const config = JSON.parse(readFileSync(path.join(state.dir, 'config.json'), 'utf8'));

  const tokenizer = new core.BpeTokenizer(core.tokenizerDataFromHuggingFace(tokenizerJson));
  const shape = core.shapeFromConfig(config);
  const session = await ort.InferenceSession.create(path.join(state.dir, 'model.onnx'));

  loaded = { core, ort, tokenizer, shape, session, family: state.family, name: state.name };
  return loaded;
}

/**
 * Find a meaning for every word.
 *
 * The dictionary answers what it can; the model is loaded only if something is
 * left over, which means a list of ordinary words never pays the several
 * seconds a session takes to start.
 *
 * @param words     the words, in the deck's language
 * @param language  'es' or 'bs'
 * @param onProgress called as words are resolved, for the progress bar
 * @returns one result per word, each carrying the source it came from
 */
async function resolve(words, language, onProgress) {
  const core = await import('@fluentflow/core');

  const lookup = dictionary.status().languages[language]
    ? (word) => dictionary.lookup(language, word)
    : null;

  // Peek: if the dictionary covers everything, the model is never loaded.
  const missing = lookup
    ? words.filter((word) => lookup(word).length === 0)
    : words;

  let infer = null;
  let family;
  if (missing.length > 0 && status().available) {
    const model = await load();
    family = model.family;
    infer = (request) =>
      model.core.decode(model.ort, model.session, model.tokenizer, model.shape, request);
  }

  return core.resolveMeanings(words, language, {
    dictionary: lookup,
    infer,
    family,
    onProgress,
  });
}

/**
 * How long a card reveal may spend generating example sentences.
 *
 * Far longer than the phone's two seconds, and deliberately so. On the phone
 * the budget protects the UI thread; here the model runs in the main process,
 * so the window stays interactive and the rating buttons work while it thinks —
 * the study screen shows "Writing examples…" and does not wait for it.
 *
 * The number comes from measurement, not taste: Qwen2.5-1.5B q4f16 on an
 * M-series Mac took 3.5–6.2 s to write two sentences, and the retry doubles the
 * worst case. Thirty seconds leaves room for a slower machine without leaving a
 * stuck request running until the user gives up on the app instead.
 */
const EXAMPLE_BUDGET_MS = 30000;

/**
 * Two sentences of Spanish run to about 50 tokens, and the decode stops on the
 * closing bracket anyway. The headroom is for the retry, which asks for three.
 */
const EXAMPLE_MAX_TOKENS = 128;

/**
 * Write example sentences showing the word in use.
 *
 * This is the other half of what the model is here for, and the one the
 * renderer could never do for itself. `onnxruntime-react-native` is a native
 * mobile module, so the renderer's own inference path is dead on the desktop —
 * which is why every reveal fell back to a carrier sentence that quotes the
 * word rather than using it. The pipeline, the prompting and the validation are
 * all `@fluentflow/core`'s, the same code the phone runs.
 *
 * The session is loaded before the budget starts. Creating it takes about three
 * seconds for a graph this size, and charging the first card of a session for
 * that would spend most of its budget before a single token was generated.
 *
 * @param request `{ word, meaning, language, count }`
 * @returns a `GenerateExamplesResult`: sentences, and which source wrote them
 */
async function examples(request) {
  const core = await import('@fluentflow/core');
  const { word, meaning, language, count = 2 } = request ?? {};

  const state = status();
  if (!state.available) {
    // Not an error: core answers with carrier sentences, and the UI labels
    // them. A missing model is a thing to install, not a thing to crash on.
    return core.generateExamples({ word, meaning, language, count }, { infer: null });
  }

  const model = await load();

  return core.generateExamples(
    { word, meaning, language, count },
    {
      infer: (inferenceRequest) =>
        model.core.decode(model.ort, model.session, model.tokenizer, model.shape, {
          ...inferenceRequest,
          // The answer is a JSON array and is complete the moment the bracket
          // closes; without this the model spends its remaining tokens writing
          // a cheerful paragraph about what it just wrote.
          stopOnJsonArray: true,
          // Not a flourish: decoded greedily this model writes the same
          // sentence into both slots of the array, so "two examples" arrives as
          // one. See EXAMPLE_SAMPLING in core.
          ...core.EXAMPLE_SAMPLING,
        }),
      family: model.family,
      budgetMs: EXAMPLE_BUDGET_MS,
      maxTokens: EXAMPLE_MAX_TOKENS,
      // Worth the second inference here, where there is budget for it. Between
      // the sampling above and core asking for a different number of sentences
      // on the retry, a second attempt is a genuinely second answer.
      retryOnParseFailure: true,
    },
  );
}

/** Drop the session, so a newly fetched model is picked up without a restart. */
function unload() {
  loaded = null;
}

/** What the UI needs to decide what to offer: both sources, separately. */
function sources() {
  return { model: status(), dictionary: dictionary.status() };
}

module.exports = { status, sources, resolve, examples, unload, modelDir };
