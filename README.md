# FluentFlow

I made FluentFlow to help me practice languages, mainly Spanish and Bosnian.
It's a **vibe-coded personal project**: I built it with a lot of help from AI
coding tools, shaped it around my own study habits, and kept the parts I found
useful. I'm sharing the code in case someone else finds it useful too.

Expect rough edges. This is a hobby app, with no promise of regular releases,
support, or production readiness. AI-generated translations and examples can
be wrong, so check anything that looks off.

## What it does

- Vocabulary decks with spaced repetition, review limits, and study statistics.
- Cards from pasted word lists or Anki `.apkg` files.
- Optional local dictionaries for Spanish and Bosnian.
- Optional Gemini examples, translations, and study chat using your own API key.
- Local SQLite storage, with optional account sync through the hosted server's
  Postgres database (Firebase is used only to sign in).
- An Electron desktop app and an Expo UI shared with the browser and mobile targets.

macOS and the browser are the main development paths. Windows packaging is
configured; native iOS and Android still need device testing. See
[platform status](docs/platform-status.md) for the limits.

## Run it locally

Use **Node.js 26.1 or newer** and npm. The repo includes an `.nvmrc` for a tested
version. The server and tests use Node's built-in SQLite serialization APIs,
which older Node releases do not provide.

```bash
git clone https://github.com/alanreyes24/fluentflow.git
cd fluentflow
npm ci
npm run build
npm run dev
```

Open [localhost:8081](http://localhost:8081) and choose **Continue without an
account**. No Firebase project or API key is needed. `npm run dev` starts the
web app and a development API on port 8787, and tries to open Chrome. Set
`FLUENTFLOW_OPEN_BROWSER=0` to skip that last step.

To use the desktop app, leave that command running and open a second terminal:

```bash
npm --prefix apps/desktop ci
npm run desktop:vendor
npm run desktop:dev
```

The desktop dependencies are installed separately because Electron is a large
download. UI changes refresh automatically. After changing `packages/core`,
run `npm run desktop:vendor` again; restart `npm run desktop:dev` after changing
the Electron main process or preload.

The development API keeps its sync data in memory and accepts permissive local
tokens. It is for your machine only; restarting it clears that store. The app's
own cards live in SQLite. Do not expose the development API to the internet.

## Optional features

**Dictionaries:** run `npm run fetch-dictionaries`. This streams large extracts
from Wiktionary via Kaikki and builds local lookup databases. The Bosnian data
comes from Wiktionary's Serbo-Croatian entries. Paired `word - meaning` lists
can be imported without a dictionary or API key.

**Gemini:** add your own key in the desktop app's **Settings → Cloud examples**.
For browser development, copy `.env.example` to `.env`, set `GEMINI_API_KEY`,
and restart `npm run dev`. The dev launcher can also use the key saved by the
desktop app. Requests use Google's hosted API and may incur charges; there are
no model weights or shared API credentials in this repo. Without a key, you can
still study and use cached or template example sentences.

**Account sync:** sign in with your own Firebase project, and sync through the
hosted server below. Nothing in a fresh checkout connects to mine.
Configuration steps are in [the development guide](docs/development.md).

## Hosted web app (Railway)

The repo deploys as one service that serves the web app and its API from the
same origin. The API is also the sync server: its Postgres database is the one
source of truth for decks, cards and review history on every device (desktop,
browser, phone). It also gives the hosted app Gemini examples and Anki import.
On iPhone, open the deployed URL in Safari and choose **Share → Add to Home
Screen** to launch it full screen like an app.

1. In Railway, create a service from this GitHub repo. Railway detects the npm
   workspaces and offers one service per package: keep only
   `@fluentflow/server` (its `apps/server/railway.json` builds the root
   `Dockerfile`, which also bundles the web app) and delete the others.
   Railway provides `PORT`.
2. Set these service variables. The `EXPO_PUBLIC_*` values are the same public
   Firebase web config as in `.env`, and are baked into the bundle at build time.
   - `EXPO_PUBLIC_FLUENTFLOW_FIREBASE_API_KEY`, `..._AUTH_DOMAIN`,
     `..._PROJECT_ID`, `..._STORAGE_BUCKET`, `..._MESSAGING_SENDER_ID`, `..._APP_ID`
   - `GEMINI_API_KEY` (runtime only; never use an `EXPO_PUBLIC_` name for it)
   - `FLUENTFLOW_ALLOWED_EMAILS`: your sign-in email(s), comma separated. Without
     it, anyone who registers in your Firebase project can spend your Gemini key.
3. Add a Postgres database to the project (**New → Database → PostgreSQL**) and
   give the server service a variable `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
   The server creates its tables on first use. Without it, sync answers 503.
4. Generate a domain under **Settings → Networking**. If your Firebase API key
   is restricted by HTTP referrer, add that domain to the key's allowed list.

**The first sync.** The server's collection is created once, from the
installed desktop app: the first time it syncs with an empty database it
uploads everything it has. Every other device (the browser, the phone, the
development desktop) waits until then, and the first time it syncs afterwards
it replaces its own copy with the server's. From then on devices push their
changes and pull everyone else's; when two edits to a card disagree, the
newer one wins and the server hands its copy back to the device that lost.

**Keeping the desktop app in step.** Set `FLUENTFLOW_WEB_URL` in `.env` to the
deployed domain and run `npm run desktop:refresh` once. From then on the
desktop app checks the hosted app on launch and every 30 minutes, downloads a
newer web build (every file is checked against the server's SHA-256 manifest),
and offers to reload. Shell changes (`apps/desktop/*.js`, `src/`) still need a
refresh: the web build records which shell it was made for in
`apps/mobile/public/desktop-shell.json`, and the desktop app waits rather than
run a build meant for a different shell. `npm test` fails if that file is stale;
regenerate it with `node scripts/desktop-shell-fingerprint.mjs`.

The server verifies Firebase ID tokens with only the project id. Set
`FIREBASE_SERVICE_ACCOUNT_JSON` (the key file's contents) only if you also want
revoked-token checks.

## Data and privacy

Studying without an account stores cards and review history on your device.
Signing in uploads decks, cards, generated examples, and review events to the
sync server's database. Using Gemini sends the relevant words,
meanings, or chat messages to Google. The desktop stores its API key separately
from decks using Electron's encrypted storage; the browser dev proxy keeps its
key on the server. Never put a Gemini key or service-account credential in an
`EXPO_PUBLIC_*` variable.

Packaged desktop builds are configured to check this repository's GitHub
Releases for updates. If you distribute a fork, change that feed first.

## Development

```bash
npm test
npm run typecheck
npm run verify
npm run web:export
```

These checks do not require cloud credentials. Browser and packaged-desktop
walkthroughs are also available as `npm run verify:web` and
`npm run verify:desktop`; see [the development guide](docs/development.md)
before running them.

| Directory | Contents |
| --- | --- |
| `packages/core` | Scheduling, import, sync, and AI prompt logic |
| `apps/mobile` | Expo / React Native UI, including the web app |
| `apps/desktop` | Electron shell and desktop integrations |
| `apps/server` | Development API and optional Firebase-backed server |
| `scripts` | Builds, dictionary downloads, and verification |

Small fixes and bug reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
For security concerns and known dependency advisories, see
[SECURITY.md](SECURITY.md).

## License and credits

The project code is licensed under [MIT](LICENSE).

Dictionary data is separate from the code license: the download script records
Wiktionary / Kaikki attribution and CC BY-SA 4.0 in each generated database.
Dependencies and imported decks retain their own licenses. FluentFlow is an
independent project and is not affiliated with Anki, Google, or the dictionary
projects.
