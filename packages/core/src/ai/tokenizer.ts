/**
 * A Llama/SentencePiece-style BPE tokenizer, built from a Hugging Face
 * `tokenizer.json`.
 *
 * ONNX Runtime takes token ids, not text, so something has to do this on
 * device. Shipping a native tokenizer would mean a second binary dependency per
 * platform, and the JavaScript alternatives assume a Node filesystem. It is a
 * few hundred lines to do properly, so it lives here where it can be tested
 * without a 2 GB model.
 *
 * The pieces that matter for correctness:
 *
 *  - **Metaspace normalisation.** Llama has no space token. Spaces become `▁`
 *    and a leading `▁` is prepended, so "hola mundo" tokenises the same way
 *    whether or not it follows a newline.
 *  - **Merge ranks.** BPE repeatedly merges the adjacent pair with the lowest
 *    rank. Getting the ordering wrong still produces valid ids and quietly
 *    wrecks generation quality, so ranks come straight from the merges list.
 *  - **Byte fallback.** Llama's vocabulary covers unknown characters with
 *    `<0xNN>` tokens rather than a single `<unk>`. Without this, any emoji or
 *    rare diacritic in a Bosnian word would collapse to `<unk>` and the model
 *    would generate around a hole in the prompt.
 */

export const METASPACE = '▁';

export interface TokenizerSpecialTokens {
  bos?: string;
  eos?: string;
  unk?: string;
  pad?: string;
}

export interface TokenizerData {
  /** token string -> id */
  vocab: Record<string, number>;
  /** BPE merges, highest priority first, each as "left right". */
  merges: string[];
  specialTokens?: TokenizerSpecialTokens;
  /** Replace spaces with U+2581 and prefix the sequence. Llama does both. */
  metaspace?: boolean;
  /** Emit `<0xNN>` tokens for characters missing from the vocabulary. */
  byteFallback?: boolean;
}

export interface EncodeOptions {
  addBos?: boolean;
  addEos?: boolean;
}

export interface DecodeOptions {
  skipSpecialTokens?: boolean;
}

/**
 * Reads the subset of a Hugging Face `tokenizer.json` this needs. The file is
 * large and mostly configuration that does not apply to inference, so only the
 * model section and the special tokens are pulled out.
 */
export function tokenizerDataFromHuggingFace(json: unknown): TokenizerData {
  const root = json as {
    model?: { vocab?: Record<string, number>; merges?: (string | string[])[]; byte_fallback?: boolean };
    added_tokens?: { content?: string; id?: number; special?: boolean }[];
    decoder?: { type?: string };
    normalizer?: unknown;
  };

  const vocab = { ...(root.model?.vocab ?? {}) };
  for (const added of root.added_tokens ?? []) {
    if (added.content && typeof added.id === 'number') vocab[added.content] = added.id;
  }

  const merges = (root.model?.merges ?? []).map((merge) =>
    Array.isArray(merge) ? merge.join(' ') : merge,
  );

  const specials = (root.added_tokens ?? []).filter((t) => t.special).map((t) => t.content ?? '');

  return {
    vocab,
    merges,
    byteFallback: root.model?.byte_fallback ?? true,
    metaspace: true,
    specialTokens: {
      bos: specials.find((t) => /^<s>|<\|begin/.test(t)) ?? '<s>',
      eos: specials.find((t) => /^<\/s>|<\|end/.test(t)) ?? '</s>',
      unk: specials.find((t) => /unk/i.test(t)) ?? '<unk>',
    },
  };
}

export class BpeTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly idToToken: Map<number, string>;
  private readonly ranks: Map<string, number>;
  private readonly metaspace: boolean;
  private readonly byteFallback: boolean;
  private readonly cache = new Map<string, number[]>();

  readonly bosId: number | null;
  readonly eosId: number | null;
  readonly unkId: number | null;
  readonly specialIds: Set<number>;

  constructor(data: TokenizerData) {
    this.vocab = new Map(Object.entries(data.vocab));
    this.idToToken = new Map();
    for (const [token, id] of this.vocab) this.idToToken.set(id, token);

    this.ranks = new Map();
    data.merges.forEach((merge, rank) => {
      // Merges may be stored as "a b" or, in newer files, as ["a", "b"].
      const separator = merge.indexOf(' ');
      if (separator > 0) this.ranks.set(merge, rank);
    });

    this.metaspace = data.metaspace ?? true;
    this.byteFallback = data.byteFallback ?? true;

    const specials = data.specialTokens ?? {};
    this.bosId = this.lookup(specials.bos);
    this.eosId = this.lookup(specials.eos);
    this.unkId = this.lookup(specials.unk);
    this.specialIds = new Set(
      [this.bosId, this.eosId, this.unkId, this.lookup(specials.pad)].filter(
        (id): id is number => id !== null,
      ),
    );
  }

  get vocabSize(): number {
    return this.vocab.size;
  }

  encode(text: string, options: EncodeOptions = {}): number[] {
    const ids: number[] = [];
    if (options.addBos && this.bosId !== null) ids.push(this.bosId);

    const normalized = this.metaspace
      ? METASPACE + text.replace(/ /g, METASPACE)
      : text;

    // Split on the metaspace boundary so each word is merged independently;
    // BPE never merges across a word start, and this keeps the cache useful.
    for (const piece of splitPieces(normalized, this.metaspace)) {
      ids.push(...this.encodePiece(piece));
    }

    if (options.addEos && this.eosId !== null) ids.push(this.eosId);
    return ids;
  }

  decode(ids: number[], options: DecodeOptions = {}): string {
    const bytes: number[] = [];
    let text = '';

    const flushBytes = () => {
      if (bytes.length === 0) return;
      text += new TextDecoder().decode(new Uint8Array(bytes));
      bytes.length = 0;
    };

    for (const id of ids) {
      if (options.skipSpecialTokens !== false && this.specialIds.has(id)) continue;
      const token = this.idToToken.get(id);
      if (token === undefined) continue;

      const byte = parseByteToken(token);
      if (byte !== null) {
        // Byte tokens can encode one UTF-8 code point across several ids, so
        // they are buffered and decoded together.
        bytes.push(byte);
        continue;
      }

      flushBytes();
      text += token;
    }
    flushBytes();

    return this.metaspace ? text.split(METASPACE).join(' ').replace(/^ /, '') : text;
  }

  /** Ids for a literal string, used to detect stop sequences during decoding. */
  tokenId(token: string): number | null {
    return this.lookup(token);
  }

  private encodePiece(piece: string): number[] {
    const cached = this.cache.get(piece);
    if (cached) return cached;

    let symbols = [...piece];

    // Standard BPE: repeatedly merge the adjacent pair with the best rank.
    for (;;) {
      let bestRank = Infinity;
      let bestIndex = -1;

      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.ranks.get(`${symbols[i]} ${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = i;
        }
      }

      if (bestIndex === -1) break;
      symbols = [
        ...symbols.slice(0, bestIndex),
        symbols[bestIndex]! + symbols[bestIndex + 1]!,
        ...symbols.slice(bestIndex + 2),
      ];
    }

    const ids: number[] = [];
    for (const symbol of symbols) {
      const id = this.vocab.get(symbol);
      if (id !== undefined) {
        ids.push(id);
      } else {
        ids.push(...this.fallback(symbol));
      }
    }

    this.cache.set(piece, ids);
    return ids;
  }

  /** `<0xNN>` tokens for anything the vocabulary does not cover. */
  private fallback(symbol: string): number[] {
    if (!this.byteFallback) {
      return this.unkId !== null ? [this.unkId] : [];
    }

    const ids: number[] = [];
    for (const byte of new TextEncoder().encode(symbol)) {
      const token = `<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`;
      const id = this.vocab.get(token);
      if (id !== undefined) ids.push(id);
      else if (this.unkId !== null) ids.push(this.unkId);
    }
    return ids;
  }

  private lookup(token: string | undefined): number | null {
    if (!token) return null;
    return this.vocab.get(token) ?? null;
  }
}

/** Split on metaspace boundaries, keeping the marker with the word that follows. */
function splitPieces(text: string, metaspace: boolean): string[] {
  if (!metaspace) return [text];
  const pieces: string[] = [];
  let current = '';
  for (const char of text) {
    if (char === METASPACE && current) {
      pieces.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function parseByteToken(token: string): number | null {
  const match = /^<0x([0-9a-fA-F]{2})>$/.exec(token);
  return match ? parseInt(match[1]!, 16) : null;
}
