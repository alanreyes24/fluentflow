import type { BpeTokenizer } from './tokenizer.js';
import type { InferenceRequest } from './generate.js';

/**
 * The decode loop for a decoder-only transformer, with KV cache reuse.
 *
 * This used to live in the Expo app, next to `onnxruntime-react-native`. It
 * moved here when the desktop shell needed the same loop against
 * `onnxruntime-node`: two copies of a decode loop is two places for the KV
 * cache to be subtly wrong, and the bug it produces — correct first token,
 * garbage afterwards — is the same one twice.
 *
 * Greedy by default and sampling on request. Both callers are in this package's
 * consumers and they want different things — one right answer for a
 * translation, two different sentences for a card — so the choice is a
 * parameter of the request rather than a property of the loop. See
 * {@link DecodeRequest.temperature}.
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

export interface DecodeRequest extends InferenceRequest {
  /**
   * Stop as soon as the text holds a complete JSON array.
   *
   * Example generation asks for one and has everything it needs the moment the
   * bracket closes; translation asks for a bare word and must not stop on a
   * bracket that will never come.
   */
  stopOnJsonArray?: boolean;

  /**
   * How much randomness to allow. Zero — the default — is greedy argmax.
   *
   * The two jobs this loop does want opposite things here, which is why it is a
   * parameter rather than a constant.
   *
   * Translation wants zero. There is one right answer, the highest-scoring
   * token is the model's best guess at it, and a wrong guess becomes a card
   * that teaches the wrong word. Reproducibility is worth having too: the same
   * word looked up twice should not give two different meanings.
   *
   * Example generation cannot use zero, and the reason is not a preference. Ask
   * a model greedily for two sentences and both array slots decode from nearly
   * the same state, so it writes the same sentence twice — `zdravo` came back
   * as ["Zdravo, kako ste?", "Zdravo, kako ste?"] every time, and asking for
   * three produced three copies. Deduplication then leaves one example where
   * two were wanted. Sampling is what makes the second sentence a second
   * sentence, and it is also the only thing that makes the UI's "Regenerate"
   * button able to return anything new.
   */
  temperature?: number;

  /**
   * Sample from this many of the highest-scoring tokens. Ignored when greedy.
   *
   * The tail of a 150k-token vocabulary is mostly noise that happens to be
   * non-zero, and a small model's tail includes fluent-looking wrong-language
   * tokens. Cutting to the plausible few keeps the sentence in the language it
   * was asked for while still leaving room for it to differ.
   */
  topK?: number;

  /** Seed the sampler, so a sampled decode can be reproduced in a test. */
  seed?: number;
}

/**
 * Sampling settings for writing example sentences.
 *
 * One definition rather than a number in each platform's inference wrapper: the
 * phone and the desktop shell run the same loop over the same models, and two
 * copies of a tuning constant is two copies that drift until a card reveal
 * behaves differently depending on where it happened.
 *
 * Measured against Qwen2.5-1.5B on the same five words at 0.4, 0.55, 0.7 and
 * 0.8. Too low and the sampler collapses back towards greedy, repeating the
 * sentence it was supposed to vary; 0.4 still lost a word to a duplicate. Too
 * high and it invents vocabulary — 0.8 produced "amamorando", which is not a
 * Spanish word. 0.7 gave two distinct sentences for all five and the most
 * plausible Spanish of the four. Above that, diversity stops improving and
 * validation rejections start, which turns a diversity knob into a fallback
 * rate.
 */
export const EXAMPLE_SAMPLING = { temperature: 0.7, topK: 40 } as const;

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
 * Greedy by default; see {@link DecodeRequest.temperature} for when it is not
 * and why that is not a matter of taste.
 *
 * @returns the decoded text, with any stop sequence trimmed off
 */
export async function decode(
  runtime: OrtLike,
  session: OrtLikeSession,
  tokenizer: BpeTokenizer,
  shape: LlamaShape,
  request: DecodeRequest,
): Promise<string> {
  const promptIds = tokenizer.encode(request.prompt, { addBos: request.addBos ?? true });
  const generated: number[] = [];
  const pick = tokenPicker(request);

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

    const next = pick(logits);
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

// --- choosing the next token ------------------------------------------------

/** Sampling looks at this many candidates unless told otherwise. */
const DEFAULT_TOP_K = 40;

/**
 * The function that turns a step's logits into the next token id.
 *
 * Built once per request rather than branching inside the loop, so the greedy
 * path stays exactly what it was: a single pass over the final position.
 */
function tokenPicker(request: DecodeRequest): (logits: OrtLikeTensor) => number {
  const temperature = request.temperature ?? 0;
  if (temperature <= 0) return argmaxLastToken;

  const topK = Math.max(1, request.topK ?? DEFAULT_TOP_K);
  const random = seededRandom(request.seed);
  return (logits) => sampleLastToken(logits, temperature, topK, random);
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

/**
 * Sample from the `topK` highest-scoring tokens at the final position.
 *
 * The top-k selection is a bounded insertion into a small array rather than a
 * sort of the whole row. Sorting 150k logits at every step costs more than the
 * forward pass that produced them.
 */
function sampleLastToken(
  logits: OrtLikeTensor,
  temperature: number,
  topK: number,
  random: () => number,
): number {
  const vocabSize = logits.dims[logits.dims.length - 1] ?? 0;
  const data = logits.data as ArrayLike<number>;
  const offset = data.length - vocabSize;

  const ids: number[] = [];
  const scores: number[] = [];

  for (let i = 0; i < vocabSize; i++) {
    const score = Number(data[offset + i]);
    if (scores.length < topK) {
      insertDescending(ids, scores, i, score);
    } else if (score > scores[scores.length - 1]!) {
      ids.pop();
      scores.pop();
      insertDescending(ids, scores, i, score);
    }
  }

  // Softmax over the survivors, shifted by the maximum so that exp() cannot
  // overflow. The maximum is scores[0]: the array is kept in descending order.
  const max = scores[0] ?? 0;
  let total = 0;
  const weights = scores.map((score) => {
    const weight = Math.exp((score - max) / temperature);
    total += weight;
    return weight;
  });

  let target = random() * total;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i]!;
    if (target <= 0) return ids[i]!;
  }

  // Only reachable through floating-point drift, and the best candidate is the
  // right answer when it happens.
  return ids[0] ?? 0;
}

function insertDescending(ids: number[], scores: number[], id: number, score: number): void {
  let at = scores.length;
  while (at > 0 && scores[at - 1]! < score) at--;
  ids.splice(at, 0, id);
  scores.splice(at, 0, score);
}

/**
 * A small deterministic PRNG (mulberry32), so a seeded decode is reproducible.
 *
 * `Math.random` cannot be seeded, and a sampled decode that cannot be repeated
 * is a decode that cannot be tested — or reported in a bug.
 */
function seededRandom(seed?: number): () => number {
  let state = (seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function filled(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}
