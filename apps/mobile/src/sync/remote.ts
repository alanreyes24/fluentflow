import { normalizeCard, type Card, type Deck, type ReviewEvent } from '@fluentflow/core';
import { appConfig } from '../firebase/config';
import { authApi } from '../firebase/client';
import { desktopBridge } from '../desktop';

/**
 * HTTP client for the sync API (apps/server, hosted on Railway).
 *
 * The server's Postgres database is the single source of truth for decks,
 * cards and review history. Firebase is used only to say who is signing in:
 * every request carries the user's Firebase ID token, and the server derives
 * the account from it.
 */

export interface SyncRecords {
  decks: Deck[];
  cards: Card[];
  reviewEvents: ReviewEvent[];
}

export interface SyncChanges extends SyncRecords {
  cursor: string;
}

export interface PushResult {
  rejected: { decks: Deck[]; cards: Card[] };
}

/** The server's collection was seeded with a different epoch (or not at all). */
export class EpochMismatchError extends Error {
  readonly epoch: string | null;
  constructor(epoch: string | null) {
    super(epoch ? 'This device is out of date with the server.' : 'Nothing has been uploaded yet.');
    this.name = 'EpochMismatchError';
    this.epoch = epoch;
  }
}

export interface SyncRemote {
  state(): Promise<{ epoch: string | null }>;
  seed(records: SyncRecords, replaceEpoch?: string | null): Promise<{ epoch: string; cursor: string }>;
  push(epoch: string, records: SyncRecords): Promise<PushResult>;
  pull(epoch: string, since?: string): Promise<SyncChanges>;
}

/**
 * Where the sync API lives, or null when this build has none.
 *
 * Inside the desktop shell the page is served from `app://fluentflow`, so it
 * asks the shell which hosted app it keeps its bundle in step with — the same
 * server the browser and the phone talk to. Everywhere else the build says.
 */
export async function syncBaseUrl(): Promise<string | null> {
  const bridge = desktopBridge();
  if (bridge?.webBundle) {
    try {
      const { source } = await bridge.webBundle.status();
      if (source) return source.replace(/\/+$/, '');
    } catch {
      // Fall through to the build's own setting.
    }
  }
  return appConfig.syncBaseUrl;
}

/**
 * Pushes are sent in slices so a large import never meets the server's
 * per-request cap (and one failed request does not resend everything).
 */
export const PUSH_BATCH = 1000;

export function createSyncRemote(baseUrl: string): SyncRemote {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await authApi()?.idToken();
    if (!token) throw new Error('Sign in to sync.');
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (response.ok) return (await response.json()) as T;

    const body = (await response.json().catch(() => null)) as
      | { error?: string; message?: string; epoch?: string | null }
      | null;
    if (response.status === 409 && body?.error === 'epoch_mismatch') {
      throw new EpochMismatchError(body.epoch ?? null);
    }
    throw new Error(body?.message ?? `Sync failed (HTTP ${response.status}).`);
  }

  return {
    state: () => request('/api/sync/state'),

    seed: (records, replaceEpoch = null) =>
      request('/api/sync/seed', {
        method: 'POST',
        body: JSON.stringify({ ...toWire(records), replaceEpoch }),
      }),

    async push(epoch, records) {
      const rejected: PushResult['rejected'] = { decks: [], cards: [] };
      // Decks first, so a pulled card never arrives on another device before
      // the deck it belongs to.
      const slices = [
        ...slice(records.decks).map((decks) => ({ decks, cards: [], reviewEvents: [] })),
        ...slice(records.cards).map((cards) => ({ decks: [], cards, reviewEvents: [] })),
        ...slice(records.reviewEvents).map((reviewEvents) => ({ decks: [], cards: [], reviewEvents })),
      ];
      for (const part of slices) {
        const result = await request<PushResult>('/api/sync/push', {
          method: 'POST',
          body: JSON.stringify({ epoch, ...toWire(part) }),
        });
        rejected.decks.push(...result.rejected.decks);
        rejected.cards.push(...result.rejected.cards.map(normalizeCard));
      }
      return { rejected };
    },

    async pull(epoch, since) {
      const query = new URLSearchParams({ epoch, ...(since ? { since } : {}) });
      const changes = await request<SyncChanges>(`/api/sync/pull?${query}`);
      return { ...changes, cards: changes.cards.map(normalizeCard) };
    },
  };
}

function slice<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PUSH_BATCH) out.push(items.slice(i, i + PUSH_BATCH));
  return out;
}

/** `syncStatus` is this device's upload queue; the server has no use for it. */
function toWire(records: SyncRecords): SyncRecords {
  const strip = <T extends { syncStatus?: string }>(record: T) => ({ ...record, syncStatus: 'synced' as const });
  return {
    decks: records.decks.map(strip),
    cards: records.cards.map(strip),
    reviewEvents: records.reviewEvents.map(strip),
  };
}
