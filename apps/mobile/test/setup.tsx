import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Deck } from '@fluentflow/core';
import { AppContext, type AppState, type AuthUser } from '../src/state/app';
import { I18nProvider } from '../src/i18n';
import { ThemeProvider } from '../src/ui/theme';
import type { Repository } from '../src/db/repository';
import type { ExampleService } from '../src/ai/service';
import type { SyncStatus } from '../src/sync/engine';

/**
 * Test setup: mock the native seams, and nothing else.
 *
 * Everything mocked below is a native module with no JavaScript implementation
 * to run — a document picker that opens a system dialog, a network reachability
 * listener, a Firebase SDK that wants credentials. The database is *not* mocked
 * (see fakes/database.ts), so the code under test does real SQL and real SM-2.
 */

// --- native seams -----------------------------------------------------------

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en', languageTag: 'en-US' }],
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => void store.set(key, value)),
      removeItem: jest.fn(async (key: string) => void store.delete(key)),
      clear: jest.fn(async () => void store.clear()),
    },
  };
});

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(async () => ({ isConnected: true })),
  },
  addEventListener: jest.fn(() => jest.fn()),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  deserializeDatabaseSync: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), Paths: {} }));
jest.mock('expo-asset', () => ({ Asset: { fromModule: jest.fn() } }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => {}),
  hideAsync: jest.fn(async () => {}),
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

/**
 * The Firebase SDK ships untranspiled ESM and reaches for credentials and a
 * network at import time. All three entry points are stubbed: the app is
 * exercised in its unconfigured state, which is the state
 * `apps/mobile/app.json` ships with and the one "Continue without an account"
 * exists for. Sync itself is covered end-to-end by `npm run verify`, against a
 * real server rather than a mock.
 */
jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(),
  getApp: jest.fn(),
  getApps: jest.fn(() => []),
}));

jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(),
  initializeAuth: jest.fn(),
  browserLocalPersistence: {},
  getReactNativePersistence: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signOut: jest.fn(),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn(),
  getDocs: jest.fn(),
  getFirestore: jest.fn(),
  onSnapshot: jest.fn(() => jest.fn()),
  query: jest.fn(),
  where: jest.fn(),
  writeBatch: jest.fn(),
}));

/**
 * These two are `mock`-prefixed because babel-jest hoists `jest.mock` factories
 * above every other statement in the file: a factory may only close over names
 * that start with `mock`, which is how it knows the reference is deliberate.
 */
export const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  navigate: jest.fn(),
  dismiss: jest.fn(),
  setParams: jest.fn(),
};

export const mockSearchParams: { current: Record<string, string | undefined> } = { current: {} };

/**
 * Stable across renders, deliberately.
 *
 * Screens list `navigation` in effect dependency arrays, and the real
 * `useNavigation` returns the same object every render. A mock that built a
 * fresh one each time would re-run those effects forever — a hang that looks
 * like an application bug and is not one.
 */
export const mockNavigation = {
  setOptions: jest.fn(),
  addListener: jest.fn(() => jest.fn()),
  goBack: jest.fn(),
  navigate: jest.fn(),
};

jest.mock('expo-router', () => ({
  router: mockRouter,
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockSearchParams.current,
  useNavigation: () => mockNavigation,
  // The real one re-runs on screen focus; in a test the screen is always
  // focused, so running the effect once is the honest equivalent.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = require('react') as typeof import('react');
    useEffect(effect, [effect]);
  },
  Link: ({ children }: { children?: ReactNode }) => children ?? null,
  Redirect: () => null,
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

/**
 * The AsyncStorage fake is module-level, so a preference written by one test
 * would otherwise be read back by the next — the interface-language tests
 * failed in exactly that way before this.
 */
beforeEach(async () => {
  await AsyncStorage.clear();
});

// --- rendering --------------------------------------------------------------

const IDLE_SYNC: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null };

export const TEST_USER: AuthUser = {
  id: 'test-user',
  email: 'learner@example.com',
  anonymous: false,
};

export interface HarnessOptions extends Omit<RenderOptions, 'wrapper'> {
  repository?: Repository | null;
  examples?: ExampleService | null;
  user?: AuthUser | null;
  decks?: Deck[];
  sync?: SyncStatus;
  cloudAvailable?: boolean;
  ready?: boolean;
  error?: string | null;
  overrides?: Partial<AppState>;
}

/** Build an {@link AppState} whose jest.fn members can be asserted on. */
export function createAppState(options: HarnessOptions = {}): AppState {
  return {
    ready: options.ready ?? true,
    error: options.error ?? null,
    repository: options.repository ?? null,
    examples: options.examples ?? null,
    user: options.user === undefined ? TEST_USER : options.user,
    cloudAvailable: options.cloudAvailable ?? true,
    sync: options.sync ?? IDLE_SYNC,
    decks: options.decks ?? [],
    refreshDecks: jest.fn(async () => {}),
    syncNow: jest.fn(async () => {}),
    signIn: jest.fn(async () => {}),
    register: jest.fn(async () => {}),
    continueOffline: jest.fn(),
    signOut: jest.fn(async () => {}),
    ...options.overrides,
  };
}

/**
 * Render a screen inside the providers it expects.
 *
 * The i18n and theme providers are the real ones — a screen that renders the
 * wrong string or reads a missing palette entry should fail here.
 *
 * Async because Testing Library v14 made `render` (and `fireEvent`) async: it
 * awaits an `act` internally rather than leaving the caller to flush effects.
 */
export async function renderScreen(ui: ReactElement, options: HarnessOptions = {}) {
  const { repository, examples, user, decks, sync, cloudAvailable, ready, error, overrides, ...renderOptions } =
    options;
  const state = createAppState(options);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider>
        <ThemeProvider>
          <AppContext.Provider value={state}>{children}</AppContext.Provider>
        </ThemeProvider>
      </I18nProvider>
    );
  }

  const result = await render(ui, { wrapper: Wrapper, ...renderOptions });
  return { ...result, state };
}
