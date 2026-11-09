/**
 * Server configuration, read once from the environment.
 *
 * The server has two operating modes and picks between them by looking for
 * Firebase credentials:
 *
 *  - **firebase** — real Firebase Auth + Firestore. Used in production.
 *  - **local** — an in-process store and a permissive dev token. Nothing leaves
 *    the machine. This exists so the app can be run, demoed and tested without
 *    anyone provisioning a Firebase project first; it refuses to start if
 *    `NODE_ENV=production`.
 */

import { fileURLToPath } from 'node:url';

export type Mode = 'firebase' | 'local';

export interface Config {
  mode: Mode;
  port: number;
  host: string;
  /** Gemini key used only by the local development AI proxy. */
  geminiApiKey?: string;
  /** Hosted model id; defaults to the shared core default. */
  geminiModel?: string;
  /** Firebase project id; required in firebase mode. */
  projectId?: string;
  /** Path to a service-account JSON file, or undefined to use ADC. */
  credentialsPath?: string;
  /** Service-account JSON itself, for hosts where mounting a file is awkward. */
  serviceAccountJson?: string;
  /** Firestore emulator host, e.g. `localhost:8080`. */
  emulatorHost?: string;
  /** Maximum accepted `.apkg` upload size, in bytes. */
  maxUploadBytes: number;
  corsOrigins: string[];
  /**
   * The exported web app (`expo export --platform web`) to serve alongside the
   * API, so one deployment hosts both and the browser calls the API on its own
   * origin. Unset in development, where Expo's dev server hosts the app.
   */
  webDir?: string;
  /**
   * When set, only these signed-in accounts may use the API. A public
   * deployment otherwise lets anyone who registers in the Firebase project
   * spend its Gemini key.
   */
  allowedEmails?: string[];
  /** The deployed commit, published with the desktop bundle manifest. */
  commit?: string;
}

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../mobile/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  // The web client's project id is the same project, so a deployment that
  // already sets it for the browser build does not have to repeat it.
  const projectId =
    env.FIREBASE_PROJECT_ID ??
    env.GOOGLE_CLOUD_PROJECT ??
    env.GCLOUD_PROJECT ??
    env.EXPO_PUBLIC_FLUENTFLOW_FIREBASE_PROJECT_ID ??
    env.FLUENTFLOW_FIREBASE_PROJECT_ID ??
    undefined;
  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS ?? env.FIREBASE_SERVICE_ACCOUNT;
  const serviceAccountJson = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() || undefined;
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST;

  // In production a project id alone selects firebase mode: verifying ID tokens
  // needs nothing more, and local mode is refused there anyway.
  const hasFirebase = Boolean(
    projectId &&
      (credentialsPath || serviceAccountJson || emulatorHost || env.K_SERVICE || production),
  );
  const forced = env.FLUENTFLOW_MODE as Mode | undefined;
  const mode: Mode = forced ?? (hasFirebase ? 'firebase' : 'local');

  if (mode === 'local' && production) {
    throw new Error(
      'Refusing to start in local mode with NODE_ENV=production. ' +
        'Set FIREBASE_PROJECT_ID (or EXPO_PUBLIC_FLUENTFLOW_FIREBASE_PROJECT_ID), or unset NODE_ENV.',
    );
  }
  if (mode === 'firebase' && !projectId) {
    throw new Error('FLUENTFLOW_MODE=firebase requires FIREBASE_PROJECT_ID.');
  }

  return {
    mode,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? (mode === 'local' ? '127.0.0.1' : '0.0.0.0'),
    geminiApiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? undefined,
    geminiModel: env.GEMINI_MODEL ?? undefined,
    projectId,
    credentialsPath,
    serviceAccountJson,
    emulatorHost,
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024),
    corsOrigins: (
      env.CORS_ORIGINS ??
      'http://localhost:8081,http://127.0.0.1:8081,app://fluentflow'
    ).split(',').map((o) => o.trim()).filter(Boolean),
    webDir: env.FLUENTFLOW_WEB_DIR || (production ? DEFAULT_WEB_DIR : undefined),
    allowedEmails: parseList(env.FLUENTFLOW_ALLOWED_EMAILS)?.map((email) => email.toLowerCase()),
    // Railway sets RAILWAY_GIT_COMMIT_SHA on every deploy.
    commit: env.FLUENTFLOW_COMMIT || env.RAILWAY_GIT_COMMIT_SHA || undefined,
  };
}

function parseList(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}
