import {
  BpeTokenizer,
  decodeGreedy,
  shapeFromConfig,
  tokenizerDataFromHuggingFace,
  type InferenceRequest,
  type LlamaShape,
  type OrtLike,
  type OrtLikeSession,
} from '@fluentflow/core';
import { loadModelAssets, type ModelAssets } from './assets';

/**
 * On-device text generation with ONNX Runtime.
 *
 * The decode loop itself is in `@fluentflow/core`: the desktop shell runs the
 * same models through `onnxruntime-node`, and a second copy of a KV cache loop
 * is a second place for it to be subtly wrong. What stays here is the part that
 * is genuinely React Native — loading the optional native module and reading
 * the model files off the device.
 *
 * The shared loop decodes greedily over a decoder-only transformer exported by
 * Optimum, which gives the conventional signature:
 *
 *   inputs   input_ids, attention_mask, position_ids,
 *            past_key_values.{layer}.{key,value}
 *   outputs  logits, present.{layer}.{key,value}
 *
 * The KV cache is the whole ballgame for the 2-second budget. Without it every
 * new token re-reads the entire prompt, so generating 40 tokens costs 40 full
 * forward passes over ~120 tokens of prompt — roughly 20x the work. With it,
 * only the first pass is long and each subsequent step processes a single
 * token.
 *
 * `onnxruntime-react-native` is an optional dependency: it is a native module,
 * so it needs a development build rather than Expo Go, and the app must stay
 * fully usable without it. Metro substitutes a stub when it is not installed
 * (see metro.config.js), so the require below always resolves and the check is
 * on what came back. Every failure path here ends at "no model", and the
 * example pipeline falls back to written sentences.
 */

/** Minimal slice of the ONNX Runtime API this file uses. */
interface OrtTensor {
  readonly data: ArrayLike<number> | BigInt64Array;
  readonly dims: readonly number[];
}

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

interface OrtModule {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ) => OrtTensor;
}

export type { LlamaShape };

export interface ModelStatus {
  available: boolean;
  /** Why the model is unavailable, for the settings screen. */
  reason?: string;
  modelPath?: string;
  vocabSize?: number;
}

let ortModule: OrtModule | null | undefined;
let sessionPromise: Promise<LoadedModel | null> | null = null;

interface LoadedModel {
  session: OrtSession;
  tokenizer: BpeTokenizer;
  shape: LlamaShape;
  assets: ModelAssets;
}

/**
 * Load ONNX Runtime, if it is installed.
 *
 * `undefined` means "not tried yet"; `null` means "tried and unavailable", so
 * a missing native module is probed once rather than on every card reveal.
 *
 * The require is a plain static specifier on purpose — see the note above about
 * why dynamic import and try/catch both fail here.
 */
function loadOrt(): OrtModule | null {
  if (ortModule !== undefined) return ortModule;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const imported = require('onnxruntime-react-native') as Partial<OrtModule> & {
      default?: Partial<OrtModule>;
    };
    const resolved = imported.InferenceSession ? imported : imported.default;
    // The stub has no InferenceSession, which is how "not installed" is read.
    ortModule = resolved?.InferenceSession && resolved.Tensor ? (resolved as OrtModule) : null;
  } catch {
    ortModule = null;
  }

  return ortModule;
}

async function loadModel(): Promise<LoadedModel | null> {
  const ort = loadOrt();
  if (!ort) return null;

  const assets = await loadModelAssets();
  if (!assets) return null;

  const session = await ort.InferenceSession.create(assets.modelPath, {
    // Fewer threads than cores on purpose: the UI thread has to stay responsive
    // while this runs, and small models see little benefit past four.
    interOpNumThreads: 1,
    intraOpNumThreads: 4,
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  });

  const tokenizer = new BpeTokenizer(tokenizerDataFromHuggingFace(assets.tokenizerJson));
  const shape = shapeFrom(assets.configJson);

  return { session, tokenizer, shape, assets };
}

export function modelSession(): Promise<LoadedModel | null> {
  sessionPromise ??= loadModel().catch(() => null);
  return sessionPromise;
}

export async function modelStatus(): Promise<ModelStatus> {
  const ort = loadOrt();
  if (!ort) {
    return {
      available: false,
      reason: 'onnxruntime-react-native is not installed in this build.',
    };
  }

  const assets = await loadModelAssets();
  if (!assets) {
    return { available: false, reason: 'Model weights are not bundled. Run npm run prepare-model.' };
  }

  const model = await modelSession();
  if (!model) {
    return { available: false, reason: 'The model could not be loaded.' };
  }

  return {
    available: true,
    modelPath: model.assets.modelPath,
    vocabSize: model.tokenizer.vocabSize,
  };
}

/**
 * An {@link InferenceFn} for the core example pipeline, or `null` when no model
 * is available — which is what makes the pipeline choose its fallback.
 */
export async function createInference(): Promise<((request: InferenceRequest) => Promise<string>) | null> {
  const model = await modelSession();
  if (!model) return null;
  return (request) => generate(model, request);
}

async function generate(model: LoadedModel, request: InferenceRequest): Promise<string> {
  const { session, tokenizer, shape } = model;
  const ort = loadOrt();
  if (!ort) throw new Error('ONNX Runtime went away mid-request.');

  return decodeGreedy(ort as unknown as OrtLike, session as unknown as OrtLikeSession, tokenizer, shape, {
    ...request,
    // Example generation asks for a JSON array and has what it needs the
    // moment the bracket closes.
    stopOnJsonArray: true,
  });
}

/**
 * Read the cache geometry from the model's `config.json`.
 *
 * The rules live in core with the decode loop that depends on them; this is
 * only where the file gets read on a device.
 */
function shapeFrom(config: unknown): LlamaShape {
  return shapeFromConfig(config);
}
