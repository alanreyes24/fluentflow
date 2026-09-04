# FluentFlow

A flashcard app for language learning: spaced repetition over vocabulary decks,
with example sentences generated on the device rather than by an API, Anki
`.apkg` import, and last-write-wins sync across devices.

```
npm install
npm run build          # build the shared core package
npm test               # 207 tests
npm run verify         # end-to-end check of the success criteria
npm run verify:web     # the same criteria, driven through Chrome
npm run server         # sync API on :8787 (no Firebase project needed)
npm run mobile         # Expo dev server
```

A packaged Windows build is on the
[releases page](https://github.com/alanreyes24/fluentflow/releases): a portable
executable that needs no installation, and an installer. Both are unsigned, so
SmartScreen asks for **More info → Run anyway** the first time.

Nothing above needs a Firebase project or the model weights. The server starts
in local mode with an in-memory store, and examples fall back to written
sentences until a model is installed. Both are covered below.

## Layout

```
packages/core      domain logic, no platform dependencies — 106 tests
apps/server        Express + Firestore sync API and Anki import — 17 tests
apps/mobile        Expo app (iOS, Android, web)
apps/desktop       Electron shell for Windows and macOS
scripts            model preparation, end-to-end verification
docs               where each platform stands
```

`packages/core` holds everything that is neither UI nor I/O: SM-2 scheduling,
the `.apkg` parser, sync merge, prompt construction, output parsing and the BPE
tokenizer. It is plain TypeScript with one dependency (`fflate`), which is why
it can be tested with `node --test` and reused unchanged by the app, the server
and the scripts. When the app and the server disagree about how a card should be
scheduled, there is one place to look.

## What works, and what is stubbed

Being direct about this, because "local AI" is the part most likely to be
misread:

| Area | State |
| --- | --- |
| SM-2 scheduling | Complete and tested, including the four-button adaptation |
| `.apkg` import | Complete for schema 11 and 18; zstd exports rejected with a fix |
| Local SQLite | Complete: migrations, indexes, soft deletes, review log |
| Sync | Complete: LWW, offline queue, real-time listeners, tombstones |
| Statistics | Complete: streaks, retention, study calendar, forecast, per-deck mastery |
| Localisation | Complete: English, Spanish, Bosnian UI packs |
| AI pipeline | Complete: prompting, parsing, validation, budget, fallback |
| AI **weights** | **Not bundled.** `npm run prepare-model` fetches and converts them |
| iOS / Android / web | Expo, standard |
| Windows / macOS | Electron around the web export, not native RN |
| The views | 84 render tests; the web and desktop builds walked through by a browser |

All three platform bundles build: `npx expo export --platform web` and
`--platform ios --platform android` both complete, the latter through Hermes.
The web and Windows builds are also driven end to end by a real browser — see
Testing — so what is claimed below has been watched running, not only compiled.

Where each platform actually stands — built, run, verified, shippable — and what
is left on each, is in [docs/platform-status.md](docs/platform-status.md).

The AI integration is real code — a greedy decoder over an ONNX graph with KV
cache reuse, and a Llama-style BPE tokenizer with byte fallback, both written
here and the tokenizer unit-tested. What is not in the repository is the ~620 MB
of quantised weights, and `onnxruntime-react-native` is an optional dependency
because it is a native module that needs a development build. Until both are
present, `generateExamples` uses its fallback and the UI says so. See
[apps/mobile/assets/models/README.md](apps/mobile/assets/models/README.md).

Windows and macOS deserve the same directness. Expo targets iOS, Android and the
web; desktop would otherwise mean the out-of-tree `react-native-windows` and
`react-native-macos` forks and a second native project to maintain.
[apps/desktop](apps/desktop) wraps the web export in Electron instead, which
gives a real installable app from one codebase and gives up the native model.

## Statistics and the streak

Every rating writes a row to `review_log`, and the statistics screen is that
table read back — the streak, the retention, the calendar and the rating split
are all counted, never estimated. The maths lives in
[packages/core/src/stats.ts](packages/core/src/stats.ts) as pure functions over
day-keyed rows, so a streak can be argued with in a unit test rather than by
changing the system clock.

Three decisions in there are worth stating, because each has a wrong answer
that looks right:

- **Days are local, not UTC.** A review at half past eleven at night belongs to
  the day the learner had. The grouping happens in SQL, but with an offset the
  repository passes in rather than SQLite's own `localtime` modifier — that
  modifier needs a timezone database the wasm build on the web does not
  reliably carry, so the same query would bucket by UTC in the browser and by
  local time on a phone, and a streak would disagree with itself across one
  person's devices.
- **A streak survives an untouched today.** It counts back from today, or from
  yesterday if today is still empty, and reports `atRisk` when it did the
  latter. The alternative resets every streak at midnight and shows the user a
  zero over breakfast.
- **Retention is defined as 1 for an empty history.** "You have forgotten
  nothing" is truer on a first launch than "you have failed everything".

The charts are plain views — bars, a meter and a contribution grid built from
flexbox. `react-native-svg` would add a native module to a project whose whole
desktop story depends on not having one, to draw rectangles.

## Running it

### Local mode, no accounts

```
npm run server        # local mode: in-memory store, "Bearer local:<name>" tokens
npm run mobile        # then press w for web, i for iOS
```

Local mode exists so the app is demonstrable before anyone provisions Firebase.
It refuses to start with `NODE_ENV=production`. On the sign-in screen, "Continue
without an account" keeps everything in SQLite; signing in later re-homes that
data onto the account rather than stranding it.

### With Firebase

1. Create a project, enable Email/Password auth and Firestore.
2. Fill `extra.firebase` in [apps/mobile/app.json](apps/mobile/app.json) with the
   web app config.
3. Copy `.env.example` to `.env`, set `FIREBASE_PROJECT_ID` and
   `GOOGLE_APPLICATION_CREDENTIALS`.
4. `firebase deploy --only firestore:rules,firestore:indexes`

Or run against the emulator suite: `firebase emulators:start`, then uncomment
`FIRESTORE_EMULATOR_HOST` in `.env`.

### Desktop

```
npm run desktop       # builds the web export, then packages with electron-builder
```

`apps/desktop` is deliberately outside the npm workspaces: Electron is a large
download and nobody working on the mobile app should pay for it on every
`npm install`.

That packages installers, which is slow and not how you would try a change out.
See [Building the desktop app](#building-the-desktop-app): `npm run desktop:refresh`
pushes a new build into an app you already have in about 30 seconds, with no
installer and nothing downloaded.

## Design notes

The decisions that took the most thought, and are the ones to argue with:

**Anki's `unicase` collation makes modern collections unreadable.** Anki
declares its schema-18 text columns `collate unicase`, using a collation its
Rust layer registers at runtime. On an ordinary table a stock SQLite can still
`SELECT` such a column and only fails on `ORDER BY` — but Anki's `fields` and
`templates` tables are `WITHOUT ROWID`, where the table *is* an index, so
**every** query against them fails with "no query solution". `fields` is where
note-type field names live, which is exactly what tells "Front" from "Back".

Neither `node:sqlite` nor `expo-sqlite` can register a custom collation, so the
importer rewrites the stored schema of the throwaway copy it just extracted,
bumps the schema cookie, and reopens.
[packages/core/src/anki/collation.ts](packages/core/src/anki/collation.ts) has
the details; the import still degrades to positional field mapping rather than
failing if the repair does not take.

**Conflicts must converge without coordination.** Last-write-wins is
underspecified when two devices write in the same millisecond, and picking
arbitrarily makes them overwrite each other indefinitely. Ties break on a
canonical serialisation of the record, so both devices independently reach the
same answer. Deletes are tombstones, because a missing row is indistinguishable
from one that has not been uploaded yet. Deck card counts are recomputed rather
than synced — two devices each adding a card would otherwise both write
`cardCount: 11` and lose one.

**The AI budget is a deadline, not a target.** `generateExamples` races
inference against a hard timer and ships the fallback when it expires,
discarding the model's answer even if it arrives a moment later. A learner
staring at a spinner is a worse outcome than a generic sentence. Ratings stay
live while generation runs, so a slow model can never stall a review.

**Model output is validated, not trusted.** A 1.1B model asked for a JSON array
returns one perhaps two thirds of the time; the rest is numbered lists, prose
preambles, truncated arrays, or the prompt echoed back. Parsing degrades through
four strategies and then *rejects* candidates — a sentence that does not contain
the word it was supposed to demonstrate is worse than no sentence. Matching
tolerates inflection, since Spanish and Bosnian both decline heavily and
`hablar` legitimately appears as `habla`.

**Fallback examples quote rather than conjugate.** Getting agreement and case
right without a model is not something a template can do honestly in either
language, so the fallback produces sentences that are grammatical *about* the
word (`«hablar» significa "to speak".`). The UI labels them as offline examples.

**An optional native module needs resolver help, not a try/catch.** ONNX
Runtime has to be optional — it is a native module, so it needs a development
build and cannot load in Expo Go. Neither obvious approach works: `await
import(name)` is a Hermes compile error ("Invalid expression encountered"), and
a static `require` in a try/catch still breaks the *build*, because Metro
resolves requires before any code runs. `metro.config.js` therefore maps the
module to a stub when it is absent, and the app writes a plain require and
checks what came back.

**Package versions follow the SDK, not npm's `latest`.** Every `expo-*` and
community package declares `react-native: *`, so npm hoists whatever is newest
and a workspace quietly ends up with two copies of React Native — the classic
cause of "invalid hook call". Worse, React Native 0.87 removed the `./*`
subpath export that Expo's own CLI relies on, so the web export fails outright.
The versions here come from `node_modules/expo/bundledNativeModules.json`
(0.86.3), pinned with a root `overrides` block so a transitive `*` cannot drag
in another.

**KV cache reuse is what makes the budget reachable.** Without it, each new
token re-reads the whole prompt: 40 tokens over a ~120-token prompt is roughly
twenty times the work. `num_key_value_heads` differs from
`num_attention_heads` on grouped-query models — TinyLlama has 32 attention
heads and 4 KV heads — and using the wrong one succeeds on the first token and
fails on the second.

## Testing

```
npm test              # 207 unit and integration tests
npm run verify        # 26 checks end-to-end against the real server
npm run verify:web    # 22 checks driving the web build through Chrome
npm run verify:desktop  # 14 checks driving the packaged Windows app
```

`npm run verify` is the one to run when judging whether the *logic* works. It
starts the sync server, drives two simulated devices through the success
criteria over HTTP, imports a generated 60-card `.apkg`, takes a device offline
and back, and checks that conflicting edits converge.

`npm run verify:web` is the one to run when judging whether the *app* works. It
builds the web export, serves it, and walks Chrome through the brief: continue
without an account, create a Spanish deck, add cards, reveal, rate with the
keyboard, reload, read the statistics those reviews produced, and switch the
interface to Bosnian. `verify:desktop` does the
same against the packaged executable, which is how the `app://` scheme, the
content security policy and SQLite-outside-a-browser get exercised. Both leave
screenshots behind as evidence.

The 84 view tests run under jest-expo in two projects, iOS and web, rather than
one with a mocked `Platform`. Keyboard shortcuts only bind on web and the rating
buttons only show their number prefix there, so running the same components
under both presets tests the real branch instead of the mock. The repository
they run against is real SQLite through `node:sqlite`, so pressing "Good" in a
test runs the same SM-2 code a phone runs.

These have earned their place. `verify:web` found that refreshing the page
mid-session left the app on "FluentFlow could not start": on the web,
expo-sqlite is wa-sqlite over the origin-private file system, which allows one
access handle per file, and a reload begins the new document before the old one
has let go. It fails two ways that need different answers — a held handle clears
within a few hundred milliseconds and is waited out, while "Invalid VFS state"
leaves wa-sqlite unusable for the life of the document and is met with a single
guarded reload. Writing the render tests also turned up `Field` rendering its
label as a sibling `Text` with nothing tying it to the input, so a screen reader
announced an unnamed text box.

`npm run verify` caught a real bug of its own: the import endpoint
stored records with `syncStatus: 'pending'` because the importer marks its
output that way — correctly, since on a device those records do still owe the
server an upload. Every device that pulled an imported deck therefore believed
it owed 60 uploads. The fix normalises at the storage boundary rather than in
the route, so no future endpoint can reintroduce it; the regression test is in
[apps/server/test/api.test.ts](apps/server/test/api.test.ts).

The `.apkg` tests build real ZIP archives around real SQLite collections in both
schemas, including the `unicase` collation, rather than stubbing a database —
see
[packages/core/test/helpers/anki-fixture.js](packages/core/test/helpers/anki-fixture.js).

## Known gaps

- **iOS and Android have never been run on a device.** Both bundles export, and
  the views are covered by 84 render tests plus a browser walkthrough of the
  same components under react-native-web, but nothing here has launched them on
  a phone or a simulator. The native paths that differ from the web — the real
  SQLite backend, the document picker, ONNX Runtime — are unexercised.
- The model weights are not bundled, as described above, so the desktop and web
  builds fall back to written sentences and the mobile build does too until
  `npm run prepare-model` has run. The decode loop has never seen a real ONNX
  graph.
- `firebase-admin` pulls transitive dependencies with moderate `npm audit`
  advisories (via `@google-cloud/storage` → `teeny-request` → `uuid`). Nothing
  in this app uses Cloud Storage; resolving them needs an upstream release.
- Sync has only been exercised against the local server. No Firebase project has
  been provisioned, so the Firestore store and its security rules are unproven
  against the real service.
- Google sign-in is not implemented; email/password is. The unused strings for
  it were removed rather than left as a promise the UI does not keep.
- Import merges reverse and cloze siblings into one card per note and reports
  the count. Studying both directions of a card is not supported yet.
- Windows builds are unsigned, and `dist:win:unsigned` skips the executable
  resource edit — see below. macOS has not been packaged at all; it needs a Mac.
- Phase-2 items from the brief (deck sharing, TTS, image occlusion, streaks) are
  not started.

## Building the desktop app

```
npm run desktop           # installs Electron, builds, packages for Windows
npm run verify:desktop    # launches the packaged app and drives it
```

That writes two 110 MB installers and takes minutes. It is the wrong loop for
trying a change out.

### Testing a new version without downloading one

A packaged FluentFlow is 370 MB on disk, and 367 MB of that is the Electron
runtime — the same bytes in every version. What actually changes is
`resources/app`: the web export, `main.js` and `preload.js`, about 3 MB
together. So a new version is a file copy, not a download.

```
npm run desktop:pack               # once: builds dist/win-unpacked, no installer
npm run desktop:refresh            # each version after: rebuild and push, ~30 s
npm run desktop:refresh -- --run   # ...and launch it
```

`refresh` updates every packaged FluentFlow it can find — the unpacked build in
`dist/`, and an installed copy under `%LOCALAPPDATA%/Programs/FluentFlow` — so
the entry on the Start menu can be kept current without ever downloading
anything. This works only because `asar: false` is set: the app files sit loose
on disk instead of sealed inside an archive. It refuses to write into a copy
that is currently running, and it cannot update the portable exe at all, which
unpacks itself into a temporary directory on every launch.

An Electron version bump still needs a real rebuild. Nothing else does.

For UI work there is a faster loop again: `npm run web` in one terminal and
`npm run desktop:dev` in another points the shell at the Metro dev server, and a
save shows up in the window straight away. That is not the packaged code path,
though — the `app://` scheme and the production CSP only exist in a real build —
so confirm anything shell-shaped with `refresh` before believing it.

### Two Windows-specific notes, both learned the hard way

**The build skips the executable resource edit.** electron-builder fetches a
signing toolchain whose archive contains macOS symlinks, and Windows refuses to
create those without Developer Mode or an elevated prompt, so the extraction
fails and takes the build with it. Nothing here is signed anyway, and asking
every contributor to change a Windows setting is worse than losing the version
metadata stamped into the exe.

**`ELECTRON_RUN_AS_NODE` must not be set.** Editors built on Electron — VS Code
among them — export it for their own child processes, and any Electron binary
that inherits it runs as plain Node: no window, no `protocol`, and an immediate
exit with status 0. It imitates a broken build convincingly enough to send you
looking at asar and code signing first. Every script here strips it before
spawning Electron — that is the whole reason `apps/desktop/scripts/launch.mjs`
exists — so `npm start`, `desktop:refresh --run` and the verification scripts are
immune to it. A bare `npx electron .` is not.
