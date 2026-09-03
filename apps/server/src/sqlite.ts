import { DatabaseSync } from 'node:sqlite';
import type { AnkiDatabase, AnkiRow } from '@fluentflow/core';
import {
  READ_SCHEMA_VERSION_SQL,
  STRIP_UNKNOWN_COLLATIONS_SQL,
  WRITABLE_SCHEMA_OFF,
  WRITABLE_SCHEMA_ON,
  bumpSchemaVersionSql,
} from '@fluentflow/core';

/**
 * Opens an extracted Anki collection with Node's built-in SQLite.
 *
 * The collection never touches disk: `deserialize` mounts the bytes as an
 * in-memory database. It is mounted twice on purpose — once to strip Anki's
 * `unicase` collation from the stored schema (see `collation.ts` in core for
 * why that is necessary), and again on a fresh connection, because the
 * connection that performed the rewrite still holds the unusable schema in its
 * cache.
 */
export async function openAnkiCollection(bytes: Uint8Array): Promise<AnkiDatabase> {
  const db = new DatabaseSync(':memory:');
  db.deserialize(repairCollations(bytes));

  return {
    all(sql: string): AnkiRow[] {
      return db.prepare(sql).all() as AnkiRow[];
    },
    close(): void {
      db.close();
    },
  };
}

/** Rewrite the stored schema on a throwaway connection and hand back the bytes. */
function repairCollations(bytes: Uint8Array): Buffer {
  const staging = new DatabaseSync(':memory:');
  try {
    staging.enableDefensive(false);
    staging.deserialize(Buffer.from(bytes));
    staging.exec(WRITABLE_SCHEMA_ON);
    staging.exec(STRIP_UNKNOWN_COLLATIONS_SQL);
    staging.exec(bumpSchemaVersionSql(readSchemaVersion(staging)));
    staging.exec(WRITABLE_SCHEMA_OFF);
    return staging.serialize();
  } finally {
    staging.close();
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(READ_SCHEMA_VERSION_SQL).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  return Number(value ?? 0);
}
