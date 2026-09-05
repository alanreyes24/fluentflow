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
 *
 * Two vocabularies matter now, and they disagree about all of the above.
 * Everything after Llama 2 — Llama 3, Qwen, Mistral's newer releases — uses
 * **byte-level** BPE instead: no metaspace, no `<0xNN>` fallback, every byte
 * mapped into a printable character (a space is `Ġ`) so the vocabulary covers
 * all 256 by construction. Text is also split by a regex before merging, which
 * is what stops BPE from merging across a word boundary. `byteLevel` selects
 * that path; the merge loop underneath is shared.
 *
 * Special tokens are cut out before any of this. A chat template is mostly
 * `<|im_start|>`-shaped markers, and running those through BPE turns each into
 * a handful of ordinary character tokens the model has never seen in that
 * arrangement — it answers, but badly, which is a horrible thing to debug.
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
  /** GPT-2 style byte-level BPE: bytes mapped to printable characters. */
  byteLevel?: boolean;
  /** Unicode normalisation to apply before encoding. Qwen declares NFC. */
  normalize?: 'NFC' | 'NFKC' | null;
  /** Tokens that must never be split, e.g. chat markers. */
  addedTokens?: string[];
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
    pre_tokenizer?: unknown;
    decoder?: unknown;
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

  // A ByteLevel pre-tokenizer or decoder is what distinguishes the two
  // families. It can sit inside a Sequence, so the whole subtree is searched.
  const byteLevel =
    hasByteLevel(root.pre_tokenizer) || hasByteLevel(root.decoder);

  const normalizerType = (root.normalizer as { type?: string } | undefined)?.type;

  return {
    vocab,
    merges,
    byteFallback: root.model?.byte_fallback ?? !byteLevel,
    // Metaspace and byte level are alternatives, never both.
    metaspace: !byteLevel,
    byteLevel,
    normalize: normalizerType === 'NFC' || normalizerType === 'NFKC' ? normalizerType : null,
    addedTokens: (root.added_tokens ?? [])
      .map((t) => t.content)
      .filter((content): content is string => Boolean(content)),
    specialTokens: {
      // Exact matches in priority order. A prefix test used to be enough, but
      // Qwen ships both `<|endoftext|>` and `<|im_end|>` and a chat exchange
      // ends on the second — stopping on the wrong one means never stopping.
      bos: pickToken(specials, ['<s>', '<|begin_of_text|>', '<|endoftext|>']) ?? '<s>',
      eos: pickToken(specials, ['</s>', '<|im_end|>', '<|eot_id|>', '<|endoftext|>']) ?? '</s>',
      unk: specials.find((t) => /unk/i.test(t)) ?? '<unk>',
    },
  };
}

function pickToken(available: string[], preferred: string[]): string | undefined {
  return preferred.find((candidate) => available.includes(candidate));
}

function hasByteLevel(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const value = node as { type?: string; pretokenizers?: unknown[]; decoders?: unknown[] };
  if (value.type === 'ByteLevel') return true;
  return [...(value.pretokenizers ?? []), ...(value.decoders ?? [])].some(hasByteLevel);
}

export class BpeTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly idToToken: Map<number, string>;
  private readonly ranks: Map<string, number>;
  private readonly metaspace: boolean;
  private readonly byteFallback: boolean;
  private readonly byteLevel: boolean;
  private readonly normalize: 'NFC' | 'NFKC' | null;
  /** Matches any added token, so chat markers survive as single ids. */
  private readonly specialPattern: RegExp | null;
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

    this.byteLevel = data.byteLevel ?? false;
    this.metaspace = data.metaspace ?? !this.byteLevel;
    this.byteFallback = data.byteFallback ?? !this.byteLevel;
    this.normalize = data.normalize ?? null;
    this.specialPattern = buildSpecialPattern(data.addedTokens ?? []);

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

    if (this.byteLevel) {
      // Added tokens are emitted whole; only the text between them is merged.
      // This is not done on the metaspace path: SentencePiece prepends its
      // prefix marker once per sequence, so splitting the text first would
      // scatter a `▁` into every gap. TinyLlama's template survives BPE well
      // enough, and changing how the model this repo already targets gets
      // tokenised is not worth the risk here.
      for (const span of this.splitOnSpecials(text)) {
        if (span.special) {
          const id = this.vocab.get(span.text);
          if (id !== undefined) ids.push(id);
          continue;
        }
        ids.push(...this.encodeByteLevel(span.text));
      }
    } else {
      const spaced = METASPACE + text.replace(/ /g, METASPACE);
      // Split on the metaspace boundary so each word is merged independently;
      // BPE never merges across a word start, and this keeps the cache useful.
      for (const piece of splitPieces(spaced, this.metaspace)) {
        ids.push(...this.encodePiece(piece));
      }
    }

    if (options.addEos && this.eosId !== null) ids.push(this.eosId);
    return ids;
  }

  /** Ordinary text, with no special tokens left in it. */
  private encodeByteLevel(text: string): number[] {
    if (!text) return [];
    const normalized = this.normalize ? text.normalize(this.normalize) : text;

    // The regex is the word boundary. Each piece is then re-expressed in the
    // byte alphabet, which is what the merges are written in.
    const ids: number[] = [];
    for (const piece of splitByteLevel(normalized)) {
      ids.push(...this.encodePiece(toByteAlphabet(piece)));
    }
    return ids;
  }

  private splitOnSpecials(text: string): { text: string; special: boolean }[] {
    if (!this.specialPattern) return [{ text, special: false }];

    const spans: { text: string; special: boolean }[] = [];
    let index = 0;
    this.specialPattern.lastIndex = 0;

    for (let match = this.specialPattern.exec(text); match; match = this.specialPattern.exec(text)) {
      if (match.index > index) spans.push({ text: text.slice(index, match.index), special: false });
      spans.push({ text: match[0], special: true });
      index = match.index + match[0].length;
    }
    if (index < text.length) spans.push({ text: text.slice(index), special: false });
    return spans;
  }

  decode(ids: number[], options: DecodeOptions = {}): string {
    if (this.byteLevel) return this.decodeByteLevel(ids, options);

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

  /**
   * Byte-level decoding is the encode path run backwards: concatenate the
   * token strings, map each character back to the byte it stands for, then
   * read the result as UTF-8. Doing it per token instead would cut multi-byte
   * characters in half — a Spanish `ñ` spans two tokens often enough to notice.
   */
  private decodeByteLevel(ids: number[], options: DecodeOptions): string {
    let text = '';
    for (const id of ids) {
      if (options.skipSpecialTokens !== false && this.specialIds.has(id)) continue;
      text += this.idToToken.get(id) ?? '';
    }

    const decoder = byteDecoder();
    const bytes: number[] = [];
    for (const character of text) {
      const byte = decoder.get(character);
      // A character outside the byte alphabet can only come from an added
      // token that was asked to be kept; pass its own bytes through.
      if (byte === undefined) bytes.push(...new TextEncoder().encode(character));
      else bytes.push(byte);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
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

// --- byte-level BPE ---------------------------------------------------------

/**
 * GPT-2's byte alphabet.
 *
 * Every byte gets a printable character, so a vocabulary written in these
 * characters covers all 256 by construction and needs no `<unk>` and no
 * `<0xNN>` fallback. Printable ASCII and Latin-1 stand for themselves; the
 * remaining 68 bytes — control characters, space, and the two unassigned
 * Latin-1 slots — are moved up into U+0100 and above, which is why a space is
 * `Ġ` (U+0120 = 0x100 + 0x20).
 */
function buildByteAlphabet(): string[] {
  const printable: number[] = [];
  const add = (from: number, to: number) => {
    for (let byte = from; byte <= to; byte++) printable.push(byte);
  };
  add(0x21, 0x7e); // ! .. ~
  add(0xa1, 0xac); // ¡ .. ¬
  add(0xae, 0xff); // ® .. ÿ

  const table: string[] = new Array(256);
  let next = 0;
  for (let byte = 0; byte < 256; byte++) {
    if (printable.includes(byte)) table[byte] = String.fromCodePoint(byte);
    else table[byte] = String.fromCodePoint(256 + next++);
  }
  return table;
}

let encoderTable: string[] | null = null;
let decoderTable: Map<string, number> | null = null;

function byteEncoder(): string[] {
  return (encoderTable ??= buildByteAlphabet());
}

function byteDecoder(): Map<string, number> {
  if (!decoderTable) {
    decoderTable = new Map();
    byteEncoder().forEach((character, byte) => decoderTable!.set(character, byte));
  }
  return decoderTable;
}

/** UTF-8 bytes of a string, re-expressed in the byte alphabet. */
function toByteAlphabet(text: string): string {
  const table = byteEncoder();
  let out = '';
  for (const byte of new TextEncoder().encode(text)) out += table[byte];
  return out;
}

/**
 * The pre-tokenizer regex, as shipped in Qwen's and Llama 3's `tokenizer.json`.
 *
 * Written out with the case-insensitive contractions expanded, because the
 * original uses an inline `(?i:…)` group: that is a recent addition to
 * JavaScript and Hermes does not have it, so the app would throw on the phone
 * while every test passed on Node.
 */
const BYTE_LEVEL_SPLIT =
  /'(?:[sS]|[tT]|[mM]|[dD]|[rR][eE]|[vV][eE]|[lL][lL])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

function splitByteLevel(text: string): string[] {
  return text.match(BYTE_LEVEL_SPLIT) ?? [];
}

/**
 * One alternation of every added token, longest first so `<|im_end|>` is not
 * matched as a prefix of something longer.
 */
function buildSpecialPattern(tokens: string[]): RegExp | null {
  const usable = [...new Set(tokens.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (usable.length === 0) return null;
  return new RegExp(usable.map(escapeRegExp).join('|'), 'g');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
