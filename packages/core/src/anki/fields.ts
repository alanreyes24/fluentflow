import { stripHtml, stripHtmlKeepLines } from './html.js';

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

  const frontByName = matchIndex(names, FRONT_NAMES);
  const backByName = matchIndex(names, BACK_NAMES);
  const exampleIndex = matchIndex(names, EXAMPLE_NAMES, [frontByName, backByName]);

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

  return { frontIndex, backIndex, exampleIndex, positional };
}

export interface ExtractedNote {
  front: string;
  back: string;
  examples: string[];
}

/** Apply a {@link FieldMapping} to one note's raw field values. */
export function extractNote(values: string[], mapping: FieldMapping): ExtractedNote {
  const front = stripHtml(values[mapping.frontIndex] ?? '');
  const back = stripHtml(values[mapping.backIndex] ?? '');
  const examples = mapping.exampleIndex === null
    ? []
    : splitExamples(values[mapping.exampleIndex] ?? '');
  return { front, back, examples };
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

function firstUnused(length: number, used: (number | null)[]): number {
  const blocked = new Set(used.filter((i): i is number => i !== null));
  for (let i = 0; i < length; i++) {
    if (!blocked.has(i)) return i;
  }
  return Math.min(1, Math.max(0, length - 1));
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}
