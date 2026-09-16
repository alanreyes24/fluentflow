# Development guide

Start with the [README](../README.md) for the local browser and desktop setup.
Use Node 26.1+; `.nvmrc` records a tested version. Node's
[SQLite serialization APIs](https://nodejs.org/api/sqlite.html#databaseserializedbname)
are used by the import code and test fixtures.

## Configuration

Copy `.env.example` to `.env` only if you need optional configuration. Keep
secrets, downloaded dictionaries, user databases, and personal decks out of Git.
The example leaves cloud services disabled.

`npm run dev` loads the root `.env`, starts the API in local mode, and starts
Expo. The API defaults to `127.0.0.1:8787`; browser access is allowed from the
two loopback origins on port 8081 and the Electron app origin. `HOST` and
`CORS_ORIGINS` can override these defaults. Local tokens are not authentication
for an internet-facing service, even if you restrict CORS.

`npm run server` alone does not load `.env`. To load it explicitly:

```bash
node --env-file=.env apps/server/src/index.ts
```

## Firebase (optional)

1. Create your own Firebase project with a web app, Email/Password auth, and
   Firestore.
2. Fill in both sets of client values in `.env.example`: `FLUENTFLOW_FIREBASE_*`
   for Expo's manifest and `EXPO_PUBLIC_FLUENTFLOW_FIREBASE_*` for web exports.
   These are public client configuration, not admin credentials. Restart the
   dev processes or rebuild after changing them.
3. Review [firestore.rules](../firestore.rules) before deploying. The client
   syncs directly through Firebase; the standalone server is optional.
4. Deploy to an explicitly selected project:

   ```bash
   npx firebase-tools login
   npm run firebase:deploy -- --project YOUR_PROJECT_ID
   ```

The committed `.firebaserc` has no default project. `firebase use --add` can set
one for your machine, but do not commit your personal project selection.

For a separately hosted API, configure `FLUENTFLOW_MODE=firebase`,
`FIREBASE_PROJECT_ID`, server-side admin credentials or Application Default
Credentials, and an explicit `CORS_ORIGINS` allowlist. `NODE_ENV=production`
rejects local mode. The server needs a deployment and security review before
being exposed publicly; the scripts here do not provision a production API.

The emulator definitions are in `firebase.json`. The server accepts
`FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST`; the app's Firebase
client does not automatically connect to those emulators.

## Verification

```bash
npm test
npm run typecheck
npm run verify
npm run web:export
```

CI runs these checks from the lockfile without credentials. Desktop unit tests
run under Node; they do not launch Electron or test an installer.
Web exports clear Metro's cache so a previous build's Firebase configuration
is not reused after changing projects or environment variables.

`npm run verify:web` needs Chrome (or `CHROME_PATH`) and writes screenshots to
`.web-export-shots/`. `npm run verify:desktop` needs a packaged app; set
`FLUENTFLOW_APP` to use an installed copy. It writes `.desktop-shots/`.
These walkthroughs can read a local Gemini key and make billed requests when
one is configured. Review their environment settings before running them.
The web walkthrough needs port 8787 free; stop `npm run dev` for that check and
restart it afterward.

## Desktop packaging

```bash
npm run desktop:pack   # unpacked app for this platform
npm run desktop:mac    # macOS arm64 DMG and ZIP
npm run desktop:win    # Windows NSIS installer and portable executable
```

Build on the target OS where possible. The wrapper installs the desktop
dependencies and builds the shared core and web bundle. Outputs go to
`apps/desktop/dist/`. Dictionary downloads and user credentials are separate.

`npm run desktop:refresh` can copy a new build into an existing app; use the dev
workflow for everyday edits. Signing and notarization environment variables
are documented in [desktop-build.mjs](../scripts/desktop-build.mjs).

For a distributed fork, change the package identity, Firebase configuration,
and `apps/desktop/package.json`'s `build.publish` update feed. Keep signing
certificates and tokens outside the repo. Review dependency advisories before
building or publishing binaries.
