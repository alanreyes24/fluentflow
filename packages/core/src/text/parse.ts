import type { Card, Deck, TargetLanguage } from '../types.js';
import { detectLanguage, type LanguageDetection } from '../language.js';
import { createCard, createDeck } from '../factory.js';
import { stableId } from '../id.js';
import { stripHtml } from '../anki/html.js';

/**
 * Plain-text import: turn a pasted word list into cards.
 *
 * The `.apkg` importer covers people who already keep decks in Anki. This
 * covers everyone else — a vocabulary list from a textbook, a spreadsheet
 * column, a note on a phone — where the only thing standing between the text
 * and a deck is knowing which half of each line is the word.
 *
 * Nothing here asks the user to declare a format. Real pasted lists arrive as
 * tabs from a spreadsheet, commas from a CSV export, `word - meaning` from a
 * notes app, pipes from a Markdown table, or two lines per card separated by
 * blank lines. The separator is therefore *scored* against the whole paste
 * rather than sniffed from the first line, because the first line of a list is
 * as likely to be a header as a card.
 *
 * Two rules keep the result honest, and both come from the same conviction as
 * the AI parser: a wrong card is worse than a missing one.
 *
 *  - A line that does not fit the detected format is **skipped and reported**
 *    with its line number, never guessed at.
 *  - Tabular separators (tab, comma, pipe) treat extra columns as columns —
 *    Anki's CSV export puts tags there — and drop them with a warning. Prose
 *    separators (`-`, `:`, `=`, `;`) split once, so a meaning is allowed to
 *    contain the character that separated it.
 */

/**
 * How the paste was read.
 *
 * `words` is a list with no meanings on it at all — just the words. Those
 * entries come back with an empty `back`, which is not a card yet: something
 * has to supply the meanings before they can be imported.
 */
export type TextFormat = 'delimited' | 'blocks' | 'words' | 'empty';

export type TextSeparatorId = 'tab' | 'pipe' | 'semicolon' | 'dash' | 'equals' | 'colon' | 'comma';

export type TextSkipReason =
  /** No separator on the line, or a block with only one line. */
  | 'no-separator'
  /** One of the two sides was empty. */
  | 'missing-side'
  /** The same word is already in the paste, or already in the deck. */
  | 'duplicate'
  /** Prose, not a card: a front or back far longer than a card can show. */
  | 'too-long'
  /** The paste exceeded `maxCards`. */
  | 'over-limit';

export interface TextCardEntry {
  front: string;
  back: string;
  /** 1-based line in the pasted text, so the UI can point at a bad row. */
  line: number;
}

export interface TextSkippedLine {
  line: number;
  /** The offending text, truncated — this is shown back to the user. */
  text: string;
  reason: TextSkipReason;
}

export interface TextParseOptions {
  /** Force a separator instead of detecting one. */
  separator?: TextSeparatorId;
  /** The meaning comes first in the pasted text. */
  swap?: boolean;
  /** Refuse to build more than this many cards from one paste. */
  maxCards?: number;
  /**
   * Words already in the target deck. They are reported as duplicates rather
   * than added again, which is what makes pasting a longer version of the same
   * list safe.
   */
  existingFronts?: Iterable<string>;
}

export interface TextParseResult {
  entries: TextCardEntry[];
  format: TextFormat;
  separator: TextSeparatorId | null;
  /** The separator as a user would describe it, e.g. `Tab` or `word - meaning`. */
  separatorLabel: string | null;
  /** Lines that held content, ignoring blanks and comments. */
  linesRead: number;
  skippedCount: number;
  duplicates: number;
  /** Entries with a front and no back yet — a word list waiting on meanings. */
  needsMeaning: number;
  /** A `front,back` heading was recognised and dropped. */
  headerSkipped: boolean;
  /** A sample of what was skipped, for the UI. Capped; see `skippedCount`. */
  skipped: TextSkippedLine[];
  warnings: string[];
}

/** A front longer than this is a paragraph, not a word to be prompted with. */
const MAX_FRONT = 120;
/**
 * Lines a blank-line-separated block may have before it stops being one card.
 *
 * A word list with a stray blank line in it would otherwise turn everything
 * after that line into one card's back — a plausible-looking, entirely wrong
 * card, which is worse than an error. Above this many lines the group is read
 * as words instead.
 */
const MAX_BLOCK_LINES = 4;
const MAX_BACK = 500;
const DEFAULT_MAX_CARDS = 1000;
/** How many skipped lines to hand back. The count is reported in full. */
const SKIPPED_SAMPLE = 25;

interface Separator {
  id: TextSeparatorId;
  label: string;
  /**
   * Tabular separators carry columns: extra ones are metadata and are dropped.
   * Prose separators split once, so the meaning keeps its own punctuation.
   */
  tabular: boolean;
  split(line: string): string[];
}

/**
 * In priority order — ties during detection go to the earlier entry, which is
 * why `casa - house, home` is read as a dash list and not a comma list.
 */
const SEPARATORS: Separator[] = [
  { id: 'tab', label: 'Tab', tabular: true, split: (line) => line.split('\t') },
  { id: 'pipe', label: 'word | meaning', tabular: true, split: (line) => trimEdges(line.split('|')) },
  { id: 'dash', label: 'word - meaning', tabular: false, split: (line) => splitOnce(line, /\s+[-–—]\s+/) },
  { id: 'semicolon', label: 'word ; meaning', tabular: false, split: (line) => splitOnce(line, /\s*;\s*/) },
  { id: 'equals', label: 'word = meaning', tabular: false, split: (line) => splitOnce(line, /\s*=\s*/) },
  // A colon inside a URL is not a separator, and `12:30` is not either.
  { id: 'colon', label: 'word: meaning', tabular: false, split: (line) => splitOnce(line, /\s*:(?!\/\/|\d)\s*/) },
  { id: 'comma', label: 'word, meaning', tabular: true, split: splitCsv },
];

const COMMENT = /^(?:#|\/\/)/;

/** Column headings seen in exported word lists, in the three UI languages. */
const FRONT_HEADERS = new Set([
  'front', 'word', 'words', 'term', 'question', 'phrase', 'vocabulary', 'vocab', 'expression',
  'palabra', 'termino', 'frente', 'pregunta',
  'rijec', 'pojam', 'pitanje',
  // A bilingual list is as likely to name the language as the side.
  'spanish', 'espanol', 'castellano', 'bosnian', 'bosanski', 'foreign', 'target',
]);
const BACK_HEADERS = new Set([
  'back', 'meaning', 'definition', 'translation', 'answer', 'gloss', 'reverse',
  'significado', 'definicion', 'traduccion', 'reverso', 'respuesta',
  'znacenje', 'prijevod', 'prevod', 'odgovor',
  'english', 'ingles', 'engleski', 'native',
]);

/**
 * Read pasted text into front/back pairs.
 *
 * Pure: no ids, no deck, no clock. {@link buildTextImport} adds those.
 */
export function parseTextCards(text: string, options: TextParseOptions = {}): TextParseResult {
  const warnings: string[] = [];
  const skipped: TextSkippedLine[] = [];
  let skippedCount = 0;
  let duplicates = 0;

  const skip = (line: number, text_: string, reason: TextSkipReason): void => {
    skippedCount++;
    if (reason === 'duplicate') duplicates++;
    if (skipped.length < SKIPPED_SAMPLE) skipped.push({ line, text: truncate(text_, 60), reason });
  };

  // Blank lines are kept: they are the separator in the block format.
  const lines = (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((value, index) => ({ number: index + 1, text: value.trim() }))
    .filter((line) => !COMMENT.test(line.text));

  const content = lines.filter((line) => line.text.length > 0);

  if (content.length === 0) {
    return {
      entries: [], format: 'empty', separator: null, separatorLabel: null,
      linesRead: 0, skippedCount: 0, duplicates: 0, needsMeaning: 0,
      headerSkipped: false, skipped: [], warnings,
    };
  }

  const separator = chooseSeparator(content.map((line) => line.text), options.separator);
  const blocks = separator ? null : readBlocks(lines);
  const wordsOnly = !separator && blocks === null;
  const rows = separator
    ? readDelimited(content, separator, skip, warnings)
    : (blocks ?? readWords(content));

  let swap = options.swap ?? false;
  let headerSkipped = false;
  const first = rows[0];
  if (separator && first && rows.length > 1) {
    const heading = classifyHeader(first.front, first.back);
    if (heading !== 'none') {
      rows.shift();
      headerSkipped = true;
      if (heading === 'reversed') {
        swap = !swap;
        warnings.push('The columns were labelled meaning first, so they were swapped.');
      }
    }
  }

  // --- accept or reject each row ------------------------------------------
  const maxCards = options.maxCards ?? DEFAULT_MAX_CARDS;
  const seen = new Set<string>();
  for (const existing of options.existingFronts ?? []) seen.add(dedupeKey(existing));

  const entries: TextCardEntry[] = [];
  for (const row of rows) {
    const front = clean(swap ? row.back : row.front);
    const back = clean(swap ? row.front : row.back);

    // A word list is allowed through with no back: the caller is expected to
    // supply meanings before importing, and the UI says so.
    if (!front || (!back && !wordsOnly)) {
      skip(row.line, row.front || row.back, 'missing-side');
      continue;
    }
    if (front.length > MAX_FRONT || back.length > MAX_BACK) {
      skip(row.line, front, 'too-long');
      continue;
    }
    const key = dedupeKey(front);
    if (seen.has(key)) {
      skip(row.line, front, 'duplicate');
      continue;
    }
    if (entries.length >= maxCards) {
      skip(row.line, front, 'over-limit');
      continue;
    }
    seen.add(key);
    entries.push({ front, back, line: row.line });
  }

  if (skippedCount > SKIPPED_SAMPLE) {
    warnings.push(`${skippedCount} lines were skipped; the first ${SKIPPED_SAMPLE} are listed.`);
  }
  if (entries.length >= maxCards) {
    warnings.push(`Stopped at ${maxCards} cards. Paste the rest separately.`);
  }

  if (wordsOnly && entries.length > 0) {
    warnings.push('No meanings found — every line was read as a word on its own.');
  }

  return {
    entries,
    format: wordsOnly ? 'words' : separator ? 'delimited' : 'blocks',
    separator: separator?.id ?? null,
    separatorLabel: separator
      ? separator.label
      : entries.length === 0
        ? null
        : wordsOnly
          ? 'One word per line'
          : 'One card per paragraph',
    linesRead: content.length,
    skippedCount,
    duplicates,
    needsMeaning: entries.filter((entry) => !entry.back).length,
    headerSkipped,
    skipped,
    warnings,
  };
}

// --- reading ----------------------------------------------------------------

interface RawRow {
  front: string;
  back: string;
  line: number;
}

type SkipFn = (line: number, text: string, reason: TextSkipReason) => void;

function readDelimited(
  content: { number: number; text: string }[],
  separator: Separator,
  skip: SkipFn,
  warnings: string[],
): RawRow[] {
  const rows: RawRow[] = [];
  let extraColumns = 0;

  for (const line of content) {
    const fields = separator.split(line.text).map((field) => field.trim());
    if (fields.length < 2) {
      skip(line.number, line.text, 'no-separator');
      continue;
    }
    if (fields.length > 2) extraColumns++;

    rows.push({ front: fields[0] ?? '', back: fields[1] ?? '', line: line.number });
  }

  if (extraColumns > 0 && separator.tabular) {
    warnings.push(
      `${extraColumns} line(s) had more than two columns; only the first two were used.`,
    );
  }

  return rows;
}

/**
 * Blocks: a card per paragraph, the word on the first line and the meaning on
 * the rest. This is what a list typed into a notes app looks like when nobody
 * thought about separators.
 */
function readBlocks(lines: { number: number; text: string }[]): RawRow[] | null {
  const rows: RawRow[] = [];
  let group: { number: number; text: string }[] = [];
  let groups = 0;
  let usable = false;

  const flush = (): void => {
    if (group.length === 0) return;
    groups++;
    const [head, ...rest] = group;
    // A group longer than a card is the signal that this is not the block
    // format at all — most often a bare word list with no blank lines in it.
    if (head && rest.length > 0 && group.length <= MAX_BLOCK_LINES) {
      rows.push({ front: head.text, back: rest.map((line) => line.text).join(' '), line: head.number });
      usable = true;
    } else {
      for (const line of group) rows.push({ front: line.text, back: '', line: line.number });
    }
    group = [];
  };

  for (const line of lines) {
    if (line.text.length === 0) flush();
    else group.push(line);
  }
  flush();

  // A blank line between two cards is what the block format *is*. With only
  // one group there is no such line, and the paste is a run of lines that
  // happen to follow each other — a word list, not a card with a long back.
  return usable && groups > 1 ? rows : null;
}

/** Every line is a word on its own, with nothing to put on the back yet. */
function readWords(content: { number: number; text: string }[]): RawRow[] {
  return content.map((line) => ({ front: line.text, back: '', line: line.number }));
}

// --- separators -------------------------------------------------------------

function chooseSeparator(lines: string[], forced?: TextSeparatorId): Separator | null {
  if (forced) return SEPARATORS.find((candidate) => candidate.id === forced) ?? null;

  let best: { separator: Separator; usable: number; score: number } | null = null;

  for (const separator of SEPARATORS) {
    let usable = 0;
    let score = 0;
    for (const line of lines) {
      const fields = separator.split(line).map((field) => field.trim());
      if (fields.length < 2 || !fields[0] || !fields[1]) continue;
      usable++;
      // A separator that leaves exactly two sides fits better than one that
      // happens to appear three times in a sentence.
      score += fields.length === 2 ? 2 : 1;
    }
    if (score > (best?.score ?? 0)) best = { separator, usable, score };
  }

  // A separator has to explain most of the paste. Below that it is punctuation
  // that happened to appear, and the block format is the better reading.
  if (!best || best.usable < Math.max(1, Math.ceil(lines.length * 0.6))) return null;
  return best.separator;
}

/** Split on the first match only, so the meaning keeps its own punctuation. */
function splitOnce(line: string, pattern: RegExp): string[] {
  const match = pattern.exec(line);
  if (!match || match.index === 0) return [line];
  return [line.slice(0, match.index), line.slice(match.index + match[0].length)];
}

/** Drop the empty fields a Markdown table row has at both ends. */
function trimEdges(fields: string[]): string[] {
  const copy = [...fields];
  while (copy.length > 0 && (copy[0] ?? '').trim() === '') copy.shift();
  while (copy.length > 0 && (copy[copy.length - 1] ?? '').trim() === '') copy.pop();
  return copy;
}

/**
 * RFC-4180-ish comma splitting: quotes protect commas, `""` is a literal quote.
 * Anything a spreadsheet exports goes through here.
 */
function splitCsv(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"' && current.trim() === '') {
      quoted = true;
      current = '';
    } else if (character === ',') {
      fields.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  fields.push(current);

  return fields;
}

// --- fields -----------------------------------------------------------------

/**
 * Text copied from a web page arrives with markup. Stripping is conditional
 * because `a < b` is a legitimate card and not a broken tag.
 */
function clean(value: string): string {
  const markup = /<[a-z/!][^>]*>/i.test(value) || /&(?:[a-z]+|#\d+);/i.test(value);
  const text = markup ? stripHtml(value) : value;
  return text
    // Numbering from an ordered list: "1. hablar", "3) casa".
    .replace(/^\s*\d+\s*[.)]\s+/, '')
    // Bullets from a pasted list.
    .replace(/^\s*[-*•·]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyHeader(front: string, back: string): 'none' | 'ordered' | 'reversed' {
  const a = headerKey(front);
  const b = headerKey(back);
  if (FRONT_HEADERS.has(a) && BACK_HEADERS.has(b)) return 'ordered';
  if (BACK_HEADERS.has(a) && FRONT_HEADERS.has(b)) return 'reversed';
  return 'none';
}

function headerKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Case and accents do not make two entries of the same word different cards. */
function dedupeKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// --- building a deck --------------------------------------------------------

export interface TextImportOptions extends TextParseOptions {
  userId: string;
  /** Name for the deck this paste creates. Ignored when `deck` is given. */
  deckName?: string;
  /** Add to a deck that already exists instead of creating one. */
  deck?: Pick<Deck, 'id' | 'language'>;
  /** Force a language instead of detecting one. */
  language?: TargetLanguage;
  /** Language used when detection finds nothing. */
  fallbackLanguage?: TargetLanguage;
  /** Import time; injected for deterministic tests. */
  now?: Date;
  /**
   * Meanings for words the paste did not carry, keyed by the word.
   *
   * This is the seam for translation: core does not translate anything, and
   * has no opinion on where these came from — a model, a dictionary, or the
   * user typing them. An entry with no meaning here and none in the paste is
   * not written, because a card with a blank back is not a card.
   */
  meanings?: Record<string, string>;
}

export interface TextImportSummary {
  format: TextFormat;
  separator: TextSeparatorId | null;
  separatorLabel: string | null;
  linesRead: number;
  cardsImported: number;
  cardsSkipped: number;
  duplicates: number;
  /** Words dropped because nothing supplied a meaning for them. */
  withoutMeaning: number;
  headerSkipped: boolean;
  detection: LanguageDetection;
  skipped: TextSkippedLine[];
  warnings: string[];
}

export interface TextImportResult {
  /** The deck that was created, or empty when adding to an existing one. */
  decks: Deck[];
  cards: Card[];
  summary: TextImportSummary;
}

const DEFAULT_DECK_NAME = 'Pasted cards';

/**
 * Parse pasted text and build the deck and cards it describes.
 *
 * The shape matches `parseApkg`'s result so both importers hand the same thing
 * to `repository.importDecks`.
 *
 * Card ids are derived from the deck and the word, so pasting a longer version
 * of the same list later maps onto the same cards instead of duplicating them.
 */
export function buildTextImport(text: string, options: TextImportOptions): TextImportResult {
  const now = options.now ?? new Date();
  const parsed = parseTextCards(text, options);

  const deckName = options.deck ? '' : (options.deckName ?? '').trim() || DEFAULT_DECK_NAME;

  // Fronts are the target language; backs are usually the learner's own, so
  // they would only add noise to the guess.
  const sample = parsed.entries.map((entry) => entry.front).join(' ');
  const detection: LanguageDetection = options.deck
    ? { language: options.deck.language, confidence: 'high', reason: 'the deck already has a language' }
    : options.language
      ? { language: options.language, confidence: 'high', reason: 'chosen by user' }
      : detectLanguage(deckName, sample, options.fallbackLanguage ?? 'es');

  const deck = options.deck
    ? null
    : createDeck({
        userId: options.userId,
        name: deckName,
        language: detection.language,
        id: stableId('deck', options.userId, deckName),
        now,
      });

  const deckId = options.deck?.id ?? deck?.id ?? '';
  const meanings = options.meanings ?? {};

  let withoutMeaning = 0;
  const cards: Card[] = [];
  for (const entry of parsed.entries) {
    const back = entry.back || meanings[entry.front] || '';
    if (!back) {
      withoutMeaning++;
      continue;
    }
    cards.push(
      createCard({
        id: stableId('card', options.userId, deckId, dedupeKey(entry.front)),
        userId: options.userId,
        deckId,
        front: entry.front,
        back,
        language: detection.language,
        now,
      }),
    );
  }

  return {
    decks: deck ? [{ ...deck, cardCount: cards.length }] : [],
    cards,
    summary: {
      format: parsed.format,
      separator: parsed.separator,
      separatorLabel: parsed.separatorLabel,
      linesRead: parsed.linesRead,
      cardsImported: cards.length,
      cardsSkipped: parsed.skippedCount + withoutMeaning,
      duplicates: parsed.duplicates,
      withoutMeaning,
      headerSkipped: parsed.headerSkipped,
      detection,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
    },
  };
}
