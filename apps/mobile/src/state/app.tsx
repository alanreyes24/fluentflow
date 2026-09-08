import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';
import type { Deck } from '@fluentflow/core';
import { DATABASE_NAME, migrate } from '../db/schema';
import { Repository } from '../db/repository';
import { normalizeExistingCards } from '../ai/card-fronts';
import { ExampleService } from '../ai/service';
import { SyncEngine, type SyncStatus } from '../sync/engine';
import { authApi, type AuthApi } from '../firebase/client';
import { LOCAL_USER_ID, isCloudEnabled } from '../firebase/config';

/**
 * The single application provider.
 *
 * It owns the four things that have to outlive any screen — the database, the
 * signed-in identity, the sync engine and the example service — and it owns the
 * ordering between them, which matters:
 *
 *  1. The database opens and migrates before anything reads it.
 *  2. Auth resolves before a sync engine is created, because the engine is
 *     scoped to a user id.
 *  3. Signing in re-homes anything studied anonymously onto the real account,
 *     so nothing done before signing in is stranded.
 */

export type AuthUser = { id: string; email: string | null; anonymous: boolean };

export interface AppState {
  ready: boolean;
  error: string | null;
  repository: Repository | null;
  examples: ExampleService | null;
  user: AuthUser | null;
  cloudAvailable: boolean;
  sync: SyncStatus;
  decks: Deck[];
  /** Re-read decks from SQLite. Called after any mutation. */
  refreshDecks: () => Promise<void>;
  syncNow: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  continueOffline: () => void;
  signOut: () => Promise<void>;
}

const IDLE_SYNC: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null };

/**
 * Exported so tests can supply a state directly rather than mocking the module
 * that {@link useApp} lives in. Application code should use {@link AppProvider}.
 */
export const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [repository, setRepository] = useState<Repository | null>(null);
  const [examples, setExamples] = useState<ExampleService | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authResolved, setAuthResolved] = useState(!isCloudEnabled);
  const [sync, setSync] = useState<SyncStatus>(IDLE_SYNC);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<SyncEngine | null>(null);
  const auth = useMemo<AuthApi | null>(() => authApi(), []);

  // 1. Open and migrate the database.
  useEffect(() => {
    let cancelled = false;
    let opened: SQLiteDatabase | null = null;

    (async () => {
      try {
        opened = await openDatabase();
        await migrate(opened);
        if (cancelled) return;
        const repo = new Repository(opened);
        try {
          const normalized = await normalizeExistingCards(repo);
          if (normalized.frontsChanged > 0 || normalized.meaningsChanged > 0) {
            console.info(
              `[fluentflow] normalized ${normalized.frontsChanged} card front(s) and ` +
              `${normalized.meaningsChanged} pointer meaning(s)`,
            );
          }
        } catch (cause) {
          // A missing or temporarily unavailable dictionary must not keep the
          // collection from opening. The audit runs again at the next launch.
          console.warn('[fluentflow] card-front normalization skipped:', cause);
        }
        if (cancelled) return;
        setRepository(repo);
        setExamples(new ExampleService(repo));
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    // Closing the database before the document goes away.
    //
    // React's cleanup does not run when a page is navigated away from or
    // reloaded, and on the web expo-sqlite keeps the connection in a worker
    // that outlives the document. Left open, the next page finds the virtual
    // file system half-initialised and fails with "Invalid VFS state" — so
    // refreshing mid-session showed "FluentFlow could not start", and only a
    // second refresh recovered.
    //
    // `pagehide` rather than `beforeunload`: it fires for the back/forward
    // cache and in browsers where `beforeunload` is unreliable.
    const closeBeforeUnload = () => {
      void opened?.closeAsync();
    };
    globalThis.addEventListener?.('pagehide', closeBeforeUnload);

    return () => {
      cancelled = true;
      globalThis.removeEventListener?.('pagehide', closeBeforeUnload);
      void opened?.closeAsync();
    };
  }, []);

  // 2. Track the signed-in user.
  useEffect(() => {
    if (!auth) {
      setAuthResolved(true);
      return;
    }
    return auth.observe((firebaseUser) => {
      setUser(
        firebaseUser
          ? { id: firebaseUser.uid, email: firebaseUser.email, anonymous: false }
          : null,
      );
      setAuthResolved(true);
    });
  }, [auth]);

  const refreshDecks = useCallback(async () => {
    if (!repository || !user) {
      setDecks([]);
      return;
    }
    setDecks(await repository.listDecks(user.id));
  }, [repository, user]);

  // 3. Start a sync engine for whoever is signed in, and stop it when they
  //    change. Anonymous users get an engine too — it keeps the pending count
  //    accurate so the UI can say what would upload once they sign in.
  useEffect(() => {
    if (!repository || !user) return;

    const engine = new SyncEngine({
      repository,
      userId: user.id,
      cloudEnabled: isCloudEnabled && !user.anonymous,
      onStatus: setSync,
    });
    engineRef.current = engine;
    void engine.start().then(refreshDecks);

    const unsubscribeNet = NetInfo.addEventListener((netState) => {
      engine.setOnline(netState.isConnected !== false);
    });

    return () => {
      unsubscribeNet();
      engine.dispose();
      engineRef.current = null;
      setSync(IDLE_SYNC);
    };
  }, [repository, user, refreshDecks]);

  // A remote change can add or remove decks, so the list follows sync activity.
  useEffect(() => {
    if (sync.state === 'idle') void refreshDecks();
  }, [sync.state, sync.lastSyncedAt, refreshDecks]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!auth) throw new Error('Cloud sync is not configured in this build.');
      const previous = user;
      const account = await auth.signIn(email, password);
      await claimAnonymousData(repository, previous, account.uid);
    },
    [auth, repository, user],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      if (!auth) throw new Error('Cloud sync is not configured in this build.');
      const previous = user;
      const account = await auth.register(email, password);
      await claimAnonymousData(repository, previous, account.uid);
    },
    [auth, repository, user],
  );

  const continueOffline = useCallback(() => {
    setUser({ id: LOCAL_USER_ID, email: null, anonymous: true });
  }, []);

  const signOut = useCallback(async () => {
    await auth?.logOut();
    setUser(null);
    setDecks([]);
  }, [auth]);

  const syncNow = useCallback(async () => {
    await engineRef.current?.sync();
    await refreshDecks();
  }, [refreshDecks]);

  const value = useMemo<AppState>(
    () => ({
      ready: Boolean(repository) && authResolved,
      error,
      repository,
      examples,
      user,
      cloudAvailable: isCloudEnabled,
      sync,
      decks,
      refreshDecks,
      syncNow,
      signIn,
      register,
      continueOffline,
      signOut,
    }),
    [
      repository,
      authResolved,
      error,
      examples,
      user,
      sync,
      decks,
      refreshDecks,
      syncNow,
      signIn,
      register,
      continueOffline,
      signOut,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>.');
  return value;
}

/** Convenience accessor for screens that cannot run without a repository. */
export function useRepository(): Repository {
  const { repository } = useApp();
  if (!repository) throw new Error('The database is not open yet.');
  return repository;
}

const OPEN_RETRY_ATTEMPTS = 12;
const OPEN_RETRY_DELAY_MS = 100;
const RELOAD_MARKER = 'fluentflow.storageReload';

/**
 * Open the database, working around a reload that raced the previous page.
 *
 * On the web, expo-sqlite is wa-sqlite over the origin-private file system,
 * which allows exactly one access handle per file. Reloading mid-session
 * starts the new document before the old one's worker has let go, and the open
 * fails one of two ways:
 *
 *  - `NoModificationAllowedError` — the handle is still held. It is released
 *    within a few hundred milliseconds, so waiting is enough.
 *  - `Invalid VFS state` — wa-sqlite's own module state is now unusable, and
 *    no amount of retrying inside this document will clear it. A fresh
 *    document always works.
 *
 * So: retry the first, and reload once for the second. The marker keeps that
 * from becoming a loop — if a reload does not fix it, the error is real and
 * the user sees it.
 */
async function openDatabase(): Promise<SQLiteDatabase> {
  let lastError: unknown;

  for (let attempt = 0; attempt < OPEN_RETRY_ATTEMPTS; attempt++) {
    try {
      const database = await openDatabaseAsync(DATABASE_NAME);
      clearReloadMarker();
      return database;
    } catch (cause) {
      lastError = cause;
      if (isVfsCorruptError(cause) && reloadOnce()) {
        // The reload is already scheduled; hold until the document goes away
        // rather than racing it with another attempt.
        await delay(10_000);
      }
      if (!isLockedError(cause)) throw cause;
      await delay(OPEN_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isLockedError(cause: unknown): boolean {
  const name = (cause as { name?: string } | null)?.name ?? '';
  return name === 'NoModificationAllowedError' || /access handle/i.test(messageOf(cause));
}

function isVfsCorruptError(cause: unknown): boolean {
  return /invalid vfs state/i.test(messageOf(cause));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** @returns whether a reload was actually started. */
function reloadOnce(): boolean {
  try {
    const storage = globalThis.sessionStorage;
    const location = globalThis.location;
    if (!storage || !location?.reload || storage.getItem(RELOAD_MARKER)) return false;
    storage.setItem(RELOAD_MARKER, '1');
    location.reload();
    return true;
  } catch {
    // No sessionStorage (a private window, or a native build): fall through to
    // reporting the error rather than reloading blind.
    return false;
  }
}

function clearReloadMarker(): void {
  try {
    globalThis.sessionStorage?.removeItem(RELOAD_MARKER);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Move decks and cards studied before sign-in onto the new account.
 *
 * Skipped when the previous session was already a real account: that data
 * belongs to the other user and re-homing it would leak it across accounts.
 */
async function claimAnonymousData(
  repository: Repository | null,
  previous: AuthUser | null,
  newUserId: string,
): Promise<void> {
  if (!repository) return;
  if (!previous?.anonymous) return;
  if (previous.id === newUserId) return;
  await repository.claimLocalData(previous.id, newUserId);
}
