import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { buildApkg, spanishNotes } from '../../../packages/core/test/helpers/anki-fixture.js';

/**
 * The main process's Anki importer.
 *
 * This is the whole reason Windows can import a deck at all: the renderer is the
 * web export, and the web import path needs the sync server and an account. So
 * what is checked here is that the file on disk becomes decks and cards without
 * either — over real archive bytes and real `node:sqlite`, the same fixture
 * builder core and the server use.
 *
 * `node:sqlite` is available here for the same reason it is available in the
 * shell: Electron 44 ships Node 24. If that stops being true, this test is the
 * first thing that fails, which is the point.
 */

const require = createRequire(import.meta.url);
const { importApkg } = require('../src/apkg.js');

const scratch = mkdtempSync(join(tmpdir(), 'fluentflow-desktop-test-'));
after(() => rm(scratch, { recursive: true, force: true }));

/** Write an archive where the importer expects one: a path, not bytes. */
function writeDeck(name, bytes) {
  const path = join(scratch, name);
  writeFileSync(path, bytes);
  return path;
}

test('imports a real archive into decks and cards, with no server and no account', async () => {
  const path = writeDeck(
    'Spanish A1.apkg',
    buildApkg({
      schema: 18,
      decks: ['Spanish A1'],
      fieldNames: ['Front', 'Back', 'Example'],
      notes: spanishNotes(60),
    }),
  );

  const result = await importApkg(path, { userId: 'local-user' });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.cards.length, 60);
  assert.equal(result.decks.length, 1);
  assert.equal(result.decks[0].language, 'es');
  assert.equal(result.summary.schema, 18);

  // Owned by whoever is signed in locally — including the account-less user,
  // which is the case the whole path exists for.
  assert.ok(result.cards.every((card) => card.userId === 'local-user'));

  // Scheduling carried over from Anki rather than reset, the same as every
  // other import path.
  const mature = result.cards.find((card) => card.interval === 40);
  assert.ok(mature, 'a mature review card should survive the import');
  assert.equal(mature.status, 'mastered');
});

test('honours a forced language and merged subdecks', async () => {
  // Notes name their own deck, which is how a shared deck ends up split across
  // a dozen "Level N" subdecks in the first place.
  const path = writeDeck(
    'Bosnian Core.apkg',
    buildApkg({
      schema: 18,
      decks: ['Bosnian::Level 1', 'Bosnian::Level 2'],
      fieldNames: ['Front', 'Back', 'Example'],
      notes: [
        { fields: ['jedan', 'one', ''], deck: 'Bosnian::Level 1' },
        { fields: ['dva', 'two', ''], deck: 'Bosnian::Level 1' },
        { fields: ['tri', 'three', ''], deck: 'Bosnian::Level 2' },
      ],
    }),
  );

  const separate = await importApkg(path, { userId: 'local-user' });
  assert.equal(separate.ok, true, separate.message);
  assert.equal(separate.decks.length, 2, 'subdecks are kept apart by default');

  const merged = await importApkg(path, { userId: 'local-user', language: 'bs', flatten: true });
  assert.equal(merged.ok, true, merged.message);
  assert.equal(merged.decks.length, 1);
  assert.equal(merged.cards.length, 3);
  assert.equal(merged.decks[0].language, 'bs');
  assert.ok(merged.cards.every((card) => card.language === 'bs'));
});

test('turns a file that is not an Anki package away by name', async () => {
  const path = writeDeck('holiday-photos.zip', Buffer.from('PKnot-a-collection'));

  const result = await importApkg(path, { userId: 'local-user' });

  assert.equal(result.ok, false);
  // The message names the file and says what to choose instead, because it is
  // shown to the person importing rather than logged.
  assert.match(result.message, /holiday-photos\.zip/);
  assert.match(result.message, /\.apkg/);
});

test('reports a corrupt archive instead of throwing across the bridge', async () => {
  const path = writeDeck('Broken.apkg', Buffer.from('this is not a zip file at all'));

  const result = await importApkg(path, { userId: 'local-user' });

  // A rejection would reach the renderer wrapped in "Error invoking remote
  // method", which buries the message. Failure is a value here.
  assert.equal(result.ok, false);
  assert.equal(typeof result.code, 'string');
  assert.ok(result.message.length > 0);
});

test('reports a missing file rather than crashing the main process', async () => {
  const result = await importApkg(join(scratch, 'gone.apkg'), { userId: 'local-user' });

  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
});
