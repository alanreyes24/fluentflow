#!/usr/bin/env node
/**
 * Build the bilingual dictionaries the app looks words up in.
 *
 * Source is Wiktionary, by way of kaikki.org's machine-readable extracts. Two
 * things about that source decide this whole design:
 *
 *  - It carries **inflected forms** as entries of their own, each pointing at
 *    the word it inflects. `comieron` is in there as "third-person plural
 *    preterite of comer", which is what makes a pasted word list — full of
 *    conjugations nobody lemmatised — actually resolvable. Writing Spanish
 *    morphology by hand instead was the alternative, and it is a worse one.
 *  - Wiktionary files Bosnian, Croatian and Serbian together as
 *    **Serbo-Croatian**, which is the only reason Bosnian is possible at all.
 *    FreeDict's Serbian is 398 headwords; WikDict has no Bosnian, Croatian or
 *    Serbian at all.
 *
 * The extracts are large — Spanish is 979 MB of JSONL — so they are streamed
 * through and distilled as they arrive rather than downloaded first. What comes
 * out is a few megabytes of SQLite, which every platform here can already read.
 *
 *   node scripts/fetch-dictionaries.mjs              # both languages
 *   node scripts/fetch-dictionaries.mjs --language bs
 *   node scripts/fetch-dictionaries.mjs --dir <path>
 *
 * Wiktionary is CC-BY-SA. The attribution travels with the file, in a `meta`
 * table the app reads and shows.
 */

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const SOURCES = {
  es: {
    name: 'Spanish',
    url: 'https://kaikki.org/dictionary/Spanish/kaikki.org-dictionary-Spanish.jsonl',
    approxMb: 979,
  },
  bs: {
    // Wiktionary has no separate Bosnian: bs, hr and sr share one entry set.
    name: 'Serbo-Croatian',
    url: 'https://kaikki.org/dictionary/Serbo-Croatian/kaikki.org-dictionary-SerboCroatian.jsonl',
    approxMb: 277,
  },
};

const ATTRIBUTION =
  'Wiktionary via kaikki.org (wiktextract), CC BY-SA 4.0. https://kaikki.org';

/**
 * Senses not worth a card back.
 *
 * A learner pasting a vocabulary list wants the current, ordinary meaning. The
 * obsolete and dialectal senses are the bulk of what makes these files large
 * and the glosses noisy.
 */
const SKIP_TAGS = new Set([
  'obsolete', 'archaic', 'rare', 'dated', 'historical', 'poetic', 'dialectal', 'proscribed',
]);

function defaultDir() {
  if (process.env.FLUENTFLOW_DICTIONARY_DIR) return process.env.FLUENTFLOW_DICTIONARY_DIR;
  const home = homedir();
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'FluentFlow', 'dictionaries');
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'FluentFlow', 'dictionaries');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'FluentFlow', 'dictionaries');
}

function parseArgs(argv) {
  const options = { languages: Object.keys(SOURCES), dir: defaultDir(), force: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--language': options.languages = [argv[++i]]; break;
      case '--dir': options.dir = argv[++i] ?? options.dir; break;
      case '--force': options.force = true; break;
      case '--help':
      case '-h':
        console.log('Usage: node scripts/fetch-dictionaries.mjs [--language es|bs] [--dir <path>] [--force]');
        process.exit(0);
        break;
      default:
        console.error(`Unrecognised argument "${argv[i]}".`);
        process.exit(1);
    }
  }
  for (const language of options.languages) {
    if (!SOURCES[language]) {
      console.error(`Unknown language "${language}". Choose: ${Object.keys(SOURCES).join(', ')}.`);
      process.exit(1);
    }
  }
  return options;
}

/**
 * Rank the senses of one word.
 *
 * Wiktionary's own order is page order, which puts `zdravo` = "healthily"
 * (adverb) above `zdravo` = "hello!" (interjection), and `hvala` = "praise"
 * above "thank you!". For a learner that is exactly backwards, so
 * interjections come first and short glosses beat long ones.
 */
function rank(senses) {
  return senses.sort((a, b) => {
    const interjection = (s) => (s.pos === 'intj' ? 0 : 1);
    return interjection(a) - interjection(b) || a.gloss.length - b.gloss.length;
  });
}

async function build(language, options) {
  const source = SOURCES[language];
  const destination = join(options.dir, `${language}-en.sqlite3`);
  const partial = `${destination}.partial`;

  if (existsSync(destination) && !options.force) {
    console.log(`  ${language}: already built. Pass --force to rebuild.`);
    return;
  }

  console.log(`\n  ${language}: ${source.name}, ~${source.approxMb} MB to stream`);

  await rm(partial, { force: true });
  const db = new DatabaseSync(partial);
  /*
   * Forms are separated from meanings deliberately.
   *
   * Most of a Spanish extract is inflected forms — 768,000 headwords for maybe
   * 90,000 words — and each one carries a gloss that says "third-person plural
   * preterite of comer" and nothing else. Storing those glosses costs 45 MB to
   * repeat what the lemma column already says. A form only needs to point.
   */
  db.exec(`
    CREATE TABLE entry (word TEXT NOT NULL, gloss TEXT NOT NULL, pos TEXT);
    CREATE TABLE form (word TEXT NOT NULL, lemma TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const response = await fetch(source.url);
  if (!response.ok || !response.body) {
    throw new Error(`${language}: HTTP ${response.status} from ${source.url}`);
  }

  const byWord = new Map();
  const forms = new Map();
  let read = 0;
  let bytes = 0;
  let lastReport = 0;

  const lines = createInterface({ input: Readable.fromWeb(response.body) });
  for await (const line of lines) {
    bytes += line.length + 1;
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A truncated line is not worth failing the whole build over.
    }

    const word = entry.word;
    if (!word || word.length > 60) continue;

    for (const sense of entry.senses ?? []) {
      const gloss = (sense.glosses ?? []).join('; ').trim();
      if (!gloss) continue;
      if ((sense.tags ?? []).some((tag) => SKIP_TAGS.has(tag))) continue;

      const lemma = sense.form_of?.[0]?.word ?? null;
      if (lemma && lemma !== word) {
        // A pointer, not a meaning.
        forms.set(word, lemma);
        continue;
      }

      if (!byWord.has(word)) byWord.set(word, []);
      byWord.get(word).push({ gloss: gloss.slice(0, 120), pos: entry.pos ?? null });
    }

    read++;
    const now = Date.now();
    if (now - lastReport > 500) {
      lastReport = now;
      process.stdout.write(
        `\r    ${(bytes / 1048576).toFixed(0)} MB · ${byWord.size} words · ${forms.size} forms   `,
      );
    }
  }

  const insert = db.prepare('INSERT INTO entry (word, gloss, pos) VALUES (?, ?, ?)');
  const insertForm = db.prepare('INSERT INTO form (word, lemma) VALUES (?, ?)');
  db.exec('BEGIN');
  let senses = 0;
  for (const [word, all] of byWord) {
    for (const sense of rank(all).slice(0, 3)) {
      insert.run(word, sense.gloss, sense.pos);
      senses++;
    }
  }
  for (const [word, lemma] of forms) {
    // A form that is also a word in its own right keeps its meanings; the
    // pointer is only useful when there is nothing else to say.
    if (!byWord.has(word)) insertForm.run(word, lemma);
  }
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  setMeta.run('language', language);
  setMeta.run('source', source.name);
  setMeta.run('attribution', ATTRIBUTION);
  setMeta.run('built', new Date().toISOString());
  db.exec('COMMIT');

  // The index goes on last: building it once over the finished table is much
  // faster than maintaining it across a million inserts.
  db.exec('CREATE INDEX entry_word ON entry (word)');
  db.exec('CREATE INDEX form_word ON form (word)');
  db.exec('VACUUM');
  db.close();

  await rename(partial, destination);
  const { size } = await stat(destination);
  process.stdout.write(
    `\r    ${byWord.size} words, ${senses} senses, ${forms.size} forms, ` +
      `${(size / 1048576).toFixed(1)} MB — done          \n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('\nFluentFlow dictionaries');
  console.log(`  into ${options.dir}`);
  console.log(`  ${ATTRIBUTION}`);

  await mkdir(options.dir, { recursive: true });
  for (const language of options.languages) {
    await build(language, options);
  }

  console.log('\nDone. Restart FluentFlow and paste a word list.');
}

await main();
