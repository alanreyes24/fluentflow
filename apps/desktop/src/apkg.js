'use strict';

/**
 * Anki import, in the main process.
 *
 * The desktop shell renders the Expo *web* export, so as far as the app is
 * concerned `Platform.OS === 'web'` — and the web import path defers to the
 * sync server, because a browser has no SQLite that can mount a collection from
 * bytes. On Windows that made import impossible in practice: it needed a server
 * running at `apiBaseUrl` *and* a signed-in Firebase account, for a file already
 * sitting on the user's disk.
 *
 * Electron 44 ships Node 24, where `node:sqlite` is unflagged, so the main
 * process can do exactly what the server does — and this is the same code path,
 * `parseApkg` from core, reading the same collection the same way. The only
 * difference is where it runs. See `apps/server/src/sqlite.ts`, which this
 * mirrors deliberately: if one of them needs a fix, so does the other.
 *
 * Nothing here is reachable from the page. The renderer asks over IPC for a file
 * *it* picked or dropped and gets parsed decks back; it never names a path the
 * user did not choose.
 */

const { DatabaseSync } = require('node:sqlite');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * The vendored core build (see `scripts/vendor-core.mjs`). It is ESM and this
 * file is CommonJS, so it arrives through a dynamic import — resolved once and
 * reused, because the tokeniser tables in the same package are not cheap.
 */
const CORE_ENTRY = pathToFileURL(path.join(__dirname, '..', 'vendor', 'core', 'index.js')).href;

/** Anki's own two extensions. `.colpkg` is a whole-collection export. */
const EXTENSIONS = /\.(apkg|colpkg)$/i;

/**
 * Refuse absurd files before reading them into memory. A large shared deck with
 * media is tens of megabytes; a gigabyte is not an Anki package.
 */
const MAX_BYTES = 512 * 1024 * 1024;

let corePromise = null;

function core() {
  corePromise ??= import(CORE_ENTRY);
  return corePromise;
}

/**
 * Parse an `.apkg` at `filePath` into decks and cards.
 *
 * Resolves to a plain object either way rather than rejecting, because the
 * result crosses `ipcRenderer.invoke`: a thrown error arrives at the renderer
 * wrapped in "Error invoking remote method", which would bury the message
 * `ApkgError` carries — and those messages are written to be read by the person
 * importing the deck.
 *
 * @param {string} filePath
 * @param {{ userId: string, language?: string, flatten?: boolean }} options
 */
async function importApkg(filePath, options) {
  try {
    if (!EXTENSIONS.test(filePath)) {
      return failure(
        'NOT_A_ZIP',
        `"${path.basename(filePath)}" is not an Anki package. Choose a .apkg file exported from Anki.`,
      );
    }

    const { size } = await stat(filePath);
    if (size > MAX_BYTES) {
      return failure('NOT_A_ZIP', `"${path.basename(filePath)}" is too large to be an Anki package.`);
    }

    const { parseApkg } = await core();
    const bytes = new Uint8Array(await readFile(filePath));

    const result = await parseApkg(bytes, {
      open: openCollection,
      userId: options.userId,
      filename: path.basename(filePath),
      language: options.language,
      flatten: options.flatten,
    });

    return { ok: true, decks: result.decks, cards: result.cards, summary: result.summary };
  } catch (error) {
    return failure(error?.code ?? 'SQLITE_FAILED', error?.message ?? 'The import failed.');
  }
}

function failure(code, message) {
  return { ok: false, code, message };
}

/**
 * Mount an extracted collection with Node's built-in SQLite.
 *
 * The collection never touches disk. It is mounted twice on purpose: once to
 * strip Anki's `unicase` collation out of the stored schema, and again on a
 * fresh connection, because the connection that rewrote the schema still holds
 * the unusable one in its cache. `collation.ts` in core explains why the
 * collation blocks the read at all.
 */
async function openCollection(bytes) {
  const repaired = await repairCollations(bytes);
  const db = new DatabaseSync(':memory:');
  db.deserialize(repaired);

  return {
    all(sql) {
      return db.prepare(sql).all();
    },
    close() {
      db.close();
    },
  };
}

async function repairCollations(bytes) {
  const {
    READ_SCHEMA_VERSION_SQL,
    STRIP_UNKNOWN_COLLATIONS_SQL,
    WRITABLE_SCHEMA_OFF,
    WRITABLE_SCHEMA_ON,
    bumpSchemaVersionSql,
  } = await core();

  const staging = new DatabaseSync(':memory:');
  try {
    staging.enableDefensive(false);
    staging.deserialize(Buffer.from(bytes));
    staging.exec(WRITABLE_SCHEMA_ON);
    staging.exec(STRIP_UNKNOWN_COLLATIONS_SQL);
    const row = staging.prepare(READ_SCHEMA_VERSION_SQL).get();
    staging.exec(bumpSchemaVersionSql(Number(Object.values(row ?? {})[0] ?? 0)));
    staging.exec(WRITABLE_SCHEMA_OFF);
    return staging.serialize();
  } catch {
    // An older collection may need no repair. If it did need one and this
    // failed, core degrades to positional field mapping rather than refusing
    // the import — the same choice the mobile and server paths make.
    return Buffer.from(bytes);
  } finally {
    staging.close();
  }
}

module.exports = { importApkg, EXTENSIONS };
