import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';

/**
 * The one firebase-admin app shared by token verification and the Firestore
 * store.
 *
 * Both used to reach for the default app independently, and only the store
 * created it — so in firebase mode an AI request that arrived before any sync
 * request failed with "The default Firebase app does not exist".
 *
 * Credentials are optional. Verifying an ID token needs only the project id
 * (Google's signing keys are public), which is all a host like Railway needs
 * for the browser's AI and import calls. A service account is required only
 * for Firestore access and for checking revoked tokens.
 */
export function adminApp(config: Config): App {
  const existing = getApps()[0];
  if (existing) return existing;

  const serviceAccount = readServiceAccount(config);
  if (serviceAccount) {
    return initializeApp({ credential: cert(serviceAccount), projectId: config.projectId });
  }
  // The emulator needs no credential; on Cloud Run the metadata server supplies
  // one. Elsewhere application-default credentials are resolved lazily, so a
  // host without them can still verify ID tokens.
  if (config.emulatorHost) {
    return initializeApp({ projectId: config.projectId });
  }
  return initializeApp({ credential: applicationDefault(), projectId: config.projectId });
}

/** True when the server can make authenticated Admin API calls. */
export function hasAdminCredentials(config: Config): boolean {
  return Boolean(config.serviceAccountJson || config.credentialsPath || process.env.K_SERVICE);
}

function readServiceAccount(config: Config): Record<string, unknown> | null {
  if (config.serviceAccountJson) return JSON.parse(config.serviceAccountJson);
  if (config.credentialsPath) return JSON.parse(readFileSync(config.credentialsPath, 'utf8'));
  return null;
}
