/**
 * Anki's `unicase` collation, and why importing needs a repair step.
 *
 * Anki declares its schema-18 text columns `collate unicase` — a collation its
 * Rust layer registers on the connection at runtime. Nothing else has it, and
 * SQLite is stricter about a missing collation than you would hope:
 *
 *  - On an ordinary rowid table, a plain `SELECT` of the column still works;
 *    only `ORDER BY` and index use fail.
 *  - On a `WITHOUT ROWID` table the whole table *is* an index, so **every**
 *    query fails with "no query solution". Anki's `fields` and `templates`
 *    tables are `WITHOUT ROWID`, and `fields` is where note-type field names
 *    live — exactly what the importer needs to tell "Front" from "Back".
 *
 * Neither `node:sqlite` nor `expo-sqlite` exposes an API for registering a
 * custom collation, so the practical fix is to edit the stored schema of the
 * throwaway copy that was just extracted from the archive: drop the collation
 * clause, bump the schema cookie so the next connection reparses, and reopen.
 * Nothing user-visible changes — the collation only ever affected sort order,
 * and the importer sorts in JavaScript.
 */

export const WRITABLE_SCHEMA_ON = 'PRAGMA writable_schema=ON';
export const WRITABLE_SCHEMA_OFF = 'PRAGMA writable_schema=OFF';

/**
 * Strips every `collate <name>` clause that stock SQLite cannot resolve.
 * Only Anki's `unicase` is targeted; the built-in `binary`, `nocase` and `rtrim`
 * collations are left alone.
 */
export const STRIP_UNKNOWN_COLLATIONS_SQL = `
UPDATE sqlite_master
SET sql = replace(replace(sql, ' collate unicase', ''), ' COLLATE unicase', '')
WHERE sql LIKE '%unicase%'
`.trim();

export const READ_SCHEMA_VERSION_SQL = 'PRAGMA schema_version';

export function bumpSchemaVersionSql(current: number): string {
  return `PRAGMA schema_version = ${Math.floor(current) + 1}`;
}

export interface WritableSqlite {
  exec(sql: string): void | Promise<void>;
  /** Current value of `PRAGMA schema_version`. */
  schemaVersion(): number | Promise<number>;
}

/**
 * Run the repair on a writable connection. The caller must close this
 * connection and open a fresh one afterwards: a connection that already failed
 * to resolve the collation keeps its broken schema cached.
 */
export async function stripUnknownCollations(db: WritableSqlite): Promise<void> {
  await db.exec(WRITABLE_SCHEMA_ON);
  try {
    await db.exec(STRIP_UNKNOWN_COLLATIONS_SQL);
    const version = await db.schemaVersion();
    await db.exec(bumpSchemaVersionSql(version));
  } finally {
    await db.exec(WRITABLE_SCHEMA_OFF);
  }
}
