import { unzipSync } from 'fflate';
import type { Card, CardPhase, Deck, TargetLanguage } from '../types.js';
import { detectLanguage, type LanguageDetection } from '../language.js';
import { stableId } from '../id.js';
import { MIN_EASE_FACTOR, DEFAULT_EASE_FACTOR, statusFor } from '../scheduler.js';
import { extractNote, mapFields, splitFields, type FieldMapping, type NoteTypeField } from './fields.js';

/**
 * Anki `.apkg` / `.colpkg` importer.
 *
 * An `.apkg` is a ZIP holding a SQLite collection plus media. Anki has shipped
 * two collection schemas that matter here:
 *
 *  - **schema 11** (`collection.anki2`): note types and decks live as JSON blobs
 *    in the single `col` row.
 *  - **schema 18** (`collection.anki21`): note types and decks moved into real
 *    tables (`notetypes`, `fields`, `decks`); the JSON columns are left empty.
 *
 * Modern Anki exports contain both — an up-to-date `collection.anki21` plus a
 * downgraded `collection.anki2` stub for old clients — so the newest readable
 * file wins. Exports made with "Support older Anki versions" *off* ship
 * `collection.anki21b`, which is zstd-compressed; that is reported as an
 * actionable error rather than guessed at.
 *
 * SQLite itself is not bundled here. The caller injects an opener so the same
 * code runs on `node:sqlite` (server, tests) and `expo-sqlite` (app).
 *
 * One constraint runs through every query below: **never `ORDER BY` a text
 * column.** Anki declares them `collate unicase`, a collation registered at
 * runtime by Anki's own Rust layer. A stock SQLite build can read those columns
 * but cannot order or index by them, and `fields` is `WITHOUT ROWID` — its
 * primary-key index covers `name`, so even `ORDER BY ntid, ord` fails there
 * with "no query solution". Rows are therefore sorted in JavaScript.
 */

export type AnkiValue = string | number | bigint | null | Uint8Array;
export type AnkiRow = Record<string, AnkiValue | undefined>;

export interface AnkiDatabase {
  all(sql: string): AnkiRow[];
  close(): void;
}

/** Opens a SQLite database from raw bytes. Injected per platform. */
export type OpenAnkiDatabase = (bytes: Uint8Array, filename: string) => Promise<AnkiDatabase>;

export type ApkgErrorCode =
  | 'NOT_A_ZIP'
  | 'NO_COLLECTION'
  | 'UNSUPPORTED_ZSTD'
  | 'EMPTY_COLLECTION'
  | 'SQLITE_FAILED';

export class ApkgError extends Error {
  readonly code: ApkgErrorCode;
  constructor(code: ApkgErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApkgError';
    this.code = code;
  }
}

export interface ApkgImportOptions {
  open: OpenAnkiDatabase;
  userId: string;
  /** Original filename, used for language detection and deck naming. */
  filename?: string;
  /** Force a language instead of detecting one. */
  language?: TargetLanguage;
  /** Language used when detection finds nothing. */
  fallbackLanguage?: TargetLanguage;
  /** Import time; injected for deterministic tests. */
  now?: Date;
  /**
   * Merge every Anki subdeck into one deck instead of mirroring the hierarchy.
   * Useful for shared decks that split a single word list across dozens of
   * "Level 1 / Level 2 / ..." subdecks.
   */
  flatten?: boolean;
}

export interface ApkgImportSummary {
  schema: number;
  collectionFile: string;
  notesRead: number;
  cardsImported: number;
  /** Extra templates (reverse cards, cloze siblings) collapsed into one card. */
  siblingCardsMerged: number;
  cardsSkipped: number;
  decksCreated: number;
  mediaCount: number;
  detection: LanguageDetection;
  /** Note types whose fields had to be matched by position, not by name. */
  positionalNoteTypes: string[];
  warnings: string[];
}

export interface ApkgImportResult {
  decks: Deck[];
  cards: Card[];
  summary: ApkgImportSummary;
}

const DAY_SECONDS = 86_400;
/** Schema 18+ stores deck hierarchy with U+001F where schema 11 used `::`. */
const DECK_NAME_SEPARATOR = '\u001f';
const COLLECTION_CANDIDATES = ['collection.anki21', 'collection.anki2'];

export async function parseApkg(
  bytes: Uint8Array,
  options: ApkgImportOptions,
): Promise<ApkgImportResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const warnings: string[] = [];

  const entries = unzip(bytes);
  const { name: collectionFile, data: collectionBytes } = pickCollection(entries);

  const db = await open(options.open, collectionBytes, collectionFile);
  try {
    const col = first(db.all('SELECT crt, ver, models, decks FROM col LIMIT 1'));
    if (!col) throw new ApkgError('EMPTY_COLLECTION', 'The collection has no header row.');

    const crt = num(col.crt);
    const schema = tableExists(db, 'notetypes') ? 18 : num(col.ver) || 11;

    const deckNames = schema >= 18 ? readDeckTable(db) : readDeckJson(col.decks);
    const noteTypes = schema >= 18 ? readNoteTypeTables(db, warnings) : readNoteTypeJson(col.models);

    const notes = db.all('SELECT id, mid, flds, tags FROM notes');
    if (notes.length === 0) {
      warnings.push('The collection contains no notes.');
    }

    // One card row per Anki card; several can share a note (reverse templates,
    // cloze siblings). Keep the lowest-ordinal card so scheduling comes from
    // the primary template, and count the rest as merged.
    const cardRows = db.all(
      // `left` is a SQL keyword, so it has to be quoted to name Anki's column.
      'SELECT id, nid, did, odid, ord, type, queue, due, ivl, factor, reps, lapses, "left" FROM cards',
    );

    // Card rows arrive unordered (see the collation note above), so the lowest
    // ordinal is found by comparison rather than by relying on the query.
    const primaryByNote = new Map<string, AnkiRow>();
    let siblingCardsMerged = 0;
    for (const row of cardRows) {
      const nid = String(num(row.nid));
      const existing = primaryByNote.get(nid);
      if (!existing || num(row.ord) < num(existing.ord)) {
        if (existing) siblingCardsMerged++;
        primaryByNote.set(nid, row);
      } else {
        siblingCardsMerged++;
      }
    }

    fillMissingFields(noteTypes, notes);

    const mappings = new Map<string, FieldMapping>();
    const positionalNoteTypes: string[] = [];
    for (const [mid, noteType] of noteTypes) {
      const mapping = mapFields(noteType.fields, noteType.sortIndex);
      mappings.set(mid, mapping);
      if (mapping.positional) positionalNoteTypes.push(noteType.name);
    }

    // Detect language once over the whole collection, then refine per deck.
    const sampleText = buildSample(notes, noteTypes, mappings);
    const collectionName = options.filename
      ? options.filename.replace(/\.(apkg|colpkg|zip)$/i, '')
      : ([...deckNames.values()][0] ?? 'Imported deck');
    const detection = options.language
      ? { language: options.language, confidence: 'high' as const, reason: 'chosen by user' }
      : detectLanguage(
          `${collectionName} ${[...deckNames.values()].join(' ')}`,
          sampleText,
          options.fallbackLanguage ?? 'es',
        );

    const decks = new Map<string, Deck>();
    const cards: Card[] = [];
    let cardsSkipped = 0;

    for (const note of notes) {
      const noteId = num(note.id);
      const cardRow = primaryByNote.get(String(noteId));
      if (!cardRow) {
        cardsSkipped++;
        continue;
      }

      const mid = String(num(note.mid));
      const noteType = noteTypes.get(mid);
      const mapping = mappings.get(mid);
      if (!noteType || !mapping) {
        cardsSkipped++;
        continue;
      }

      const extracted = extractNote(splitFields(str(note.flds)), mapping);
      if (!extracted.front || !extracted.back) {
        cardsSkipped++;
        continue;
      }

      // Filtered decks put the card's home deck in `odid`.
      const homeDeckId = num(cardRow.odid) || num(cardRow.did);
      const rawDeckName = deckNames.get(String(homeDeckId)) ?? collectionName;
      const deckName = options.flatten ? collectionName : rawDeckName;

      const deck = ensureDeck(decks, {
        userId: options.userId,
        name: deckName,
        collectionName,
        detection,
        fallback: options.fallbackLanguage ?? 'es',
        forced: options.language,
        nowIso,
      });

      cards.push(
        toCard({
          cardRow,
          extracted,
          deck,
          userId: options.userId,
          crt,
          now,
          nowIso,
          noteId,
        }),
      );
      deck.cardCount++;
    }

    if (positionalNoteTypes.length > 0) {
      warnings.push(
        `Field names were not recognised for ${unique(positionalNoteTypes).join(', ')}; ` +
          'the first two fields were used as front and back.',
      );
    }
    if (cardsSkipped > 0) {
      warnings.push(`${cardsSkipped} note(s) were skipped for having an empty front or back.`);
    }

    return {
      decks: [...decks.values()],
      cards,
      summary: {
        schema,
        collectionFile,
        notesRead: notes.length,
        cardsImported: cards.length,
        siblingCardsMerged,
        cardsSkipped,
        decksCreated: decks.size,
        mediaCount: countMedia(entries),
        detection,
        positionalNoteTypes: unique(positionalNoteTypes),
        warnings,
      },
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// ZIP handling

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch (cause) {
    throw new ApkgError(
      'NOT_A_ZIP',
      'That file is not a readable .apkg archive. Export it again from Anki (File > Export > Anki Deck Package).',
      { cause },
    );
  }
}

function pickCollection(entries: Record<string, Uint8Array>): { name: string; data: Uint8Array } {
  for (const name of COLLECTION_CANDIDATES) {
    const data = entries[name];
    // A downgrade stub is a few KB of empty schema; the real collection is larger.
    if (data && data.byteLength > 0) return { name, data };
  }
  if (entries['collection.anki21b']) {
    throw new ApkgError(
      'UNSUPPORTED_ZSTD',
      'This export uses Anki\'s newer compressed format. Re-export with "Support older Anki versions" enabled.',
    );
  }
  throw new ApkgError(
    'NO_COLLECTION',
    'No Anki collection was found inside the archive.',
  );
}

function countMedia(entries: Record<string, Uint8Array>): number {
  return Object.keys(entries).filter((name) => /^\d+$/.test(name)).length;
}

async function open(
  opener: OpenAnkiDatabase,
  bytes: Uint8Array,
  filename: string,
): Promise<AnkiDatabase> {
  try {
    return await opener(bytes, filename);
  } catch (cause) {
    throw new ApkgError('SQLITE_FAILED', `Could not open ${filename} as a SQLite database.`, { cause });
  }
}

// ---------------------------------------------------------------------------
// Schema readers

interface NoteType {
  name: string;
  fields: NoteTypeField[];
  sortIndex: number;
}

function tableExists(db: AnkiDatabase, table: string): boolean {
  const rows = db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
  return rows.length > 0;
}

/** Schema 18+: decks are rows, and `\x1f` separates hierarchy levels. */
function readDeckTable(db: AnkiDatabase): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of db.all('SELECT id, name FROM decks')) {
    names.set(String(num(row.id)), str(row.name).split(DECK_NAME_SEPARATOR).join('::'));
  }
  return names;
}

/** Schema 11: decks are a JSON object keyed by deck id. */
function readDeckJson(value: AnkiValue | undefined): Map<string, string> {
  const names = new Map<string, string>();
  const parsed = parseJson<Record<string, { name?: string }>>(value);
  for (const [id, deck] of Object.entries(parsed ?? {})) {
    if (deck?.name) names.set(id, deck.name);
  }
  return names;
}

/**
 * Schema 18+: field names live in the `fields` table; the sort field is buried
 * in a protobuf blob, so it is left at 0 and the name matcher does the work.
 *
 * `fields` is `WITHOUT ROWID` and collated, so it is unreadable unless the
 * opener applied `stripUnknownCollations` (see ./collation.ts). An opener that did not is not
 * a reason to fail the whole import — the note types are kept without field
 * names and positional mapping takes over.
 */
function readNoteTypeTables(db: AnkiDatabase, warnings: string[]): Map<string, NoteType> {
  const noteTypes = new Map<string, NoteType>();
  for (const row of db.all('SELECT id, name FROM notetypes')) {
    noteTypes.set(String(num(row.id)), { name: str(row.name), fields: [], sortIndex: 0 });
  }
  try {
    for (const row of db.all('SELECT ntid, ord, name FROM fields')) {
      noteTypes.get(String(num(row.ntid)))?.fields.push({ ord: num(row.ord), name: str(row.name) });
    }
  } catch {
    warnings.push(
      'Field names could not be read from this collection; fields were mapped by position.',
    );
  }
  return noteTypes;
}

/**
 * Give a note type placeholder fields when its real ones could not be read, so
 * the positional mapping has something to size itself against.
 */
function fillMissingFields(noteTypes: Map<string, NoteType>, notes: AnkiRow[]): void {
  const widths = new Map<string, number>();
  for (const note of notes) {
    const mid = String(num(note.mid));
    const width = splitFields(str(note.flds)).length;
    widths.set(mid, Math.max(widths.get(mid) ?? 0, width));
  }
  for (const [mid, noteType] of noteTypes) {
    if (noteType.fields.length > 0) continue;
    const width = widths.get(mid) ?? 2;
    noteType.fields = Array.from({ length: width }, (_, ord) => ({
      ord,
      name: `Field ${ord + 1}`,
    }));
  }
}

/** Schema 11: note types are a JSON object keyed by model id. */
function readNoteTypeJson(value: AnkiValue | undefined): Map<string, NoteType> {
  const noteTypes = new Map<string, NoteType>();
  const parsed = parseJson<Record<string, { name?: string; sortf?: number; flds?: { name?: string; ord?: number }[] }>>(value);
  for (const [id, model] of Object.entries(parsed ?? {})) {
    noteTypes.set(id, {
      name: model?.name ?? 'Note type',
      sortIndex: model?.sortf ?? 0,
      fields: (model?.flds ?? []).map((f, index) => ({ ord: f.ord ?? index, name: f.name ?? `Field ${index + 1}` })),
    });
  }
  return noteTypes;
}

// ---------------------------------------------------------------------------
// Mapping onto app entities

function ensureDeck(
  decks: Map<string, Deck>,
  args: {
    userId: string;
    name: string;
    collectionName: string;
    detection: LanguageDetection;
    fallback: TargetLanguage;
    forced: TargetLanguage | undefined;
    nowIso: string;
  },
): Deck {
  const existing = decks.get(args.name);
  if (existing) return existing;

  // A subdeck named "Bosnian Verbs" inside a Spanish collection should still
  // import as Bosnian, so per-deck detection can override the collection guess.
  let language = args.forced ?? args.detection.language;
  if (!args.forced) {
    const perDeck = detectLanguage(args.name, '', args.detection.language);
    if (perDeck.confidence === 'high') language = perDeck.language;
  }

  const deck: Deck = {
    id: stableId('deck', args.userId, args.name),
    userId: args.userId,
    name: args.name,
    language,
    newCardsPerDay: 20,
    cardCount: 0,
    createdAt: args.nowIso,
    lastModified: args.nowIso,
    syncStatus: 'pending',
  };
  decks.set(args.name, deck);
  return deck;
}

function toCard(args: {
  cardRow: AnkiRow;
  extracted: { front: string; back: string; examples: string[] };
  deck: Deck;
  userId: string;
  crt: number;
  now: Date;
  nowIso: string;
  noteId: number;
}): Card {
  const { cardRow, extracted, deck, userId, crt, now, nowIso, noteId } = args;

  const type = num(cardRow.type);
  const rawInterval = num(cardRow.ivl);
  // Anki stores sub-day intervals as negative seconds.
  const interval = rawInterval < 0 ? 0 : Math.round(rawInterval);
  const factor = num(cardRow.factor);
  const easeFactor = factor > 0 ? Math.max(MIN_EASE_FACTOR, factor / 1000) : DEFAULT_EASE_FACTOR;
  const reps = num(cardRow.reps);
  const lapses = num(cardRow.lapses);
  const phase = phaseFor(type);

  return {
    id: stableId('card', userId, deck.name, noteId),
    deckId: deck.id,
    userId,
    front: extracted.front,
    back: extracted.back,
    language: deck.language,
    examples: extracted.examples,
    interval,
    easeFactor: Math.round(easeFactor * 100) / 100,
    repetitions: reps,
    phase,
    lapses,
    learningStep: learningStepFor(type, num(cardRow.left)),
    nextReview: nextReviewFor(type, num(cardRow.due), crt, now),
    status: statusFor(phase, interval),
    lastModified: nowIso,
    syncStatus: 'pending',
  };
}

/**
 * Anki's `cards.type` column is the scheduling phase, and this app now models
 * the same four, so the import is a direct mapping rather than a
 * reconstruction: an imported card resumes exactly where Anki left it.
 */
function phaseFor(type: number): CardPhase {
  if (type === 1) return 'learning';
  if (type === 2) return 'review';
  if (type === 3) return 'relearning';
  return 'new';
}

/**
 * `cards.left` packs the steps *remaining* as `remaining + todayRemaining*1000`.
 * The scheduler wants the step the card sits on instead, and the two step lists
 * can differ in length between collections, so this only recovers the common
 * case: a card with one step left is on the last one, anything else restarts.
 * Getting this wrong costs a repeated learning step, not a lost card.
 */
function learningStepFor(type: number, left: number): number {
  if (type !== 1 && type !== 3) return 0;
  const remaining = left % 1000;
  return remaining === 1 ? 1 : 0;
}

function nextReviewFor(type: number, due: number, crt: number, now: Date): string {
  if (type === 0) return now.toISOString(); // new cards are due immediately
  if (type === 2) {
    // Review cards store `due` as days since collection creation.
    return new Date((crt + due * DAY_SECONDS) * 1000).toISOString();
  }
  // Learning and relearning cards store `due` as an epoch timestamp in seconds.
  // Very small values mean the card was queued by position, not by time.
  const timestamp = due > 1_000_000_000 ? due * 1000 : now.getTime();
  return new Date(timestamp).toISOString();
}

function buildSample(
  notes: AnkiRow[],
  noteTypes: Map<string, NoteType>,
  mappings: Map<string, FieldMapping>,
): string {
  const parts: string[] = [];
  for (const note of notes.slice(0, 60)) {
    const mapping = mappings.get(String(num(note.mid)));
    if (!mapping) continue;
    const values = splitFields(str(note.flds));
    const extracted = extractNote(values, mapping);
    parts.push(extracted.front, ...extracted.examples);
  }
  void noteTypes;
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Value coercion. SQLite drivers hand back numbers, bigints or blobs depending
// on the platform, so every read goes through these.

function num(value: AnkiValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function str(value: AnkiValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

function parseJson<T>(value: AnkiValue | undefined): T | null {
  const text = str(value);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function first(rows: AnkiRow[]): AnkiRow | undefined {
  return rows[0];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
