import { resolveConflict, type Card, type Deck, type ReviewEvent } from '@fluentflow/core';
import { SyncEngine, type SyncStatus } from '../src/sync/engine';
import { EpochMismatchError, type SyncRecords, type SyncRemote } from '../src/sync/remote';
import type { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';

/**
 * The sync engine against a real SQLite repository and a fake server that
 * follows the same rules as apps/server: one epoch per collection, a version
 * cursor, and last-write-wins that hands back the server's copy when it wins.
 */

class FakeServer {
  epoch: string | null = null;
  version = 0;
  seeds = 0;
  decks = new Map<string, { record: Deck; version: number }>();
  cards = new Map<string, { record: Card; version: number }>();
  events = new Map<string, { record: ReviewEvent; version: number }>();

  reseed(records: SyncRecords): string {
    this.seeds++;
    this.epoch = `epoch-${this.seeds}`;
    this.version++;
    this.decks.clear();
    this.cards.clear();
    this.events.clear();
    for (const d of records.decks) this.decks.set(d.id, { record: synced(d), version: this.version });
    for (const c of records.cards) this.cards.set(c.id, { record: synced(c), version: this.version });
    for (const e of records.reviewEvents) this.events.set(e.eventId, { record: synced(e), version: this.version });
    return this.epoch;
  }

  /** Another device's change, written straight to the server. */
  write(card: Card): void {
    this.version++;
    this.cards.set(card.id, { record: synced(card), version: this.version });
  }

  remote(): SyncRemote {
    const check = (epoch: string) => {
      if (epoch !== this.epoch) throw new EpochMismatchError(this.epoch);
    };
    return {
      state: async () => ({ epoch: this.epoch }),
      seed: async (records, replaceEpoch = null) => {
        if (replaceEpoch !== this.epoch) throw new EpochMismatchError(this.epoch);
        return { epoch: this.reseed(records), cursor: String(this.version) };
      },
      push: async (epoch, records) => {
        check(epoch);
        const version = this.version + 1;
        const rejected = { decks: [] as Deck[], cards: [] as Card[] };
        const upsert = <T extends Deck | Card>(
          map: Map<string, { record: T; version: number }>,
          incoming: T[],
          lost: T[],
        ) => {
          for (const record of incoming) {
            const existing = map.get(record.id);
            if (existing) {
              const resolution = resolveConflict(synced(record), existing.record);
              if (resolution.winner === 'remote') {
                if (resolution.conflicted) lost.push(existing.record);
                continue;
              }
            }
            map.set(record.id, { record: synced(record), version });
          }
        };
        upsert(this.decks, records.decks, rejected.decks);
        upsert(this.cards, records.cards, rejected.cards);
        for (const e of records.reviewEvents) {
          if (!this.events.has(e.eventId)) this.events.set(e.eventId, { record: synced(e), version });
        }
        this.version = version;
        return { rejected };
      },
      pull: async (epoch, since) => {
        check(epoch);
        const after = Number(since ?? 0);
        const newer = <T>(map: Map<string, { record: T; version: number }>) =>
          [...map.values()].filter((entry) => entry.version > after).map((entry) => entry.record);
        return {
          decks: newer(this.decks),
          cards: newer(this.cards),
          reviewEvents: newer(this.events),
          cursor: String(this.version),
        };
      },
    };
  }
}

function synced<T extends { syncStatus?: string }>(record: T): T {
  return { ...record, syncStatus: 'synced' };
}

const USER = 'u1';

async function setup(server: FakeServer, canSeed: boolean) {
  const { repository, close } = await createTestRepository();
  const statuses: SyncStatus[] = [];
  const engine = new SyncEngine({
    repository,
    userId: USER,
    cloudEnabled: true,
    remote: async () => server.remote(),
    canSeed,
    onStatus: (status) => statuses.push(status),
    pushIntervalMs: 60_000_000,
  });
  return {
    repository,
    engine,
    statuses,
    close: async () => {
      engine.dispose();
      await close();
    },
  };
}

async function studied(repository: Repository) {
  const deck = await repository.createDeck(USER, 'Spanish', 'es');
  const hablar = await repository.addCard(USER, deck, 'hablar', 'to speak');
  const comer = await repository.addCard(USER, deck, 'comer', 'to eat');
  const reviewed = await repository.rateCard(hablar, 'good');
  return { deck, hablar: reviewed, comer };
}

describe('sync engine', () => {
  it('a device that may not seed waits for the desktop app, and uploads nothing', async () => {
    const server = new FakeServer();
    const device = await setup(server, false);
    try {
      await studied(device.repository);
      await device.engine.start();
      expect(device.statuses.at(-1)?.state).toBe('waiting');
      expect(server.epoch).toBeNull();
      expect(device.statuses.at(-1)?.pending).toBeGreaterThan(0);
    } finally {
      await device.close();
    }
  });

  it('the desktop app seeds the server with everything it has', async () => {
    const server = new FakeServer();
    const desktop = await setup(server, true);
    try {
      const { hablar } = await studied(desktop.repository);
      await desktop.engine.start();

      expect(server.epoch).toBe('epoch-1');
      expect(server.cards.size).toBe(2);
      expect(server.cards.get(hablar.id)?.record.repetitions).toBe(1);
      expect(server.events.size).toBe(1);
      expect(desktop.statuses.at(-1)).toMatchObject({ state: 'idle', pending: 0 });
      expect((await desktop.repository.getSyncMeta(USER)).epoch).toBe('epoch-1');
    } finally {
      await desktop.close();
    }
  });

  it('another device throws its own copy away and takes the server copy', async () => {
    const server = new FakeServer();
    const desktop = await setup(server, true);
    const phone = await setup(server, false);
    try {
      const { hablar } = await studied(desktop.repository);
      await desktop.engine.start();

      // The phone has its own, different history — including unsent work.
      const phoneDeck = await phone.repository.createDeck(USER, 'Phone only', 'es');
      await phone.repository.addCard(USER, phoneDeck, 'dormir', 'to sleep');
      await phone.engine.start();

      const cards = await phone.repository.listAllCards(USER);
      expect(cards.map((c) => c.front).sort()).toEqual(['comer', 'hablar']);
      expect(cards.find((c) => c.id === hablar.id)?.repetitions).toBe(1);
      expect((await phone.repository.listDecks(USER)).map((d) => d.name)).toEqual(['Spanish']);
      expect(await phone.repository.listReviewEvents(USER)).toHaveLength(1);
      expect(phone.statuses.at(-1)).toMatchObject({ state: 'idle', pending: 0 });
      expect(server.cards.size).toBe(2);
    } finally {
      await desktop.close();
      await phone.close();
    }
  });

  it('a review on one device reaches the other through the server', async () => {
    const server = new FakeServer();
    const desktop = await setup(server, true);
    const phone = await setup(server, false);
    try {
      const { comer } = await studied(desktop.repository);
      await desktop.engine.start();
      await phone.engine.start();

      const onPhone = (await phone.repository.getCard(comer.id))!;
      await phone.repository.rateCard(onPhone, 'easy');
      await phone.engine.sync();
      expect(server.cards.get(comer.id)?.record.repetitions).toBe(1);

      await desktop.engine.sync();
      expect((await desktop.repository.getCard(comer.id))?.repetitions).toBe(1);
      expect(await desktop.repository.listReviewEvents(USER)).toHaveLength(2);
    } finally {
      await desktop.close();
      await phone.close();
    }
  });

  it('when the server copy is newer, the device takes it instead of keeping its own', async () => {
    const server = new FakeServer();
    const desktop = await setup(server, true);
    try {
      const { comer } = await studied(desktop.repository);
      await desktop.engine.start();

      // Another device's later edit is on the server; ours is older.
      server.write({ ...comer, back: 'to eat (server)', lastModified: '2999-01-01T00:00:00.000Z' });
      await desktop.repository.updateCard((await desktop.repository.getCard(comer.id))!, {
        back: 'to eat (local)',
      });
      await desktop.engine.sync();

      expect((await desktop.repository.getCard(comer.id))?.back).toBe('to eat (server)');
      expect(desktop.statuses.at(-1)?.pending).toBe(0);
    } finally {
      await desktop.close();
    }
  });

  it('a pending local change is not overwritten by a pull before it is pushed', async () => {
    const server = new FakeServer();
    const desktop = await setup(server, true);
    try {
      const { comer } = await studied(desktop.repository);
      await desktop.engine.start();
      const local = await desktop.repository.updateCard(
        (await desktop.repository.getCard(comer.id))!,
        { back: 'mine' },
      );

      await desktop.repository.applyServerChanges(USER, {
        decks: [],
        cards: [{ ...comer, back: 'stale', syncStatus: 'synced' }],
        reviewEvents: [],
      });
      expect((await desktop.repository.getCard(comer.id))?.back).toBe('mine');
      expect((await desktop.repository.getCard(comer.id))?.lastModified).toBe(local.lastModified);
    } finally {
      await desktop.close();
    }
  });

  it('a device on an old epoch adopts the re-seeded collection', async () => {
    const server = new FakeServer();
    const phone = await setup(server, false);
    try {
      server.reseed({ decks: [], cards: [], reviewEvents: [] });
      await phone.engine.start();
      expect((await phone.repository.getSyncMeta(USER)).epoch).toBe('epoch-1');

      const deck = await phone.repository.createDeck(USER, 'Old', 'es');
      server.reseed({ decks: [{ ...deck, name: 'New' }], cards: [], reviewEvents: [] });
      await phone.engine.sync();

      expect((await phone.repository.getSyncMeta(USER)).epoch).toBe('epoch-2');
      expect((await phone.repository.listDecks(USER)).map((d) => d.name)).toEqual(['New']);
    } finally {
      await phone.close();
    }
  });
});
