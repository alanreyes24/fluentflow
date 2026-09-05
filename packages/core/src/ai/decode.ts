import type { BpeTokenizer } from './tokenizer.js';
import type { InferenceRequest } from './generate.js';

/**
 * Greedy decoding over a decoder-only transformer, with KV cache reuse.
 *
 * This used to live in the Expo app, next to `onnxruntime-react-native`. It
 * moved here when the desktop shell needed the same loop against
 * `onnxruntime-node`: two copies of a decode loop is two places for the KV
 * cache to be subtly wrong, and the bug it produces — correct first token,
 * garbage afterwards — is the same one twice.
 *
 * ONNX Runtime is not imported. The runtime is injected as {@link OrtLike},
 * which is the same seam `parseApkg` uses for SQLite: the platform supplies the
 * binding, core supplies the logic, and the logic can be tested against a fake
 * session with no 600 MB model anywhere near it.
 *
 * The cache is the whole ballgame for the time budget. Without it every new
 * token re-reads the entire prompt, so 40 tokens over a 120-token prompt costs
 * roughly twenty times the work of doing it properly.
 */

export interface OrtLikeTensor {
  readonly data: ArrayLike<number> | BigInt64Array;
  readonly dims: readonly number[];
}

export interface OrtLikeSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, OrtLikeTensor>): Promise<Record<string, OrtLikeTensor>>;
}

export interface OrtLike {
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ) => OrtLikeTensor;
}

/**
 * KV cache geometry.
 *
 * `numKeyValueHeads` is not `num_attention_heads`. Grouped-query models have
 * fewer KV heads than attention heads — TinyLlama has 32 and 4, Qwen2.5 has 14
 * and 2 — and using the attention count succeeds on the first token, then
 * fails on the second with a shape mismatch, long after you have stopped
 * suspecting the cache.
 */
export interface LlamaShape {
  numLayers: number;
  numKeyValueHeads: number;
  headDim: number;
}

export interface GreedyDecodeOptions extends InferenceRequest {
  /**
   * Stop as soon as the text holds a complete JSON array.
   *
   * Example generation asks for one and has everything it needs the moment the
   * bracket closes; translation asks for a bare word and must not stop on a
   * bracket that will never come.
   */
  stopOnJsonArray?: boolean;
}

/**
 * Read the cache geometry out of a model's `config.json`.
 *
 * @throws if the fields that decide the cache shape are missing, because the
 *         alternative is a shape mismatch several layers deeper.
 */
export function shapeFromConfig(config: unknown): LlamaShape {
  const values = (config ?? {}) as Record<string, unknown>;
  const layers = Number(values.num_hidden_layers ?? values.n_layer ?? 0);
  const attentionHeads = Number(values.num_attention_heads ?? values.n_head ?? 0);
  const kvHeads = Number(values.num_key_value_heads ?? attentionHeads);
  const hidden = Number(values.hidden_size ?? values.n_embd ?? 0);

  if (!layers || !attentionHeads || !hidden) {
    throw new Error(
      'The model config is missing num_hidden_layers, num_attention_heads or hidden_size.',
    );
  }

  return { numLayers: layers, numKeyValueHeads: kvHeads, headDim: hidden / attentionHeads };
}

/**
 * Run the model until it stops, the budget is cancelled, or `maxTokens` is hit.
 *
 * @returns the decoded text, with any stop sequence trimmed off
 */
export async function decodeGreedy(
  runtime: OrtLike,
  session: OrtLikeSession,
  tokenizer: BpeTokenizer,
  shape: LlamaShape,
  request: GreedyDecodeOptions,
): Promise<string> {
  const promptIds = tokenizer.encode(request.prompt, { addBos: request.addBos ?? true });
  const generated: number[] = [];

  let past = emptyCache(runtime, shape);
  let inputIds = promptIds;
  let position = 0;
  let text = '';

  for (let step = 0; step < request.maxTokens; step++) {
    if (request.signal?.aborted) break;

    const totalLength = position + inputIds.length;
    const feeds: Record<string, OrtLikeTensor> = {
      input_ids: bigIntTensor(runtime, inputIds, [1, inputIds.length]),
      attention_mask: bigIntTensor(runtime, filled(totalLength, 1), [1, totalLength]),
      ...past,
    };

    // Not every export declares position_ids; feeding an undeclared input is an
    // error, so it is only added when the graph asks for it.
    if (session.inputNames.includes('position_ids')) {
      feeds.position_ids = bigIntTensor(
        runtime,
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

    if (request.stopOnJsonArray && text.includes(']')) break;

    position += inputIds.length;
    inputIds = [next];
    past = presentToPast(outputs, shape);
  }

  return text;
}

// --- tensor plumbing --------------------------------------------------------

function bigIntTensor(
  runtime: OrtLike,
  values: number[],
  dims: readonly number[],
): OrtLikeTensor {
  return new runtime.Tensor('int64', BigInt64Array.from(values, BigInt), dims);
}

/** A zero-length cache, which is what the first forward pass expects. */
export function emptyCache(runtime: OrtLike, shape: LlamaShape): Record<string, OrtLikeTensor> {
  const feeds: Record<string, OrtLikeTensor> = {};
  const dims = [1, shape.numKeyValueHeads, 0, shape.headDim] as const;
  for (let layer = 0; layer < shape.numLayers; layer++) {
    feeds[`past_key_values.${layer}.key`] = new runtime.Tensor('float32', new Float32Array(0), dims);
    feeds[`past_key_values.${layer}.value`] = new runtime.Tensor('float32', new Float32Array(0), dims);
  }
  return feeds;
}

/** Rename this step's `present.*` outputs into the next step's `past_key_values.*`. */
function presentToPast(
  outputs: Record<string, OrtLikeTensor>,
  shape: LlamaShape,
): Record<string, OrtLikeTensor> {
  const past: Record<string, OrtLikeTensor> = {};
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
function argmaxLastToken(logits: OrtLikeTensor): number {
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
