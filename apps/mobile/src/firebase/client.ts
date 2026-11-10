import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type Unsubscribe,
  type User,
} from 'firebase/auth';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { appConfig, isCloudEnabled } from './config';

/**
 * Firebase client wrapper — sign-in only.
 *
 * Firebase says who the user is; it does not hold their data. Decks, cards and
 * review history live in the sync server's database (see `sync/remote.ts`),
 * which verifies the ID token this module hands out.
 *
 * Everything here returns `null` or throws a clear error when Firebase is not
 * configured, so callers never have to branch on `isCloudEnabled` themselves
 * beyond deciding whether to offer sign-in at all.
 *
 * Persistence needs a platform split: on the web the SDK's own IndexedDB
 * persistence is right, while on native there is no `window`, so auth state is
 * kept in AsyncStorage. Getting this wrong signs the user out on every cold
 * start, which is the sort of bug that looks like a sync failure.
 */

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;

export function firebaseApp(): FirebaseApp | null {
  if (!isCloudEnabled || !appConfig.firebase) return null;
  if (app) return app;
  app = getApps().length > 0 ? getApp() : initializeApp(appConfig.firebase);
  return app;
}

export function firebaseAuth(): Auth | null {
  const instance = firebaseApp();
  if (!instance) return null;
  if (authInstance) return authInstance;

  if (Platform.OS === 'web') {
    authInstance = getAuth(instance);
    void authInstance.setPersistence(browserLocalPersistence);
  } else {
    authInstance = initializeAuth(instance, {
      persistence: asyncStoragePersistence(),
    });
  }
  return authInstance;
}

// --- auth -------------------------------------------------------------------

export interface AuthApi {
  signIn(email: string, password: string): Promise<User>;
  register(email: string, password: string): Promise<User>;
  logOut(): Promise<void>;
  observe(listener: (user: User | null) => void): Unsubscribe;
  idToken(): Promise<string | null>;
}

export function authApi(): AuthApi | null {
  const auth = firebaseAuth();
  if (!auth) return null;

  return {
    async signIn(email, password) {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      return credential.user;
    },
    async register(email, password) {
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      return credential.user;
    },
    logOut() {
      return signOut(auth);
    },
    observe(listener) {
      return onAuthStateChanged(auth, listener);
    },
    async idToken() {
      return auth.currentUser ? auth.currentUser.getIdToken() : null;
    },
  };
}

/**
 * Minimal AsyncStorage-backed persistence for Firebase Auth on native.
 *
 * `firebase/auth`'s React Native entry point is not exported consistently
 * across bundlers, and `getReactNativePersistence` moved between versions.
 * Implementing the (small, stable) persistence interface directly avoids
 * depending on which of those is available in a given install.
 */
function asyncStoragePersistence() {
  return {
    type: 'LOCAL' as const,
    async _isAvailable() {
      try {
        await AsyncStorage.setItem('__fluentflow_probe', '1');
        await AsyncStorage.removeItem('__fluentflow_probe');
        return true;
      } catch {
        return false;
      }
    },
    async _set(key: string, value: unknown) {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    },
    async _get(key: string) {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    async _remove(key: string) {
      await AsyncStorage.removeItem(key);
    },
    _addListener() {
      // Single-process app: nothing else mutates the store.
    },
    _removeListener() {
      // See _addListener.
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
