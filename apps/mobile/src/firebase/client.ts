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
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  where,
  writeBatch,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeCard, type Card, type Deck, type ReviewEvent } from '@fluentflow/core';
import { appConfig, isCloudEnabled } from './config';

/**
 * Firebase client wrapper.
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
let firestoreInstance: Firestore | null = null;

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

export function firestore(): Firestore | null {
  const instance = firebaseApp();
  if (!instance) return null;
  firestoreInstance ??= getFirestore(instance);
  return firestoreInstance;
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

// --- firestore --------------------------------------------------------------

const MAX_BATCH_WRITES = 500;

function decksRef(db: Firestore, userId: string) {
  return collection(db, 'users', userId, 'decks');
}

function cardsRef(db: Firestore, userId: string) {
  return collection(db, 'users', userId, 'cards');
}

function reviewEventsRef(db: Firestore, userId: string) {
  return collection(db, 'users', userId, 'reviewEvents');
}

export interface RemoteSnapshot {
  decks: Deck[];
  cards: Card[];
  reviewEvents: ReviewEvent[];
}

/** One-shot read of everything, or of everything newer than `since`. */
export async function fetchRemote(userId: string, since?: string): Promise<RemoteSnapshot> {
  const db = firestore();
  if (!db) return { decks: [], cards: [], reviewEvents: [] };

  const constrain = (ref: ReturnType<typeof decksRef>) =>
    since ? query(ref, where('lastModified', '>', since)) : query(ref);

  const [deckSnap, cardSnap] = await Promise.all([
    getDocs(constrain(decksRef(db, userId))),
    getDocs(constrain(cardsRef(db, userId))),
  ]);
  // Review history is an append-only set. Reading the full set is deliberate:
  // reviewedAt comes from a device clock, so using it as an incremental cursor
  // could miss an offline review after another device has synced.
  const reviewSnap = await getDocs(reviewEventsRef(db, userId));

  return {
    decks: deckSnap.docs.map((d) => d.data() as Deck),
    // A document written by a client older than the Anki scheduler has no
    // phase; normalizeCard reconstructs one rather than letting it reach the
    // scheduler half-filled.
    cards: cardSnap.docs.map((d) => normalizeCard(d.data() as Card)),
    reviewEvents: reviewSnap.docs.map((d) => d.data() as ReviewEvent),
  };
}

/** Upload records. Idempotent, and chunked to respect Firestore's batch limit. */
export async function pushRemote(
  userId: string,
  decks: Deck[],
  cards: Card[],
  reviewEvents: ReviewEvent[] = [],
): Promise<void> {
  const db = firestore();
  if (!db || (decks.length === 0 && cards.length === 0 && reviewEvents.length === 0)) return;

  const writes: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[] = [
    ...decks.map((deck) => ({
      ref: doc(db, 'users', userId, 'decks', deck.id),
      data: toRemote(deck),
    })),
    ...cards.map((card) => ({
      ref: doc(db, 'users', userId, 'cards', card.id),
      data: toRemote(card),
    })),
    ...reviewEvents.map((event) => ({
      ref: doc(db, 'users', userId, 'reviewEvents', event.eventId),
      data: toRemote(event),
    })),
  ];

  for (let i = 0; i < writes.length; i += MAX_BATCH_WRITES) {
    const batch = writeBatch(db);
    for (const write of writes.slice(i, i + MAX_BATCH_WRITES)) {
      batch.set(write.ref, write.data);
    }
    await batch.commit();
  }
}

/**
 * Live subscription used for cross-device updates.
 *
 * The listener fires for local writes too (that is how Firestore works), so the
 * caller must run the same merge it uses for a manual pull rather than trusting
 * every callback to be remote news.
 */
export function subscribeRemote(
  userId: string,
  onChange: (snapshot: RemoteSnapshot) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const db = firestore();
  if (!db) return () => undefined;

  let decks: Deck[] = [];
  let cards: Card[] = [];
  let reviewEvents: ReviewEvent[] = [];
  let deckReady = false;
  let cardReady = false;
  let reviewEventsReady = false;

  const emit = () => {
    // Wait for both collections before the first emit, so a merge never sees
    // cards whose deck has not arrived yet.
    if (deckReady && cardReady && reviewEventsReady) onChange({ decks, cards, reviewEvents });
  };

  const unsubscribeDecks = onSnapshot(
    decksRef(db, userId),
    (snapshot) => {
      decks = snapshot.docs.map((d) => d.data() as Deck);
      deckReady = true;
      emit();
    },
    onError,
  );

  const unsubscribeCards = onSnapshot(
    cardsRef(db, userId),
    (snapshot) => {
      cards = snapshot.docs.map((d) => normalizeCard(d.data() as Card));
      cardReady = true;
      emit();
    },
    onError,
  );

  const unsubscribeReviewEvents = onSnapshot(
    reviewEventsRef(db, userId),
    (snapshot) => {
      reviewEvents = snapshot.docs.map((d) => d.data() as ReviewEvent);
      reviewEventsReady = true;
      emit();
    },
    onError,
  );

  return () => {
    unsubscribeDecks();
    unsubscribeCards();
    unsubscribeReviewEvents();
  };
}

/** `syncStatus` is local bookkeeping and must not be written to the cloud. */
function toRemote<T extends { syncStatus?: string }>(record: T): Record<string, unknown> {
  const { syncStatus: _local, ...rest } = record;
  return { ...rest, syncStatus: 'synced' };
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
