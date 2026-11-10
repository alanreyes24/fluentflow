import type { Repository } from '../db/repository';
import { EpochMismatchError, type SyncRemote } from './remote';

/**
 * The sync engine.
 *
 * The sync server's database is the single source of truth. This device keeps
 * a working copy in SQLite so studying never waits on the network, and the
 * engine's job is to keep that copy equal to the server's:
 *
 *  1. **Adopt the server's collection.** The first time a device meets the
 *     server (or after the collection was re-seeded), it throws its own copy
 *     away and downloads the server's. Only a device allowed to seed — the
 *     desktop app — uploads its copy instead, and only when the server has
 *     nothing yet.
 *  2. **Push, then pull.** Local changes are queued (`syncStatus = 'pending'`)
 *     and pushed; the server keeps the newer of its copy and ours and hands
 *     back its copy when ours lost. Then everything that changed on the server
 *     since the last pull is applied over the local copy.
 *  3. **One cycle at a time.** Triggers overlap — launch, a review, the app
 *     coming back to the foreground, the poll — so a running cycle coalesces
 *     them into a single re-run. `markSynced` is conditional on
 *     `lastModified`, so a review made during the round trip stays queued.
 */

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'waiting';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
}

export interface SyncEngineOptions {
  repository: Repository;
  userId: string;
  /** False when sign-in is unconfigured or the user is not signed in. */
  cloudEnabled: boolean;
  /** Resolves the sync server for this build, or null when it has none. */
  remote: () => Promise<SyncRemote | null>;
  /**
   * Whether this device may create the server's collection from its own copy
   * when the server has none. Every other device waits for it.
   */
  canSeed: boolean;
  onStatus: (status: SyncStatus) => void;
  /** Called after server cards have been written locally. */
  onRemoteCardsApplied?: () => Promise<void> | void;
  /** How often to look for local changes to push. */
  pushIntervalMs?: number;
  /** How often to pull when nothing local has changed. */
  pullIntervalMs?: number;
}

const DEFAULT_PUSH_INTERVAL_MS = 3_000;
const DEFAULT_PULL_INTERVAL_MS = 30_000;

export class SyncEngine {
  private readonly repository: Repository;
  private readonly userId: string;
  private readonly cloudEnabled: boolean;
  private readonly resolveRemote: () => Promise<SyncRemote | null>;
  private readonly canSeed: boolean;
  private readonly onStatus: (status: SyncStatus) => void;
  private readonly onRemoteCardsApplied?: () => Promise<void> | void;
  private readonly pushIntervalMs: number;
  private readonly pullIntervalMs: number;

  private remote: SyncRemote | null = null;
  private status: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null };
  private running = false;
  /** Set when a trigger arrives mid-cycle; drives exactly one re-run. */
  private rerunRequested = false;
  private online = true;
  private disposed = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastCycleAt = 0;

  constructor(options: SyncEngineOptions) {
    this.repository = options.repository;
    this.userId = options.userId;
    this.cloudEnabled = options.cloudEnabled;
    this.resolveRemote = options.remote;
    this.canSeed = options.canSeed;
    this.onStatus = options.onStatus;
    this.onRemoteCardsApplied = options.onRemoteCardsApplied;
    this.pushIntervalMs = options.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
    this.pullIntervalMs = options.pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    await this.refreshPendingCount();
    if (!this.cloudEnabled) {
      this.emit({ state: 'idle' });
      return;
    }

    this.remote = await this.resolveRemote();
    if (this.disposed) return;
    if (!this.remote) {
      this.emit({ state: 'error', error: 'This build has no sync server configured.' });
      return;
    }

    const meta = await this.repository.getSyncMeta(this.userId);
    this.status.lastSyncedAt = meta.lastPulledAt ?? null;

    this.timers.push(
      setInterval(() => void this.tick(), this.pushIntervalMs),
    );
    await this.sync();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  setOnline(online: boolean): void {
    const wasOffline = !this.online;
    this.online = online;
    if (!online) {
      this.emit({ state: 'offline' });
      return;
    }
    // Coming back from offline is the most valuable moment to sync.
    if (wasOffline) void this.sync();
  }

  /** Run a full cycle. Safe to call from anywhere, any time. */
  async sync(): Promise<SyncStatus> {
    if (!this.cloudEnabled || !this.remote) {
      await this.refreshPendingCount();
      return this.status;
    }
    if (!this.online) {
      await this.refreshPendingCount();
      return this.emit({ state: 'offline' });
    }
    if (this.running) {
      this.rerunRequested = true;
      return this.status;
    }

    this.running = true;
    this.lastCycleAt = Date.now();
    if (this.status.state !== 'waiting') this.emit({ state: 'syncing', error: null });

    try {
      let waiting = false;
      do {
        this.rerunRequested = false;
        const outcome = await this.cycle(this.remote);
        waiting = outcome.waiting;
        if (outcome.cardsApplied) await this.onRemoteCardsApplied?.();
      } while (this.rerunRequested && !this.disposed);

      await this.refreshPendingCount();
      if (waiting) return this.emit({ state: 'waiting', error: null });
      const now = new Date().toISOString();
      await this.repository.setSyncMeta(this.userId, { lastPulledAt: now, lastPushedAt: now });
      return this.emit({ state: 'idle', lastSyncedAt: now, error: null });
    } catch (error) {
      await this.refreshPendingCount();
      const message = error instanceof Error ? error.message : String(error);
      // A network failure is not an error state the user needs to act on; it is
      // the normal offline case arriving through a different door.
      return this.emit({
        state: isNetworkError(message) ? 'offline' : 'error',
        error: isNetworkError(message) ? null : message,
      });
    } finally {
      this.running = false;
    }
  }

  /** The poll: push promptly when something changed, pull now and then. */
  private async tick(): Promise<void> {
    if (this.disposed || this.running) return;
    await this.refreshPendingCount();
    const due = Date.now() - this.lastCycleAt >= this.pullIntervalMs;
    if (this.status.pending > 0 || due) await this.sync();
  }

  private async cycle(remote: SyncRemote): Promise<{ cardsApplied: boolean; waiting: boolean }> {
    const meta = await this.repository.getSyncMeta(this.userId);
    try {
      if (meta.epoch) return await this.exchange(remote, meta.epoch, meta.cursor);
      return await this.adopt(remote, (await remote.state()).epoch);
    } catch (error) {
      // The server's collection is not the one this copy was built from.
      if (error instanceof EpochMismatchError) return this.adopt(remote, error.epoch);
      throw error;
    }
  }

  /** Push local changes, then pull the server's. */
  private async exchange(
    remote: SyncRemote,
    epoch: string,
    cursor: string | undefined,
  ): Promise<{ cardsApplied: boolean; waiting: boolean }> {
    const [decks, cards, reviewEvents] = await Promise.all([
      this.repository.pendingDecks(this.userId),
      this.repository.pendingCards(this.userId),
      this.repository.pendingReviewEvents(this.userId),
    ]);
    let cardsApplied = 0;
    if (decks.length + cards.length + reviewEvents.length > 0) {
      const { rejected } = await remote.push(epoch, { decks, cards, reviewEvents });
      await this.repository.markSynced(decks, cards, reviewEvents);
      // The server kept a newer copy than ours: take it.
      if (rejected.decks.length + rejected.cards.length > 0) {
        const applied = await this.repository.applyServerChanges(this.userId, {
          ...rejected,
          reviewEvents: [],
        });
        cardsApplied += applied.cardsApplied;
      }
    }

    const changes = await remote.pull(epoch, cursor);
    if (changes.decks.length + changes.cards.length + changes.reviewEvents.length > 0) {
      const applied = await this.repository.applyServerChanges(this.userId, changes);
      cardsApplied += applied.cardsApplied;
    }
    await this.repository.setSyncMeta(this.userId, { cursor: changes.cursor });
    return { cardsApplied: cardsApplied > 0, waiting: false };
  }

  /** Bring this device onto the server's collection, or create it. */
  private async adopt(
    remote: SyncRemote,
    serverEpoch: string | null,
  ): Promise<{ cardsApplied: boolean; waiting: boolean }> {
    if (serverEpoch === null) {
      if (!this.canSeed) return { cardsApplied: false, waiting: true };
      const records = await this.repository.collectionForUpload(this.userId);
      const seeded = await remote.seed(records);
      await this.repository.markSynced(records.decks, records.cards, records.reviewEvents);
      await this.repository.setSyncMeta(this.userId, { epoch: seeded.epoch, cursor: seeded.cursor });
      // Anything changed during the upload is still pending; send it now.
      this.rerunRequested = true;
      return { cardsApplied: false, waiting: false };
    }

    const everything = await remote.pull(serverEpoch);
    await this.repository.replaceWithServerCopy(this.userId, everything);
    await this.repository.setSyncMeta(this.userId, { epoch: serverEpoch, cursor: everything.cursor });
    return { cardsApplied: true, waiting: false };
  }

  private async refreshPendingCount(): Promise<void> {
    this.status.pending = await this.repository.countPending(this.userId);
  }

  private emit(patch: Partial<SyncStatus>): SyncStatus {
    this.status = { ...this.status, ...patch };
    if (!this.disposed) this.onStatus(this.status);
    return this.status;
  }
}

function isNetworkError(message: string): boolean {
  return /network|offline|unavailable|failed to fetch|load failed|timeout|ETIMEDOUT|ENOTFOUND/i.test(message);
}
