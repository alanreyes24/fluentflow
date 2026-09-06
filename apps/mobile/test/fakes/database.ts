import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrate } from '../../src/db/schema';
import { Repository } from '../../src/db/repository';

/**
 * A real SQLite database behind the slice of expo-sqlite's API that
 * {@link Repository} uses.
 *
 * The alternative — a hand-written in-memory fake — would mean reimplementing
 * SQL, and a screen test that asserts against a mocked repository proves
 * nothing about the app. Node ships SQLite as `node:sqlite`, so the tests run
 * the real migrations, the real indexes and the real queries; pressing "Good"
 * in a test runs the same scheduling code the app runs.
 *
 * The only difference from the app is the driver: expo-sqlite is async and
 * `node:sqlite` is synchronous, so every method here is a promise around a
 * synchronous call.
 */

type Params = readonly unknown[];

export interface FakeDatabase extends SQLiteDatabase {
  /** The underlying handle, for assertions that want raw SQL. */
  readonly raw: DatabaseSync;
}

export function createTestDatabase(): FakeDatabase {
  const db = new DatabaseSync(':memory:');
  // expo-sqlite's transaction helper does not nest, but screens call
  // repository methods concurrently and a stray nested BEGIN would fail with a
  // confusing SQLite error rather than a useful test failure.
  let depth = 0;

  const api = {
    raw: db,

    async getAllAsync<T>(sql: string, ...params: Params): Promise<T[]> {
      return db.prepare(sql).all(...bind(params)) as T[];
    },

    async getFirstAsync<T>(sql: string, ...params: Params): Promise<T | null> {
      return (db.prepare(sql).get(...bind(params)) as T | undefined) ?? null;
    },

    async runAsync(sql: string, ...params: Params) {
      const result = db.prepare(sql).run(...bind(params));
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },

    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },

    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
      if (depth++ > 0) {
        try {
          await task();
        } finally {
          depth--;
        }
        return;
      }

      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        depth--;
      }
    },

    async closeAsync(): Promise<void> {
      db.close();
    },
  };

  return api as unknown as FakeDatabase;
}

/**
 * Open a migrated database and a repository over it.
 *
 * Returns `close` rather than relying on garbage collection: a test file that
 * opens a database per case will otherwise hold every one of them open until
 * the process exits.
 */
export async function createTestRepository(): Promise<{
  repository: Repository;
  database: FakeDatabase;
  close: () => Promise<void>;
}> {
  const database = createTestDatabase();
  await migrate(database);
  return {
    repository: new Repository(database),
    database,
    close: () => database.closeAsync(),
  };
}

/**
 * `node:sqlite` accepts only null, number, bigint, string and Uint8Array.
 * Booleans arrive from nowhere in this codebase — the repository converts them
 * — but an `undefined` from a mistyped call should fail as a readable test
 * error rather than a driver assertion.
 */
function bind(params: Params): (null | number | bigint | string | Uint8Array)[] {
  return params.map((value, index) => {
    if (value === undefined) {
      throw new TypeError(`SQL parameter ${index + 1} is undefined; pass null instead.`);
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value as null | number | bigint | string | Uint8Array;
  });
}
