# FluentFlow

A flashcard app for language learning: spaced repetition over vocabulary decks,
with example sentences generated on the device rather than by an API, Anki
`.apkg` import, and last-write-wins sync across devices.

```
npm install
npm run build          # build the shared core package
npm test               # 98 tests
npm run verify         # end-to-end check of the success criteria
npm run server         # sync API on :8787 (no Firebase project needed)
npm run mobile         # Expo dev server
```

Nothing above needs a Firebase project or the model weights. The server starts
in local mode with an in-memory store, and examples fall back to written
sentences until a model is installed. Both are covered below.

## Layout

```
packages/core      domain logic, no platform dependencies — 81 tests
apps/server        Express + Firestore sync API and Anki import — 17 tests
apps/mobile        Expo app (iOS, Android, web)
apps/desktop       Electron shell for Windows and macOS
scripts            model preparation, end-to-end verification
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
| Localisation | Complete: English, Spanish, Bosnian UI packs |
| AI pipeline | Complete: prompting, parsing, validation, budget, fallback |
| AI **weights** | **Not bundled.** `npm run prepare-model` fetches and converts them |
| iOS / Android / web | Expo, standard |
| Windows / macOS | Electron around the web export, not native RN |

All three platform bundles build: `npx expo export --platform web` and
`--platform ios --platform android` both complete, the latter through Hermes.

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
npm test              # unit and integration tests
npm run verify        # end-to-end against the real server
```

`npm run verify` is the one to run when judging whether this works. It starts
the sync server, drives two simulated devices through the success criteria over
HTTP, imports a generated 60-card `.apkg`, takes a device offline and back, and
checks that conflicting edits converge. It covers everything except the React
Native views.

It has already earned its place. It caught a real bug: the import endpoint
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

- The React Native views have no tests. They typecheck, and the logic beneath
  them is covered, but nothing here has rendered them on a device.
- `firebase-admin` pulls transitive dependencies with moderate `npm audit`
  advisories (via `@google-cloud/storage` → `teeny-request` → `uuid`). Nothing
  in this app uses Cloud Storage; resolving them needs an upstream release.
- The Electron shell has been built and its layout verified, but not launched —
  this machine has no display for it.
- Google sign-in is not implemented; email/password is. The unused strings for
  it were removed rather than left as a promise the UI does not keep.
- Import merges reverse and cloze siblings into one card per note and reports
  the count. Studying both directions of a card is not supported yet.
- The desktop and web builds have no local model, as described above.
- Phase-2 items from the brief (deck sharing, TTS, image occlusion, streaks) are
  not started.
