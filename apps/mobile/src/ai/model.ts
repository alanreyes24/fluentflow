import { BpeTokenizer, tokenizerDataFromHuggingFace, type InferenceRequest } from '@fluentflow/core';
import { loadModelAssets, type ModelAssets } from './assets';

/**
 * On-device text generation with ONNX Runtime.
 *
 * This is a greedy decoder over a decoder-only transformer exported by
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

export interface ModelStatus {
  available: boolean;
  /** Why the model is unavailable, for the settings screen. */
  reason?: string;
  modelPath?: string;
  vocabSize?: number;
}

export interface LlamaShape {
  numLayers: number;
  numKeyValueHeads: number;
  headDim: number;
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

  const promptIds = tokenizer.encode(request.prompt, { addBos: true });
  const generated: number[] = [];

  let past = emptyCache(ort, shape);
  let inputIds = promptIds;
  let position = 0;
  let text = '';

  for (let step = 0; step < request.maxTokens; step++) {
    if (request.signal?.aborted) break;

    const totalLength = position + inputIds.length;
    const feeds: Record<string, OrtTensor> = {
      input_ids: bigIntTensor(ort, inputIds, [1, inputIds.length]),
      attention_mask: bigIntTensor(ort, filled(totalLength, 1), [1, totalLength]),
      ...past,
    };

    // Not every export declares position_ids; feeding an undeclared input is an
    // error, so it is only added when the graph asks for it.
    if (session.inputNames.includes('position_ids')) {
      feeds.position_ids = bigIntTensor(
        ort,
        inputIds.map((_, index) => position + index),
        [1, inputIds.length],
      );
    }

    const outputs = await session.run(feeds);
    const logits = outputs.logits;
    if (!logits) throw new Error('The model produced no logits output.');

    const next = argmaxLastToken(logits);
    if (next === tokenizer.eosId) break;

    generated.push(next);
    text = tokenizer.decode(generated);

    // Stopping on the decoded text rather than on token ids: a stop sequence
    // like "</s>" or "Instruct:" can straddle a token boundary and would never
    // match as a single id.
    if (request.stop.some((stop) => text.includes(stop))) {
      for (const stop of request.stop) {
        const at = text.indexOf(stop);
        if (at !== -1) text = text.slice(0, at);
      }
      break;
    }

    // A complete JSON array is all the caller wanted; continuing past it just
    // spends budget on text that gets discarded.
    if (text.includes(']')) break;

    position += inputIds.length;
    inputIds = [next];
    past = presentToPast(outputs, shape);
  }

  return text;
}

// --- tensor plumbing --------------------------------------------------------

function bigIntTensor(ort: OrtModule, values: number[], dims: readonly number[]): OrtTensor {
  return new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);
}

/** A zero-length cache, which is what the first forward pass expects. */
function emptyCache(ort: OrtModule, shape: LlamaShape): Record<string, OrtTensor> {
  const feeds: Record<string, OrtTensor> = {};
  const dims = [1, shape.numKeyValueHeads, 0, shape.headDim] as const;
  for (let layer = 0; layer < shape.numLayers; layer++) {
    feeds[`past_key_values.${layer}.key`] = new ort.Tensor('float32', new Float32Array(0), dims);
    feeds[`past_key_values.${layer}.value`] = new ort.Tensor('float32', new Float32Array(0), dims);
  }
  return feeds;
}

/** Rename this step's `present.*` outputs into the next step's `past_key_values.*`. */
function presentToPast(
  outputs: Record<string, OrtTensor>,
  shape: LlamaShape,
): Record<string, OrtTensor> {
  const past: Record<string, OrtTensor> = {};
  for (let layer = 0; layer < shape.numLayers; layer++) {
    const key = outputs[`present.${layer}.key`];
    const value = outputs[`present.${layer}.value`];
    if (!key || !value) {
      throw new Error(
        `The model did not return a KV cache for layer ${layer}. ` +
          'Export it with use_cache=True (see scripts/prepare-model.mjs).',
      );
    }
    past[`past_key_values.${layer}.key`] = key;
    past[`past_key_values.${layer}.value`] = value;
  }
  return past;
}

/** Greedy pick over the final position's logits. */
function argmaxLastToken(logits: OrtTensor): number {
  const vocabSize = logits.dims[logits.dims.length - 1] ?? 0;
  const data = logits.data as ArrayLike<number>;
  const offset = data.length - vocabSize;

  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < vocabSize; i++) {
    const score = Number(data[offset + i]);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function filled(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}

/**
 * Read the cache geometry from the model's `config.json`.
 *
 * `num_key_value_heads` differs from `num_attention_heads` on models that use
 * grouped-query attention — TinyLlama has 32 attention heads but only 4 KV
 * heads — and using the wrong one produces a shape mismatch on the second
 * token, after the first pass has already succeeded.
 */
function shapeFrom(config: unknown): LlamaShape {
  const c = (config ?? {}) as {
    num_hidden_layers?: number;
    num_attention_heads?: number;
    num_key_value_heads?: number;
    hidden_size?: number;
    head_dim?: number;
  };

  const numLayers = c.num_hidden_layers ?? 22;
  const numAttentionHeads = c.num_attention_heads ?? 32;
  const numKeyValueHeads = c.num_key_value_heads ?? numAttentionHeads;
  const hiddenSize = c.hidden_size ?? 2048;
  const headDim = c.head_dim ?? Math.floor(hiddenSize / numAttentionHeads);

  return { numLayers, numKeyValueHeads, headDim };
}

/** Drop the loaded session, e.g. when the settings screen clears the cache. */
export async function releaseModel(): Promise<void> {
  const model = await sessionPromise;
  await model?.session.release?.();
  sessionPromise = null;
}
