/**
 * Build-time configuration for Expo web, Electron, and native builds.
 *
 * Firebase's web configuration is intentionally public client configuration;
 * Firestore rules and Firebase Auth protect the data. Keeping it in env vars
 * lets local, staging, and production builds use different projects without
 * editing app.json by hand.
 */
const fs = require('node:fs');
const path = require('node:path');
const base = require('./app.json');

// Expo does not consistently load a workspace-root .env when invoked from a
// package script, so load the small set of build variables explicitly. Shell
// and CI variables still win over the local file.
const rootEnv = path.join(__dirname, '../../.env');
if (fs.existsSync(rootEnv)) {
  for (const line of fs.readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

module.exports = ({ config }) => {
  const expo = config || base.expo;
  const current = expo.extra || {};
  const currentFirebase = current.firebase || {};
  const projectId = env('FLUENTFLOW_FIREBASE_PROJECT_ID', currentFirebase.projectId);

  return {
    ...expo,
    extra: {
      ...current,
      apiBaseUrl:
        process.env.FLUENTFLOW_API_BASE_URL ??
        (process.env.NODE_ENV === 'production' ? null : current.apiBaseUrl),
      firebase: {
        ...currentFirebase,
        apiKey: env('FLUENTFLOW_FIREBASE_API_KEY', currentFirebase.apiKey),
        authDomain: env(
          'FLUENTFLOW_FIREBASE_AUTH_DOMAIN',
          currentFirebase.authDomain || (projectId ? `${projectId}.firebaseapp.com` : ''),
        ),
        projectId,
        storageBucket: env('FLUENTFLOW_FIREBASE_STORAGE_BUCKET', currentFirebase.storageBucket),
        messagingSenderId: env(
          'FLUENTFLOW_FIREBASE_MESSAGING_SENDER_ID',
          currentFirebase.messagingSenderId,
        ),
        appId: env('FLUENTFLOW_FIREBASE_APP_ID', currentFirebase.appId),
      },
    },
  };
};
