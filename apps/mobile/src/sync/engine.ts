import {
  planMerge,
  recomputeCardCounts,
  type Card,
  type Deck,
} from '@fluentflow/core';
import type { Repository } from '../db/repository';
import { fetchRemote, pushRemote, subscribeRemote, type RemoteSnapshot } from '../firebase/client';

/**
 * The sync engine.
 *
 * Shape of the thing: SQLite is authoritative locally, Firestore is a replica,
 * and `planMerge` from core decides who wins per record. The engine's job is
 * only sequencing and failure handling.
 *
 * Three details do most of the work:
 *
 *  1. **Push before pull.** Uploading first means the pull that follows already
 *     contains our own writes, so a device that has been offline converges in
 *     one cycle instead of two.
 *  2. **One cycle at a time.** Sync is triggered by app launch, by the network
 *     coming back, by a Firestore snapshot and by a manual tap. Overlapping
 *     cycles would interleave reads and writes and could mark a record synced
 *     that was never sent, so a running cycle is coalesced into a single
 *     pending re-run.
 *  3. **`markSynced` is conditional.** It only clears the pending flag if
 *     `lastModified` still matches what was uploaded, so a review made during
 *     the round trip stays queued.
 */

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
}

export interface SyncEngineOptions {
  repository: Repository;
  userId: string;
  /** False when Firebase is unconfigured or the user is not signed in. */
  cloudEnabled: boolean;
  onStatus: (status: SyncStatus) => void;
}

export class SyncEngine {
  private readonly repository: Repository;
  private readonly userId: string;
  private readonly cloudEnabled: boolean;
  private readonly onStatus: (status: SyncStatus) => void;

  private status: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null };
  private running = false;
  /** Set when a trigger arrives mid-cycle; drives exactly one re-run. */
  private rerunRequested = false;
  private online = true;
  private unsubscribe: (() => void) | null = null;
  private remoteSubscriptionReady = false;
  private disposed = false;

  constructor(options: SyncEngineOptions) {
    this.repository = options.repository;
    this.userId = options.userId;
    this.cloudEnabled = options.cloudEnabled;
    this.onStatus = options.onStatus;
  }

  async start(): Promise<void> {
    await this.refreshPendingCount();
    if (!this.cloudEnabled) {
      this.emit({ state: 'idle' });
      return;
    }

    const meta = await this.repository.getSyncMeta(this.userId);
    this.status.lastSyncedAt = meta.lastPulledAt ?? null;

    const subscription = subscribeRemote(
      this.userId,
      (snapshot) => this.applyRemoteSnapshot(snapshot),
      (error) => {
        this.remoteSubscriptionReady = false;
        this.emit({ state: 'error', error: error.message });
      },
    );
    this.unsubscribe = subscription.unsubscribe;
    this.remoteSubscriptionReady = await subscription.ready;

    await this.sync();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.remoteSubscriptionReady = false;
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

  /** Run a full push-then-pull cycle. Safe to call from anywhere, any time. */
  async sync(): Promise<SyncStatus> {
    if (!this.cloudEnabled) {
      await this.refreshPendingCount();
      return this.emit({ state: 'idle' });
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
    this.emit({ state: 'syncing', error: null });

    try {
      do {
        this.rerunRequested = false;
        await this.push();
        // The live listeners deliver both remote changes and our own writes.
        // A pull is only needed when listeners are unavailable; otherwise an
        // idle/manual sync would re-read the same collections unnecessarily.
        if (!this.remoteSubscriptionReady) await this.pull();
      } while (this.rerunRequested && !this.disposed);

      const now = new Date().toISOString();
      await this.repository.setSyncMeta(this.userId, { lastPulledAt: now, lastPushedAt: now });
      await this.refreshPendingCount();
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

  private async push(): Promise<void> {
    const [decks, cards] = await Promise.all([
      this.repository.pendingDecks(this.userId),
      this.repository.pendingCards(this.userId),
    ]);
    const reviewEvents = await this.repository.pendingReviewEvents(this.userId);
    if (decks.length === 0 && cards.length === 0 && reviewEvents.length === 0) return;

    await pushRemote(this.userId, decks, cards, reviewEvents);
    await this.repository.markSynced(decks, cards, reviewEvents);
  }

  private async pull(): Promise<void> {
    // A full pull on first sync, incremental afterwards. `since` comes from the
    // last *successful* cycle, so an interrupted sync re-reads rather than
    // skipping a window.
    const meta = await this.repository.getSyncMeta(this.userId);
    const remote = await fetchRemote(this.userId, meta.lastPulledAt);
    await this.merge(remote);
  }

  private async applyRemoteSnapshot(snapshot: RemoteSnapshot): Promise<void> {
    if (this.disposed) return;
    try {
      await this.merge(snapshot);
      await this.refreshPendingCount();
      // A snapshot can reveal local records the server has never seen, so nudge
      // a cycle rather than assuming the listener is the whole story.
      if (this.status.pending > 0) void this.sync();
    } catch (error) {
      this.emit({
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Reconcile a remote snapshot against local state and write the winners. */
  private async merge(remote: RemoteSnapshot): Promise<void> {
    if (
      remote.decks.length === 0 &&
      remote.cards.length === 0 &&
      remote.reviewEvents.length === 0
    ) return;

    const [localDecks, localCards, localReviewEvents] = await Promise.all([
      this.repository.listDecks(this.userId),
      this.repository.listAllCards(this.userId),
      this.repository.listReviewEvents(this.userId),
    ]);

    const deckPlan = planMerge<Deck>(localDecks, remote.decks.filter(ownedBy(this.userId)));
    const cardPlan = planMerge<Card>(localCards, remote.cards.filter(ownedBy(this.userId)));
    const remoteReviewEvents = remote.reviewEvents.filter(ownedBy(this.userId));
    const localReviewEventIds = new Set(localReviewEvents.map((event) => event.eventId));
    const reviewEventsToApply = remoteReviewEvents.filter(
      (event) => !localReviewEventIds.has(event.eventId),
    );
    const localReviewEventIdsOnRemote = new Set(remoteReviewEvents.map((event) => event.eventId));
    const reviewEventsToPush = localReviewEvents.filter(
      (event) => !localReviewEventIdsOnRemote.has(event.eventId),
    );

    if (
      deckPlan.applyLocally.length > 0 ||
      cardPlan.applyLocally.length > 0 ||
      reviewEventsToApply.length > 0
    ) {
      await this.repository.applyRemote(
        recomputeCardCounts(deckPlan.applyLocally, cardPlan.merged),
        cardPlan.applyLocally,
        reviewEventsToApply,
      );
    }

    // Records where the local copy won are queued rather than pushed inline:
    // the next cycle's push picks them up, and that keeps one code path
    // responsible for uploads.
    if (
      deckPlan.pushRemote.length > 0 ||
      cardPlan.pushRemote.length > 0 ||
      reviewEventsToPush.length > 0
    ) {
      this.rerunRequested = true;
    }
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

/**
 * Defence in depth. Firestore rules already scope reads to the signed-in user,
 * but a mis-scoped listener would otherwise write another account's cards into
 * this device's database.
 */
function ownedBy(userId: string) {
  return (record: { userId?: string }) => !record.userId || record.userId === userId;
}

function isNetworkError(message: string): boolean {
  return /network|offline|unavailable|failed to fetch|timeout|ETIMEDOUT|ENOTFOUND/i.test(message);
}
