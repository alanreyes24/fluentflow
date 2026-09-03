import type { Config } from '../config.ts';
import { MemoryStore } from './memory.ts';
import type { Store } from './types.ts';

export type { Store } from './types.ts';
export { MemoryStore } from './memory.ts';

/**
 * Pick a store for the active mode. The Firestore implementation is imported
 * lazily so that local mode never loads `firebase-admin` — it is a heavy
 * dependency that expects credentials to exist.
 */
export function createStore(config: Config): Store {
  if (config.mode === 'local') return new MemoryStore();
  return new LazyFirestoreStore(config);
}

/**
 * Defers construction of the Firestore client to the first request, so a
 * misconfigured credential surfaces as a 500 on one request rather than a crash
 * at boot that takes the health endpoint down with it.
 */
class LazyFirestoreStore implements Store {
  private delegate: Promise<Store> | null = null;

  constructor(private readonly config: Config) {}

  private resolve(): Promise<Store> {
    this.delegate ??= import('./firestore.ts').then(
      ({ FirestoreStore }) => new FirestoreStore(this.config),
    );
    return this.delegate;
  }

  async listDecks(userId: string, since?: string) {
    return (await this.resolve()).listDecks(userId, since);
  }

  async listCards(userId: string, since?: string) {
    return (await this.resolve()).listCards(userId, since);
  }

  async putDecks(userId: string, decks: Parameters<Store['putDecks']>[1]) {
    return (await this.resolve()).putDecks(userId, decks);
  }

  async putCards(userId: string, cards: Parameters<Store['putCards']>[1]) {
    return (await this.resolve()).putCards(userId, cards);
  }

  async close() {
    if (!this.delegate) return;
    return (await this.delegate).close();
  }
}
