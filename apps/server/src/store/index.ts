import type { Config } from '../config.ts';
import { MemoryStore } from './memory.ts';
import { StoreUnavailableError, type Store } from './types.ts';

export type { Store } from './types.ts';
export { MemoryStore } from './memory.ts';

/**
 * Pick a store for this deployment:
 *
 *  - `DATABASE_URL` set → Postgres (the hosted app on Railway).
 *  - local mode → in memory, for development and tests.
 *  - otherwise → every sync request answers 503, while the web app and the
 *    rest of the API keep working.
 *
 * The Postgres driver is imported lazily, so local mode never loads it, and a
 * database that is down surfaces as an error on a request rather than a crash
 * at boot that takes the health endpoint down with it.
 */
export function createStore(config: Config): Store {
  if (config.databaseUrl) return new LazyPostgresStore(config.databaseUrl);
  if (config.mode === 'local') return new MemoryStore();
  return new UnavailableStore();
}

class LazyPostgresStore implements Store {
  private delegate: Promise<Store> | null = null;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private resolve(): Promise<Store> {
    this.delegate ??= Promise.all([import('pg'), import('./postgres.ts')]).then(
      ([{ default: pg }, { PostgresStore }]) => {
        const pool = new pg.Pool({ connectionString: this.url, max: 5 });
        // An idle client losing its connection must not crash the process.
        pool.on('error', (error) => console.error('[fluentflow] postgres pool error', error));
        return new PostgresStore({
          query: (text, params) => pool.query(text, params as unknown[]) as never,
          exec: async (text) => {
            await pool.query(text);
          },
          async transaction(task) {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              const result = await task({
                query: (text, params) => client.query(text, params as unknown[]) as never,
              });
              await client.query('COMMIT');
              return result;
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined);
              throw error;
            } finally {
              client.release();
            }
          },
          close: () => pool.end(),
        });
      },
    );
    return this.delegate;
  }

  async getEpoch(...args: Parameters<Store['getEpoch']>) {
    return (await this.resolve()).getEpoch(...args);
  }

  async seed(...args: Parameters<Store['seed']>) {
    return (await this.resolve()).seed(...args);
  }

  async push(...args: Parameters<Store['push']>) {
    return (await this.resolve()).push(...args);
  }

  async pull(...args: Parameters<Store['pull']>) {
    return (await this.resolve()).pull(...args);
  }

  async close() {
    if (!this.delegate) return;
    return (await this.delegate).close();
  }
}

class UnavailableStore implements Store {
  async getEpoch(): Promise<never> {
    throw new StoreUnavailableError();
  }
  async seed(): Promise<never> {
    throw new StoreUnavailableError();
  }
  async push(): Promise<never> {
    throw new StoreUnavailableError();
  }
  async pull(): Promise<never> {
    throw new StoreUnavailableError();
  }
  async close(): Promise<void> {}
}
