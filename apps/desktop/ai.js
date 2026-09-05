'use strict';

/**
 * Filling in the meanings a pasted word list does not carry.
 *
 * Two sources, in order: the bilingual dictionary, then the model for whatever
 * the dictionary did not have. The ordering is not a detail — on the same
 * twelve Spanish words the dictionary got all twelve right in 2 ms and the
 * model got about seven in 21 seconds — so the model's job here is the long
 * tail and nothing else. `resolveMeanings` in core is where that policy lives.
 *
 * The renderer is the Expo web export, and its inference path
 * (`onnxruntime-react-native`) is a native *mobile* module that cannot load
 * here — which is why the desktop build has always fallen back to written
 * example sentences. `onnxruntime-node` can load here, in the main process,
 * where there is a real Node runtime and no content security policy in the way.
 *
 * So the model runs in main and the renderer asks for translations over IPC.
 * That also keeps a 1 GB session and a decode loop off the UI thread: a
 * long paste is a minute of work, and doing it in the renderer would freeze
 * the window for the duration.
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
      model.core.decodeGreedy(model.ort, model.session, model.tokenizer, model.shape, request);
  }

  return core.resolveMeanings(words, language, {
    dictionary: lookup,
    infer,
    family,
    onProgress,
  });
}

/** Drop the session, so a newly fetched model is picked up without a restart. */
function unload() {
  loaded = null;
}

/** What the UI needs to decide what to offer: both sources, separately. */
function sources() {
  return { model: status(), dictionary: dictionary.status() };
}

module.exports = { status, sources, resolve, unload, modelDir };
