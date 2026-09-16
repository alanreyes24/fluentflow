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
  /** Firestore emulator host, e.g. `localhost:8080`. */
  emulatorHost?: string;
  /** Maximum accepted `.apkg` upload size, in bytes. */
  maxUploadBytes: number;
  corsOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const projectId =
    env.FIREBASE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT ?? undefined;
  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS ?? env.FIREBASE_SERVICE_ACCOUNT;
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST;

  const hasFirebase = Boolean(projectId && (credentialsPath || emulatorHost || env.K_SERVICE));
  const forced = env.FLUENTFLOW_MODE as Mode | undefined;
  const mode: Mode = forced ?? (hasFirebase ? 'firebase' : 'local');

  if (mode === 'local' && env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to start in local mode with NODE_ENV=production. ' +
        'Set FIREBASE_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS, or unset NODE_ENV.',
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
    emulatorHost,
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024),
    corsOrigins: (
      env.CORS_ORIGINS ??
      'http://localhost:8081,http://127.0.0.1:8081,app://fluentflow'
    ).split(',').map((o) => o.trim()).filter(Boolean),
  };
}
