import { soundFiles, stripHtml, stripHtmlKeepLines } from './html.js';

/**
 * Anki note types are user-defined: a field called "Front" in one shared deck
 * is "Expression" in the next and "Vocabulary" in the one after that. Mapping
 * an arbitrary note type onto this app's front/back/examples shape is therefore
 * name-matching first, positional fallback second.
 */

/** Candidate field names, best match first, matched case-insensitively. */
const FRONT_NAMES = [
  'front', 'word', 'expression', 'vocabulary', 'vocab', 'term', 'question',
  'target', 'spanish', 'bosnian', 'palabra', 'rijec', 'riječ', 'kanji', 'prompt',
];

const BACK_NAMES = [
  'back', 'meaning', 'translation', 'definition', 'answer', 'english',
  'traduccion', 'traducción', 'significado', 'prijevod', 'znacenje', 'značenje', 'gloss',
];

/**
 * Sentence decks (one sentence per note, with its translation) name the prompt
 * field "Sentence". That word also names example fields in vocabulary decks,
 * so it only counts as the front on an exact match, and only when no field is
 * recognisably the word itself.
 */
const SENTENCE_FRONT_NAMES = ['sentence', 'phrase', 'frase', 'oracion', 'recenica'];

/**
 * Decks built from parallel corpora (Tatoeba and the like) name both sides
 * after their language: "SpanishSentence" and "EnglishSentence", next to
 * "SpanishSentenceID" and a "ClozeWord". A field naming the learner's language
 * *and* a sentence is the prompt there, ahead of any generic "word" field.
 */
const TARGET_LANGUAGE_NAMES = ['spanish', 'espanol', 'bosnian', 'bosanski', 'target'];
const SENTENCE_WORDS = ['sentence', 'phrase', 'frase', 'oracion', 'recenica', 'text'];

/** Fields that hold a recording rather than text. */
const AUDIO_NAMES = ['audio', 'sound', 'pronunciation', 'pronunciacion', 'izgovor', 'recording'];
/** Recordings of an example, not of the prompt, in a vocabulary deck. */
const EXAMPLE_AUDIO_WORDS = ['sentence', 'example', 'frase', 'ejemplo', 'recenica', 'primjer'];

/** Fields that grade notes easiest first (lower is introduced sooner). */
const ORDER_WORDS = ['difficulty', 'rank'];

const EXAMPLE_NAMES = [
  'example', 'examples', 'sentence', 'sentences', 'example sentence',
  'usage', 'context', 'ejemplo', 'ejemplos', 'frase', 'primjer', 'primjeri', 'recenica', 'rečenica',
];

export interface NoteTypeField {
  ord: number;
  name: string;
}

export interface FieldMapping {
  frontIndex: number;
  backIndex: number;
  exampleIndex: number | null;
  /**
   * The field holding a recording of the front (`[sound:...]`), when one is
   * named for it. A sound tag in the front field itself is used first.
   */
  audioIndex: number | null;
  /**
   * A numeric "Difficulty" or "Rank" field, which graded decks sort by. Their
   * stored new-card order can be stale (re-shared decks keep whatever order
   * the author's collection last had), so this field, when every note fills
   * it, decides which new card comes first.
   */
  orderIndex: number | null;
  /** True when the mapping fell back to field order instead of field names. */
  positional: boolean;
}

/**
 * Pick which note-type fields become front, back and examples.
 *
 * @param fields   note-type fields, in template order
 * @param sortIndex the note type's sort field, used as a front-side tiebreaker
 */
export function mapFields(fields: NoteTypeField[], sortIndex = 0): FieldMapping {
  const ordered = [...fields].sort((a, b) => a.ord - b.ord);
  const names = ordered.map((f) => normalize(f.name));

  // Database IDs ("SpanishSentenceID") name a language too, but hold numbers.
  const ids = names.flatMap((name, index) => (isIdField(name) ? [index] : []));

  const pairedFront = tokenIndex(names, [TARGET_LANGUAGE_NAMES, SENTENCE_WORDS], ids);
  const frontByName = pairedFront
    ?? matchIndex(names, FRONT_NAMES, ids)
    ?? exactIndex(names, SENTENCE_FRONT_NAMES);
  const backByName = (pairedFront === null ? null : tokenIndex(names, [['english'], SENTENCE_WORDS], ids))
    ?? matchIndex(names, BACK_NAMES, [frontByName, ...ids]);
  // A "search field" is a plain-text copy of another field kept for Anki's
  // search, never an example of its own.
  const searchFields = names.flatMap((name, index) => (name.includes('search') ? [index] : []));
  const exampleIndex = matchIndex(names, EXAMPLE_NAMES, [frontByName, backByName, ...searchFields, ...ids]);

  // In a sentence deck the sentence recording is the front's; in a word deck a
  // "Sentence Audio" field reads the example instead.
  const frontIsSentence = frontByName !== null && tokens(names[frontByName]).some((t) => SENTENCE_WORDS.includes(t));
  const audioIndex = names.findIndex((name, index) =>
    !ids.includes(index)
    && AUDIO_NAMES.some((word) => name.includes(word))
    && (frontIsSentence || !EXAMPLE_AUDIO_WORDS.some((word) => name.includes(word))),
  );

  let frontIndex = frontByName;
  let backIndex = backByName;
  let positional = false;

  if (frontIndex === null) {
    // The sort field is what Anki shows in the browser, so it is the best guess
    // for the prompt side when no field is recognisably named.
    frontIndex = sortIndex < ordered.length ? sortIndex : 0;
    positional = true;
  }
  if (backIndex === null || backIndex === frontIndex) {
    backIndex = firstUnused(ordered.length, [frontIndex, exampleIndex]);
    positional = true;
  }

  const orderIndex = names.findIndex((name, index) =>
    !ids.includes(index) && tokens(name).some((t) => ORDER_WORDS.includes(t)),
  );

  return {
    frontIndex,
    backIndex,
    exampleIndex,
    audioIndex: audioIndex === -1 ? null : audioIndex,
    orderIndex: orderIndex === -1 ? null : orderIndex,
    positional,
  };
}

export interface ExtractedNote {
  front: string;
  back: string;
  examples: string[];
  /** Media file name of the front's recording, as the package names it. */
  sound?: string;
}

/** Apply a {@link FieldMapping} to one note's raw field values. */
export function extractNote(values: string[], mapping: FieldMapping): ExtractedNote {
  const front = frontText(values[mapping.frontIndex] ?? '');
  const back = stripHtml(values[mapping.backIndex] ?? '');
  // Some decks keep a plain-text copy of the front for Anki's search, and it
  // can look like an example field; a copy of the prompt is not an example.
  const examples = mapping.exampleIndex === null
    ? []
    : splitExamples(values[mapping.exampleIndex] ?? '')
        .filter((example) => example.toLowerCase() !== front.toLowerCase());
  const sound = soundFiles(values[mapping.frontIndex] ?? '')[0]
    ?? (mapping.audioIndex === null ? undefined : soundFiles(values[mapping.audioIndex] ?? '')[0]);
  return sound ? { front, back, examples, sound } : { front, back, examples };
}

/**
 * A front with one complete sentence per line lists alternative phrasings
 * ("Ovo je samo početak.<br>To je samo početak."); run together they read as
 * one long sentence, so they are kept apart with a slash. Any other line
 * breaks in a front are just layout and collapse to spaces.
 */
function frontText(field: string): string {
  const lines = stripHtmlKeepLines(field).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => /[.!?…]["'”’»)]*$/.test(line))) {
    return lines.join(' / ');
  }
  return stripHtml(field);
}

/** Split an example field into individual sentences. */
export function splitExamples(field: string): string[] {
  const text = stripHtmlKeepLines(field);
  if (!text) return [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : splitSentences(lines[0] ?? '');
  return parts
    .map((s) => s.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter((s) => s.length > 1)
    .slice(0, 3);
}

function splitSentences(text: string): string[] {
  // Keep the terminator with the sentence it ends.
  const matches = text.match(/[^.!?¿¡]+[.!?]+["'”’)]?|[^.!?¿¡]+$/g);
  return (matches ?? [text]).map((s) => s.trim()).filter(Boolean);
}

/** The unit separator (U+001F) Anki uses to pack note fields into one column. */
export const FIELD_SEPARATOR = '\u001f';

export function splitFields(flds: string): string[] {
  return flds.split(FIELD_SEPARATOR);
}

function matchIndex(
  names: string[],
  candidates: string[],
  exclude: (number | null)[] = [],
): number | null {
  const blocked = new Set(exclude.filter((i): i is number => i !== null));
  for (const candidate of candidates) {
    const exact = names.findIndex((n, i) => n === candidate && !blocked.has(i));
    if (exact !== -1) return exact;
  }
  for (const candidate of candidates) {
    const partial = names.findIndex((n, i) => n.includes(candidate) && !blocked.has(i));
    if (partial !== -1) return partial;
  }
  return null;
}

/** The first field whose words include one from every group. */
function tokenIndex(names: string[], groups: string[][], exclude: number[]): number | null {
  const index = names.findIndex((name, i) =>
    !exclude.includes(i) && groups.every((group) => tokens(name).some((t) => group.includes(t))),
  );
  return index === -1 ? null : index;
}

function tokens(name: string | undefined): string[] {
  return (name ?? '').split(' ').filter(Boolean);
}

function isIdField(name: string): boolean {
  return /(^| )ids?$/.test(name);
}

function exactIndex(names: string[], candidates: string[]): number | null {
  for (const candidate of candidates) {
    const index = names.indexOf(candidate);
    if (index !== -1) return index;
  }
  return null;
}

function firstUnused(length: number, used: (number | null)[]): number {
  const blocked = new Set(used.filter((i): i is number => i !== null));
  for (let i = 0; i < length; i++) {
    if (!blocked.has(i)) return i;
  }
  return Math.min(1, Math.max(0, length - 1));
}

function normalize(name: string): string {
  return name
    // "SpanishSentenceID" -> "Spanish Sentence ID", so its words can be told apart.
    .replace(/(\p{Ll}|\d)(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}
