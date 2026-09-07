import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { TargetLanguage } from '@fluentflow/core';
import type { DictionaryEntry, DictionaryLookup } from '@fluentflow/core';

/** The same Wiktionary-derived files used by the Electron main process. */
const LANGUAGE_NAMES: Record<TargetLanguage, string> = {
  es: 'Spanish',
  bs: 'Serbo-Croatian',
};

interface DictionaryHandle {
  db: DatabaseSync;
  entry: StatementSync;
  form: StatementSync;
}

export interface DictionaryStatus {
  available: boolean;
  dir: string;
  languages: Partial<Record<TargetLanguage, boolean>>;
  source: Partial<Record<TargetLanguage, string>>;
  reason?: string;
}

const open = new Map<TargetLanguage, DictionaryHandle | null>();

export function dictionaryDir(): string {
  if (process.env.FLUENTFLOW_DICTIONARY_DIR) return process.env.FLUENTFLOW_DICTIONARY_DIR;
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'FluentFlow', 'dictionaries');
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'FluentFlow', 'dictionaries');
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'FluentFlow', 'dictionaries');
}

function fileFor(language: TargetLanguage): string {
  return join(dictionaryDir(), `${language}-en.sqlite3`);
}

export function dictionaryStatus(): DictionaryStatus {
  const dir = dictionaryDir();
  const languages = Object.fromEntries(
    (Object.keys(LANGUAGE_NAMES) as TargetLanguage[]).map((language) => [language, existsSync(fileFor(language))]),
  ) as Partial<Record<TargetLanguage, boolean>>;
  const available = Object.values(languages).some(Boolean);
  return {
    available,
    dir,
    languages,
    source: LANGUAGE_NAMES,
    ...(available ? {} : { reason: `No dictionaries in ${dir}. Run: npm run fetch-dictionaries` }),
  };
}

function database(language: TargetLanguage): DictionaryHandle | null {
  if (open.has(language)) return open.get(language) ?? null;
  const file = fileFor(language);
  if (!existsSync(file)) {
    open.set(language, null);
    return null;
  }
  const db = new DatabaseSync(file, { readOnly: true });
  const handle: DictionaryHandle = {
    db,
    entry: db.prepare('SELECT word, gloss, pos FROM entry WHERE word = ? LIMIT 5'),
    form: db.prepare('SELECT lemma FROM form WHERE word = ? LIMIT 1'),
  };
  open.set(language, handle);
  return handle;
}

/** A core-compatible lookup, kept synchronous because SQLite is local. */
export function dictionaryLookup(language: TargetLanguage): DictionaryLookup | null {
  if (!dictionaryStatus().languages[language]) return null;
  return (word: string): DictionaryEntry[] => {
    const handle = database(language);
    if (!handle) return [];
    const rows = handle.entry.all(word) as Array<{ word: string; gloss: string; pos: string | null }>;
    if (rows.length > 0) {
      return rows.map((row) => ({ word: row.word, gloss: row.gloss, pos: row.pos, lemma: null }));
    }
    const form = handle.form.get(word) as { lemma?: string } | undefined;
    return form?.lemma ? [{ word, gloss: '', pos: null, lemma: form.lemma }] : [];
  };
}

export function unloadDictionaries(): void {
  for (const handle of open.values()) handle?.db.close();
  open.clear();
}
