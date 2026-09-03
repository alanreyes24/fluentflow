/**
 * Anki note fields are HTML fragments authored in a rich-text editor. They
 * routinely contain `<div>` wrappers, `<br>`, cloze markup, media references
 * and `&nbsp;`. Cards in this app render as plain text, so fields get flattened
 * on import.
 */

const SOUND_TAG = /\[sound:[^\]]*\]/gi;
const ANKI_TTS = /\[anki:tts[^\]]*\]/gi;
const CLOZE = /\{\{c\d+::(.*?)(?:::.*?)?\}\}/gs;
const TYPE_ANSWER = /\{\{type:[^}]*\}\}/gi;
const BLOCK_TAG = /<\s*\/?\s*(?:br|div|p|li|tr|h[1-6])\b[^>]*>/gi;
const ANY_TAG = /<[^>]*>/g;
const SCRIPT_OR_STYLE = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

/** Collapse an Anki HTML field down to a single line of readable text. */
export function stripHtml(field: string): string {
  if (!field) return '';
  return decodeEntities(
    field
      .replace(SCRIPT_OR_STYLE, ' ')
      .replace(SOUND_TAG, ' ')
      .replace(ANKI_TTS, ' ')
      .replace(TYPE_ANSWER, ' ')
      .replace(CLOZE, '$1')
      .replace(BLOCK_TAG, '\n')
      .replace(ANY_TAG, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Same as {@link stripHtml} but keeps line breaks, for multi-sentence fields. */
export function stripHtmlKeepLines(field: string): string {
  if (!field) return '';
  return decodeEntities(
    field
      .replace(SCRIPT_OR_STYLE, ' ')
      .replace(SOUND_TAG, ' ')
      .replace(ANKI_TTS, ' ')
      .replace(TYPE_ANSWER, ' ')
      .replace(CLOZE, '$1')
      .replace(BLOCK_TAG, '\n')
      .replace(ANY_TAG, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}
