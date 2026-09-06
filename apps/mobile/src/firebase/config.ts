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
  const firebase = extra.firebase;

  // A partially filled config is worse than none: it fails at the first call
  // with an opaque SDK error instead of at startup with a clear one.
  const hasFirebase = Boolean(firebase?.apiKey && firebase?.projectId && firebase?.appId);

  return {
    apiBaseUrl: extra.apiBaseUrl?.replace(/\/+$/, '') || null,
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
