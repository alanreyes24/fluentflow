'use strict';

/**
 * Bilingual dictionary lookup, in the main process.
 *
 * The files are built by `npm run fetch-dictionaries` and live beside the
 * model in the user data directory. They are SQLite, read here through
 * `node:sqlite` — no native module, nothing to rebuild against Electron.
 *
 * Two tables, because most of a Spanish dictionary is inflected forms:
 *
 *   entry (word, gloss, pos)   what a word means
 *   form  (word, lemma)        which word an inflected form belongs to
 *
 * `comieron` is in `form` pointing at `comer`; `comer` is in `entry` with "to
 * eat". Separating them halved the Spanish file, from 79 MB to 40 MB, because
 * 665,709 form rows no longer each carry a sentence saying which form they are.
 *
 * Lookup is a millisecond. The model, for comparison, is 1.4 seconds a word,
 * which is why this runs first and the model only sees what it misses.
 */

const { app } = require('electron');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

/** Wiktionary files Bosnian, Croatian and Serbian together as Serbo-Croatian. */
const LANGUAGE_NAMES = { es: 'Spanish', bs: 'Serbo-Croatian' };

const open = new Map();

function dictionaryDir() {
  return (
    process.env.FLUENTFLOW_DICTIONARY_DIR ||
    path.join(app.getPath('userData'), 'dictionaries')
  );
}

function fileFor(language) {
  return path.join(dictionaryDir(), `${language}-en.sqlite3`);
}

/** Which dictionaries are installed, for the UI to say so before it offers. */
function status() {
  const dir = dictionaryDir();
  const languages = {};
  for (const language of Object.keys(LANGUAGE_NAMES)) {
    languages[language] = existsSync(fileFor(language));
  }

  const available = Object.values(languages).some(Boolean);
  return {
    available,
    dir,
    languages,
    source: LANGUAGE_NAMES,
    ...(available ? {} : { reason: `No dictionaries in ${dir}. Run: npm run fetch-dictionaries` }),
  };
}

function database(language) {
  if (open.has(language)) return open.get(language);

  const file = fileFor(language);
  if (!existsSync(file)) {
    open.set(language, null);
    return null;
  }

  const db = new DatabaseSync(file, { readOnly: true });
  const handle = {
    db,
    entry: db.prepare('SELECT word, gloss, pos FROM entry WHERE word = ? LIMIT 5'),
    form: db.prepare('SELECT lemma FROM form WHERE word = ? LIMIT 1'),
  };
  open.set(language, handle);
  return handle;
}

/**
 * Rows for one headword, in the shape core's resolver expects.
 *
 * An inflected form comes back as a single row with no gloss and a `lemma`,
 * which is the resolver's signal to look the lemma up instead.
 */
function lookup(language, word) {
  const handle = database(language);
  if (!handle) return [];

  const rows = handle.entry.all(word);
  if (rows.length > 0) {
    return rows.map((row) => ({ word: row.word, gloss: row.gloss, pos: row.pos, lemma: null }));
  }

  const form = handle.form.get(word);
  return form ? [{ word, gloss: '', pos: null, lemma: form.lemma }] : [];
}

/** Attribution, which travels with the file because Wiktionary is CC BY-SA. */
function attribution(language) {
  const handle = database(language);
  if (!handle) return null;
  const row = handle.db.prepare("SELECT value FROM meta WHERE key = 'attribution'").get();
  return row?.value ?? null;
}

/** Close every open dictionary, so a rebuilt file is picked up on next use. */
function unload() {
  for (const handle of open.values()) handle?.db.close();
  open.clear();
}

module.exports = { status, lookup, attribution, unload, dictionaryDir };
