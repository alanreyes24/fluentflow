import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  READ_SCHEMA_VERSION_SQL,
  STRIP_UNKNOWN_COLLATIONS_SQL,
  WRITABLE_SCHEMA_OFF,
  WRITABLE_SCHEMA_ON,
} from '../../dist/index.js';

/**
 * Builds real `.apkg` archives so the importer is exercised against genuine
 * SQLite bytes rather than a stubbed database. Both Anki collection schemas are
 * covered because they store decks and note types in completely different
 * places.
 */

const FIELD_SEP = '\u001f';
const DECK_SEP = '\u001f';

const SCHEMA_11 = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null,
  usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null,
  csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null,
  due integer not null, ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
`;

const SCHEMA_18_EXTRA = `
CREATE TABLE decks (
  id integer primary key, name text not null, mtime_secs integer not null,
  usn integer not null, common blob not null, kind blob not null
);
CREATE TABLE notetypes (
  id integer primary key, name text not null, mtime_secs integer not null,
  usn integer not null, config blob not null
);
CREATE TABLE fields (
  ntid integer not null, ord integer not null, name text not null,
  config blob not null, primary key (ntid, ord)
) without rowid;
CREATE TABLE templates (
  ntid integer not null, ord integer not null, name text not null,
  mtime_secs integer not null, usn integer not null, config blob not null,
  primary key (ntid, ord)
) without rowid;
`;

/**
 * Anki declares its text columns `collate unicase`, using a collation its Rust
 * layer registers at runtime. Plain SQLite has no such collation, so a reader
 * can `SELECT` those columns but blows up on `ORDER BY name`.
 *
 * The collation cannot be written by `CREATE TABLE` here for exactly that
 * reason, so it is patched into the stored schema afterwards. That makes the
 * fixture behave like a real collection and keeps the importer honest about
 * which queries it is allowed to run.
 */
function applyUnicaseCollation(db) {
  db.enableDefensive(false);
  db.exec('PRAGMA writable_schema=ON');
  db.prepare(
    `UPDATE sqlite_master
     SET sql = replace(sql, 'name text not null', 'name text not null collate unicase')
     WHERE name IN ('decks', 'notetypes', 'fields', 'templates')`,
  ).run();
  db.exec('PRAGMA writable_schema=OFF');
}

/** Collection creation time: 2024-01-01T04:00:00Z, Anki's usual 4am rollover. */
export const CRT = Math.floor(Date.UTC(2024, 0, 1, 4, 0, 0) / 1000);

/**
 * @typedef {object} FixtureNote
 * @property {string[]} fields   raw field values, in note-type order
 * @property {string}   [deck]   deck name; defaults to the first deck
 * @property {number}   [type]   Anki card type: 0 new, 1 learning, 2 review, 3 relearning
 * @property {number}   [due]    days since CRT (type 2) or epoch seconds (type 1/3)
 * @property {number}   [ivl]    interval in days
 * @property {number}   [factor] ease factor in permille, e.g. 2500
 * @property {number}   [reps]
 * @property {number}   [lapses]
 * @property {number}   [extraTemplates] additional sibling cards to emit
 */

/**
 * @param {object} options
 * @param {11|18} options.schema
 * @param {string[]} options.decks       deck names, `::` separated for hierarchy
 * @param {string[]} options.fieldNames  note-type field names
 * @param {string} [options.noteTypeName]
 * @param {number} [options.sortIndex]
 * @param {FixtureNote[]} options.notes
 * @returns {Uint8Array} the `.apkg` bytes
 */
export function buildApkg(options) {
  const {
    schema,
    decks,
    fieldNames,
    noteTypeName = 'Basic',
    sortIndex = 0,
    notes,
  } = options;

  const dir = mkdtempSync(join(tmpdir(), 'fluentflow-apkg-'));
  const dbPath = join(dir, 'collection.sqlite');

  try {
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_11);
    if (schema >= 18) db.exec(SCHEMA_18_EXTRA);

    const deckIds = new Map();
    decks.forEach((name, index) => deckIds.set(name, index === 0 ? 1 : 1000 + index));

    const noteTypeId = 1600000000000;
    const models = {
      [String(noteTypeId)]: {
        id: noteTypeId,
        name: noteTypeName,
        sortf: sortIndex,
        flds: fieldNames.map((name, ord) => ({ name, ord })),
        tmpls: [{ name: 'Card 1', ord: 0, qfmt: `{{${fieldNames[0]}}}`, afmt: `{{${fieldNames[1]}}}` }],
      },
    };
    const decksJson = Object.fromEntries(
      [...deckIds].map(([name, id]) => [String(id), { id, name }]),
    );

    // Schema 18 empties the JSON columns and uses real tables instead.
    db.prepare(
      `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
       VALUES (1, ?, ?, ?, ?, 0, 0, 0, '{}', ?, ?, '{}', '{}')`,
    ).run(
      CRT,
      CRT * 1000,
      CRT * 1000,
      schema,
      schema >= 18 ? '{}' : JSON.stringify(models),
      schema >= 18 ? '{}' : JSON.stringify(decksJson),
    );

    if (schema >= 18) {
      const insertDeck = db.prepare(
        'INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, 0, X\'\', X\'\')',
      );
      for (const [name, id] of deckIds) {
        insertDeck.run(id, name.split('::').join(DECK_SEP), CRT);
      }
      db.prepare(
        'INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, ?, ?, 0, X\'\')',
      ).run(noteTypeId, noteTypeName, CRT);
      const insertField = db.prepare(
        'INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, X\'\')',
      );
      fieldNames.forEach((name, ord) => insertField.run(noteTypeId, ord, name));
    }

    const insertNote = db.prepare(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (?, ?, ?, ?, -1, '', ?, ?, 0, 0, '')`,
    );
    const insertCard = db.prepare(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (?, ?, ?, ?, ?, -1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, '')`,
    );

    let nextId = 1700000000000;
    notes.forEach((note, index) => {
      const noteId = nextId + index * 10;
      const deckName = note.deck ?? decks[0];
      const deckId = deckIds.get(deckName) ?? 1;
      const type = note.type ?? 0;

      insertNote.run(
        noteId,
        `guid-${index}`,
        noteTypeId,
        CRT,
        note.fields.join(FIELD_SEP),
        note.fields[sortIndex] ?? note.fields[0] ?? '',
      );

      const templates = 1 + (note.extraTemplates ?? 0);
      for (let ord = 0; ord < templates; ord++) {
        insertCard.run(
          noteId + 1 + ord,
          noteId,
          deckId,
          ord,
          CRT,
          ord === 0 ? type : 0,
          ord === 0 ? type : 0,
          ord === 0 ? (note.due ?? index) : index,
          ord === 0 ? (note.ivl ?? 0) : 0,
          ord === 0 ? (note.factor ?? 0) : 0,
          ord === 0 ? (note.reps ?? 0) : 0,
          ord === 0 ? (note.lapses ?? 0) : 0,
        );
      }
    });

    if (schema >= 18) applyUnicaseCollation(db);
    db.close();

    const collectionBytes = new Uint8Array(readFileSync(dbPath));
    const entryName = schema >= 18 ? 'collection.anki21' : 'collection.anki2';
    /** @type {Record<string, Uint8Array>} */
    const entries = { [entryName]: collectionBytes, media: strToU8('{}') };
    if (schema >= 18) {
      // Modern exports also ship a downgrade stub; the importer must ignore it.
      entries['collection.anki2'] = buildDowngradeStub(dir);
    }
    return zipSync(entries);
  } finally {
    removeQuietly(dir);
  }
}

/**
 * Windows keeps the SQLite file mapped for a moment after `close()`, so a
 * straight `rmSync` on the containing directory intermittently hits EPERM.
 * These are throwaway temp directories, so retry briefly and then let the OS
 * reclaim them rather than failing an unrelated assertion.
 */
function removeQuietly(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 20;
      while (Date.now() < until) { /* brief spin before retrying */ }
    }
  }
}

/** An empty schema-11 collection, mimicking the stub modern Anki includes. */
function buildDowngradeStub(dir) {
  const stubPath = join(dir, 'stub.sqlite');
  const db = new DatabaseSync(stubPath);
  db.exec(SCHEMA_11);
  db.prepare(
    `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
     VALUES (1, ?, 0, 0, 11, 0, 0, 0, '{}', '{}', '{}', '{}', '{}')`,
  ).run(CRT);
  db.close();
  return new Uint8Array(readFileSync(stubPath));
}

/**
 * SQLite opener backed by `node:sqlite`, matching the `OpenAnkiDatabase` shape.
 *
 * `deserialize` mounts the collection straight from memory, so no temp file is
 * involved. The collation repair runs on the same in-memory copy, then the
 * database is re-deserialised into a fresh connection — the connection that
 * performed the rewrite still holds the old, unusable schema in its cache.
 */
export async function openWithNodeSqlite(bytes) {
  const staging = new DatabaseSync(':memory:');
  staging.enableDefensive(false);
  staging.deserialize(Buffer.from(bytes));
  staging.exec(WRITABLE_SCHEMA_ON);
  staging.exec(STRIP_UNKNOWN_COLLATIONS_SQL);
  const version = Number(Object.values(staging.prepare(READ_SCHEMA_VERSION_SQL).get())[0]);
  staging.exec(`PRAGMA schema_version = ${version + 1}`);
  staging.exec(WRITABLE_SCHEMA_OFF);
  const repaired = staging.serialize();
  staging.close();

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

/**
 * An opener that skips the collation repair, used to prove the importer
 * degrades to positional field mapping instead of failing outright.
 */
export async function openWithoutCollationRepair(bytes) {
  const db = new DatabaseSync(':memory:');
  db.deserialize(Buffer.from(bytes));
  return {
    all(sql) {
      return db.prepare(sql).all();
    },
    close() {
      db.close();
    },
  };
}

/** A realistic 60-note Spanish vocabulary deck with mixed scheduling states. */
export function spanishNotes(count = 60) {
  const words = [
    ['hablar', 'to speak'], ['comer', 'to eat'], ['vivir', 'to live'],
    ['la casa', 'the house'], ['el libro', 'the book'], ['la ciudad', 'the city'],
    ['pequeño', 'small'], ['grande', 'big'], ['rápido', 'fast'],
    ['el agua', 'the water'], ['la comida', 'the food'], ['el trabajo', 'the work'],
  ];
  return Array.from({ length: count }, (_, i) => {
    const [word, meaning] = words[i % words.length];
    const suffix = i >= words.length ? ` ${Math.floor(i / words.length) + 1}` : '';
    const bucket = i % 3;
    return {
      fields: [`${word}${suffix}`, `<div>${meaning}</div>`, ''],
      // A real collection is a mix of new, learning and mature review cards.
      type: bucket === 0 ? 0 : 2,
      ivl: bucket === 0 ? 0 : bucket === 1 ? 5 : 40,
      factor: bucket === 0 ? 0 : bucket === 1 ? 2300 : 2750,
      due: bucket === 0 ? i : 300 + i,
      reps: bucket === 0 ? 0 : bucket === 1 ? 3 : 9,
      lapses: bucket === 2 ? 1 : 0,
    };
  });
}
