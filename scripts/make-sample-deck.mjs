#!/usr/bin/env node
/**
 * Write a real `.apkg` to import on a device.
 *
 * The Anki importer is the only path that parses a collection *on the device*
 * — the web build hands the archive to the sync server instead — so it is the
 * most valuable thing to exercise on a phone and the hardest to reach, because
 * it needs an actual file in an actual file picker.
 *
 * The archive is built by the same fixture the tests and `verify-flow.mjs`
 * use: real SQLite bytes in a real ZIP, in Anki's own schema, including the
 * `unicase` collation that makes modern collections unreadable without repair.
 * A deck exported from Anki Desktop would be more authentic, but it would also
 * be a binary nobody can regenerate.
 *
 *   npm run sample-deck                  # 60 cards, schema 18
 *   node scripts/make-sample-deck.mjs --schema 11 --cards 20
 *
 * AirDrop or copy the result to the phone, then import it from the app.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApkg, spanishNotes } from '../packages/core/test/helpers/anki-fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const options = parseArgs(process.argv.slice(2));
const output = join(ROOT, `sample-deck-${options.cards}-schema${options.schema}.apkg`);

const bytes = buildApkg({
  schema: options.schema,
  // Two decks, nested, so the "keep subdecks separate / merge into one" choice
  // on the import screen has something to actually do.
  decks: ['Spanish A1', 'Spanish A1::Verbs'],
  fieldNames: ['Front', 'Back'],
  notes: spanishNotes(options.cards),
});

await writeFile(output, bytes);

console.log(`${output}`);
console.log(
  `  ${options.cards} cards, Anki schema ${options.schema}, ${(bytes.length / 1024).toFixed(1)} kB`,
);
console.log('\nGet it onto the phone (AirDrop, or Files via iCloud), then:');
console.log('  Decks -> Import from Anki -> Choose .apkg file');

function parseArgs(argv) {
  const read = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at === -1 ? fallback : Number(argv[at + 1]);
  };

  const schema = read('--schema', 18);
  if (schema !== 11 && schema !== 18) {
    throw new Error(`--schema must be 11 or 18, not ${schema}. Those are the two Anki ships.`);
  }

  const cards = read('--cards', 60);
  if (!Number.isInteger(cards) || cards < 1) {
    throw new Error(`--cards must be a positive whole number, not ${cards}.`);
  }

  return { schema, cards };
}
