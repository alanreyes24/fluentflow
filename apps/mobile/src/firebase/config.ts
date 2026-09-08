import Constants from 'expo-constants';

/**
 * Runtime configuration, read from `app.json`'s `extra` block.
 *
 * Firebase config is deliberately optional. The app has to be useful before
 * anyone has provisioned a project — sign-in is skippable, decks live in
 * SQLite, and the AI examples never needed a network in the first place. When
 * the keys are absent the app runs in local-only mode and says so.
 */

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

export interface AppConfig {
  apiBaseUrl: string | null;
  firebase: FirebaseConfig | null;
}

interface RawExtra {
  apiBaseUrl?: string;
  firebase?: Partial<FirebaseConfig>;
}

function readExtra(): RawExtra {
  const extra = Constants.expoConfig?.extra ?? {};
  return extra as RawExtra;
}

export const appConfig: AppConfig = buildConfig();

function buildConfig(): AppConfig {
  const extra = readExtra();
  // Expo web exports do not reliably preserve `expo-constants`'s `extra`
  // manifest at runtime. The EXPO_PUBLIC_* values are compile-time inlined by
  // Expo, with the manifest remaining as the native/Electron fallback.
  const firebase = {
    ...extra.firebase,
    apiKey: process.env.EXPO_PUBLIC_FLUENTFLOW_FIREBASE_API_KEY ?? extra.firebase?.apiKey,
    authDomain:
      process.env.EXPO_PUBLIC_FLUENTFLOW_FIREBASE_AUTH_DOMAIN ?? extra.firebase?.authDomain,
    projectId: process.env.EXPO_PUBLIC_FLUENTFLOW_FIREBASE_PROJECT_ID ?? extra.firebase?.projectId,
    storageBucket:
      process.env.EXPO_PUBLIC_FLUENTFLOW_FIREBASE_STORAGE_BUCKET ?? extra.firebase?.storageBucket,
    messagingSenderId:
      process.env.EXPO_PUBLIC_FLUENTFLOW_FIREBASE_MESSAGING_SENDER_ID ??
      extra.firebase?.messagingSenderId,
    appId: process.env.EXPO_PUBLIC_FLUENTFLOW_FIREBASE_APP_ID ?? extra.firebase?.appId,
  };

  // A partially filled config is worse than none: it fails at the first call
  // with an opaque SDK error instead of at startup with a clear one.
  const hasFirebase = Boolean(firebase?.apiKey && firebase?.projectId && firebase?.appId);
  // Expo's web runtime can deserialize a null extra value as an empty object.
  // Treat anything other than a string as absent; calling replace() on that
  // value otherwise prevents the entire packaged renderer from mounting.
  const apiBaseUrl =
    typeof extra.apiBaseUrl === 'string' ? extra.apiBaseUrl.replace(/\/+$/, '') || null : null;

  return {
    apiBaseUrl,
    firebase: hasFirebase
      ? {
          apiKey: firebase!.apiKey!,
          authDomain: firebase!.authDomain ?? `${firebase!.projectId}.firebaseapp.com`,
          projectId: firebase!.projectId!,
          storageBucket: firebase!.storageBucket,
          messagingSenderId: firebase!.messagingSenderId,
          appId: firebase!.appId!,
        }
      : null,
  };
}

export const isCloudEnabled = appConfig.firebase !== null;

/** The user id used before (or instead of) signing in. */
export const LOCAL_USER_ID = 'local-user';
