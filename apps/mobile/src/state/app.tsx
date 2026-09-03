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

const AppContext = createContext<AppState | null>(null);

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
        opened = await openDatabaseAsync(DATABASE_NAME);
        await migrate(opened);
        if (cancelled) return;
        const repo = new Repository(opened);
        setRepository(repo);
        setExamples(new ExampleService(repo));
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      cancelled = true;
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
