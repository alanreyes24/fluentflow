import { cert, getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type DocumentReference } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import type { Card, Deck } from '@fluentflow/core';
import { resolveConflict } from '@fluentflow/core';
import type { Config } from '../config.ts';
import type { Store } from './types.ts';

/**
 * Firestore-backed store.
 *
 * Layout is `users/{uid}/decks/{deckId}` and `users/{uid}/cards/{cardId}`. The
 * per-user subcollection is what makes the security rules a one-liner and what
 * lets the client attach a real-time listener scoped to exactly the documents
 * it is allowed to see.
 */

/** Firestore refuses batches larger than this. */
const MAX_BATCH_WRITES = 500;
/** `getAll` is happiest well under the batch limit. */
const MAX_READ_CHUNK = 250;

export class FirestoreStore implements Store {
  private readonly db: Firestore;

  constructor(config: Config) {
    this.db = getFirestore(initialiseApp(config));
    this.db.settings({ ignoreUndefinedProperties: true });
  }

  async listDecks(userId: string, since?: string): Promise<Deck[]> {
    return this.list<Deck>(userId, 'decks', since);
  }

  async listCards(userId: string, since?: string): Promise<Card[]> {
    return this.list<Card>(userId, 'cards', since);
  }

  async putDecks(userId: string, decks: Deck[]): Promise<void> {
    await this.put(userId, 'decks', decks);
  }

  async putCards(userId: string, cards: Card[]): Promise<void> {
    await this.put(userId, 'cards', cards);
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }

  private async list<T>(userId: string, name: string, since?: string): Promise<T[]> {
    const collection = this.db.collection(`users/${userId}/${name}`);
    // An incremental pull asks only for what changed, which keeps app launch
    // cheap once a collection has grown past a few thousand cards.
    const query = since ? collection.where('lastModified', '>', since) : collection;
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as T);
  }

  private async put<T extends { id: string; lastModified: string }>(
    userId: string,
    name: string,
    records: T[],
  ): Promise<void> {
    if (records.length === 0) return;

    const collection = this.db.collection(`users/${userId}/${name}`);
    const deduped = dedupeById(records);
    const winners = await this.resolveAgainstStored(collection, deduped);

    for (const chunk of chunks(winners, MAX_BATCH_WRITES)) {
      const batch = this.db.batch();
      for (const record of chunk) {
        batch.set(collection.doc(record.id), record);
      }
      await batch.commit();
    }
  }

  /**
   * Drop any incoming record that is older than what is already stored.
   *
   * Without this, a client retrying an upload it thought had failed could
   * overwrite a newer review that arrived from another device in between.
   */
  private async resolveAgainstStored<T extends { id: string; lastModified: string }>(
    collection: FirebaseFirestore.CollectionReference,
    records: T[],
  ): Promise<T[]> {
    const winners: T[] = [];

    for (const chunk of chunks(records, MAX_READ_CHUNK)) {
      const refs: DocumentReference[] = chunk.map((record) => collection.doc(record.id));
      const snapshots = await this.db.getAll(...refs);

      chunk.forEach((record, index) => {
        const stored = snapshots[index]?.data() as T | undefined;
        if (!stored) {
          winners.push(record);
          return;
        }
        const resolution = resolveConflict(record, stored);
        if (resolution.winner === 'local') winners.push(resolution.record);
      });
    }

    return winners;
  }
}

function initialiseApp(config: Config): App {
  const existing = getApps()[0];
  if (existing) return existing;

  if (config.credentialsPath) {
    const serviceAccount = JSON.parse(readFileSync(config.credentialsPath, 'utf8'));
    return initializeApp({ credential: cert(serviceAccount), projectId: config.projectId });
  }
  // The emulator needs no credential; on Cloud Run the metadata server supplies one.
  if (config.emulatorHost) {
    return initializeApp({ projectId: config.projectId });
  }
  return initializeApp({ credential: applicationDefault(), projectId: config.projectId });
}

function dedupeById<T extends { id: string; lastModified: string }>(records: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing ? resolveConflict(record, existing).record : record);
  }
  return [...byId.values()];
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
