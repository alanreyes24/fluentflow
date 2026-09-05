# FluentFlow

A flashcard app for language learning: spaced repetition over vocabulary decks,
with example sentences generated on the device rather than by an API, Anki
`.apkg` import, decks built from a pasted word list, and last-write-wins sync
across devices.

```
npm install
npm run build          # build the shared core package
npm test               # 232 tests
npm run verify         # end-to-end check of the success criteria
npm run verify:web     # the same criteria, driven through Chrome
npm run server         # sync API on :8787 (no Firebase project needed)
npm run mobile         # Expo dev server
```

A packaged Windows build is on the
[releases page](https://github.com/alanreyes24/fluentflow/releases): a portable
executable that needs no installation, and an installer. Both are unsigned, so
SmartScreen asks for **More info → Run anyway** the first time.

macOS builds from the same command — `npm run desktop:mac` writes
`FluentFlow-0.1.0-arm64.dmg`. It is ad-hoc signed rather than notarised, so a
downloaded copy is quarantined and the first launch needs **right-click →
Open**. Nothing has been uploaded to the releases page for macOS.

Nothing above needs a Firebase project or the model weights. The server starts
in local mode with an in-memory store, and examples fall back to written
sentences until a model is installed. Both are covered below.

## Layout

```
packages/core      domain logic, no platform dependencies — 136 tests
apps/server        Express + Firestore sync API and Anki import — 17 tests
apps/mobile        Expo app (iOS, Android, web)
apps/desktop       Electron shell for Windows and macOS, both packaged
scripts            model preparation, end-to-end verification
```

`packages/core` holds everything that is neither UI nor I/O: SM-2 scheduling,
the `.apkg` parser, the pasted-text parser, sync merge, prompt construction,
output parsing and the BPE tokenizer. It is plain TypeScript with one dependency (`fflate`), which is why
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
| Text import | Complete: separator detection, live preview, per-line reporting |
| Word lists | Complete: a list with no meanings is looked up, then reviewed |
| Dictionaries | Complete: Spanish and Bosnian, from Wiktionary, `npm run fetch-dictionaries` |
| Local SQLite | Complete: migrations, indexes, soft deletes, review log |
| Sync | Complete: LWW, offline queue, real-time listeners, tombstones |
| Localisation | Complete: English, Spanish, Bosnian UI packs |
| AI pipeline | Complete: prompting, parsing, validation, budget, fallback |
| AI **weights** | **Not bundled**, and now optional. `npm run fetch-desktop-model` |
| Desktop inference | Real: `onnxruntime-node` in the main process, measured below |
| iOS / Android / web | Expo, standard |
| Windows / macOS | Electron around the web export, not native RN; both packaged |
| The views | 79 render tests; the web and desktop builds walked through by a browser |

All three platform bundles build: `npx expo export --platform web` and
`--platform ios --platform android` both complete, the latter through Hermes.
The web build and both desktop builds are also driven end to end by a real
browser — see Testing — so what is claimed below has been watched running, not
only compiled.

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
The same shell now ships for both: a `.dmg` for macOS alongside the Windows
installers, packaged and driven through the same 17-check walkthrough.

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

### Getting cards in

Three ways, none of which need an account or a network:

- **Type them.** "Add card" on a deck keeps the form open, so a run of cards
  goes in without a round trip through the list each time.
- **Paste a list.** "Paste a word list" takes `hablar - to speak` a line at a
  time, or tabs from a spreadsheet, or a CSV, or a Markdown table, or two lines
  per card with a blank line between. It shows what it made of the paste — the
  count, the separator it recognised, the first few cards, and any line it could
  not read — before writing anything. From a deck it adds to that deck and skips
  words already there; from the deck list it creates a deck and guesses the
  language from the words.
- **Paste just the words.** A list with no meanings on it at all is recognised
  as a list of words rather than mangled into one card. On the desktop app,
  "Look up the meanings" fills them in — the bilingual dictionary first, the
  model only for what the dictionary does not have — into an editable review
  list that says where each meaning came from. See
  [Looking up a word list](#looking-up-a-word-list).
- **Import from Anki.** A `.apkg` exported from Anki Desktop; see the collation
  note under Design notes for why that is harder than it sounds.

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
npm run desktop       # builds the web export, then packages for this platform
```

`apps/desktop` is deliberately outside the npm workspaces: Electron is a large
download and nobody working on the mobile app should pay for it on every
`npm install`.

That packages installers, which is slow and not how you would try a change out.
See [Building the desktop app](#building-the-desktop-app): `npm run desktop:refresh`
pushes a new build into an app you already have in about 30 seconds, with no
installer and nothing downloaded.

## Looking up a word list

A pasted vocabulary list often has no meanings on it — just the words. Two
things fill them in, in this order:

```
npm run fetch-dictionaries      # 45 MB: Spanish and Bosnian
npm run fetch-desktop-model     # 1.2 GB, optional: the long tail
npm run desktop:pack            # a build that can use them
```

**The dictionary answers almost everything.** It is built from Wiktionary by way
of kaikki.org, distilled into SQLite — which every platform here already reads —
and shipped as two files: 40 MB for Spanish, 5 MB for Bosnian. Lookup is about a
millisecond.

Measured on the same fourteen Spanish words the model was measured on:

| | Size | Right | Per word |
| --- | --- | --- | --- |
| Dictionary | 40 MB | 12 of 12 | 0.2 ms |
| Qwen2.5-1.5B q4f16 | 1.2 GB | ~10 of 14 | 1.4 s |
| Qwen2.5-0.5B int8 | 488 MB | ~0 of 14 | 0.25 s |

Two of that twelve are the interesting ones. `ponovili` is Bosnian and
`almadura` is a typo, both sitting in a Spanish list, and the dictionary says it
does not know them — which is the right answer and the one a model structurally
cannot give. Asked the same two, Qwen answered "repeat" and "marinade".

**Inflected forms resolve, which is why Wiktionary rather than a plain
dictionary.** The extract carries every conjugation as an entry pointing at its
lemma, so `comieron` finds `comer`, `tuviéramos` finds `tener`, and `molim`
finds `moliti`. Writing Spanish and Bosnian morphology by hand was the
alternative. Those pointers are stored in their own table with no gloss, because
665,709 rows each repeating "third-person plural preterite of…" is 39 MB of
saying what the lemma column already says.

**Bosnian exists only because Wiktionary files it as Serbo-Croatian**, together
with Croatian and Serbian. That is the whole reason this covers both of the
app's languages: FreeDict's Serbian is 398 headwords and its Croatian release
has no downloadable build, and WikDict has no bs, hr or sr at all.

**The model is the fallback, and its answers are labelled.** Anything the
dictionary misses goes to it, and it has two jobs: figure the word out, or fail
validation and be thrown away so the word comes back empty rather than wrong.
That ordering has a sharp edge worth stating — the model only ever sees what the
dictionary could not answer, which is the rare, the inflected and the misspelt,
and that is exactly where it is least reliable. So every row in the review list
says where its meaning came from. Dictionary rows can be skimmed; `model — check
this` is where to actually look. A blank is never imported.

If no model is installed, the dictionary alone is the normal case rather than a
degraded one, and the 1.2 GB stays undownloaded.

Both run in the Electron **main** process
([ai.js](apps/desktop/ai.js), [dictionary.js](apps/desktop/dictionary.js)): the
renderer has a content security policy because it draws user-supplied deck
content, `onnxruntime-node` is a native module, and a minute of decoding on the
UI thread would freeze the window. The renderer gets three functions over
`contextBridge` and no filesystem. The policy — dictionary first, model for the
rest, sources kept apart — is
[packages/core/src/ai/resolve.ts](packages/core/src/ai/resolve.ts), with the
lookup injected so it can be tested without either file present. The decode loop
is [decode.ts](packages/core/src/ai/decode.ts), shared with the phone.

Wiktionary is CC BY-SA. The attribution is written into a `meta` table in each
dictionary file so it travels with the data.

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

**A pasted list has no schema, so the separator is scored, not sniffed.** Word
lists arrive as tabs from a spreadsheet, commas from a CSV export,
`word - meaning` from a notes app, pipes from a Markdown table, or two lines per
card with a blank line between. Reading the first line and deciding is wrong
often enough to matter — the first line of a list is as likely to be a heading —
so every candidate separator is scored against the whole paste, preferring the
one that leaves exactly two sides on the most lines. Tabular separators (tab,
comma, pipe) treat a third column as a column and drop it, because that is where
Anki's CSV export puts tags; prose separators (`-`, `:`, `=`, `;`) split once, so
`casa - house, home` keeps its comma. A line that fits none of it is skipped and
shown with its line number rather than guessed at, and the count and the first
few cards appear before anything is written. The conviction is the AI parser's:
a wrong card is worse than a missing one.

**Two layouts, because the phone's does not survive being stretched.** The same
bundle runs on a phone, in a browser tab and in an 1100pt desktop window. Scaled
up unchanged, a deck row becomes a title at the far left of the window and a
badge at the far right with 800pt of nothing between them, and a flashcard
becomes one word adrift in an empty rectangle — the shape of a layout being
shown at a size it was not designed for. So above 900pt the deck list moves into
a sidebar, where a desktop app keeps its navigation, and the content pane is set
to a measure (680pt, roughly 75 characters) rather than to the window. The
sidebar follows Apple's guidance for the control: 248pt wide, inside the
225–275pt they give as a minimum, and the actions that operate on the list
gathered into a bottom bar rather than scattered above the content. Below 900pt
nothing changes — the phone keeps the navigation stack it had.

**Hiding the title bar means owning what it did.** `titleBarStyle: 'hidden'`
gives the app the whole window, and hands it two jobs macOS was doing. Close,
minimise and zoom are still painted over the top-left of the page, at
coordinates the page cannot query — which is exactly where a back arrow goes,
and where the header's was. And with no title bar there is nothing to drag the
window by until the page declares a region. Both are CSS a React Native style
object cannot express, so
[apps/mobile/src/ui/shell.ts](apps/mobile/src/ui/shell.ts) injects the rules
once and the layout references them by `data-` attribute; `trafficLightPosition`
in main.js and `TITLE_BAR_HEIGHT` there are a pair and have to move together.
This is not checkable by screenshot — the buttons are not part of the page — so
`verify:desktop` checks it as geometry instead, asserting that nothing the app
draws lands inside their rectangle, at both window widths.

**The cheap source goes first, and the expensive one inherits the hard cases.**
Dictionary before model is obvious on cost — a millisecond against 1.4 seconds —
and less obvious on quality: the dictionary is simply better at this, 12 of 12
against about 10 of 14, because single-word translation is lookup, not
reasoning. What took longer to see is that ordering them this way concentrates
every hard case on the weaker source. The model is asked only about words the
dictionary lacked, which are the rare, the inflected and the misspelt — where it
confabulates most. A chain that hid its sources would therefore be *worse* than
either source alone, because its worst answers would be indistinguishable from
its best. The review list labels every row instead.

**Two tokenizer families, and the newer one is not optional.** The BPE
tokenizer was written for Llama 2: metaspace markers, `<0xNN>` byte fallback,
one merge loop. Everything since — Llama 3, Qwen, Mistral's newer releases —
uses byte-level BPE instead, where every byte maps to a printable character (a
space is `Ġ`), there is no fallback because the vocabulary covers all 256 by
construction, and a regex splits the text before any merging happens. Supporting
Qwen meant supporting both, which is `byteLevel` in
[tokenizer.ts](packages/core/src/ai/tokenizer.ts). Two details cost time. Chat
markers have to be cut out *before* BPE — run `<|im_start|>` through the merge
loop and it becomes a handful of ordinary tokens the model has never seen in
that arrangement, so it answers, badly. And the split regex upstream uses an
inline `(?i:…)` group, which Hermes does not support: written out literally it
would have passed every test on Node and thrown on the phone.

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
npm test              # 232 unit and integration tests
npm run verify        # 26 checks end-to-end against the real server
npm run verify:web    # 23 checks driving the web build through Chrome
npm run verify:desktop  # 23 checks driving the packaged desktop app, 29 with dictionaries
```

`npm run verify` is the one to run when judging whether the *logic* works. It
starts the sync server, drives two simulated devices through the success
criteria over HTTP, imports a generated 60-card `.apkg`, takes a device offline
and back, and checks that conflicting edits converge.

`npm run verify:web` is the one to run when judging whether the *app* works. It
builds the web export, serves it, and walks Chrome through the brief: continue
without an account, create a Spanish deck, add cards, reveal, rate with the
keyboard, reload, switch the interface to Bosnian, and build a second deck out
of a pasted word list. `verify:desktop` does the same against the packaged
executable, which is how the `app://` scheme, the content security policy and
SQLite-outside-a-browser get exercised; `FLUENTFLOW_APP=/Applications/FluentFlow.app`
points it at an installed copy instead of the one in `dist/`, and
`FLUENTFLOW_DICTIONARY_DIR=<dir>` (and optionally
`FLUENTFLOW_MODEL_DIR`) adds six checks that drive real lookups through the
review flow, asserting that the dictionary answered and the model was not
needed — without them the same run checks that the app says it has nothing
installed rather than offering to look anything up. Both leave
screenshots behind as evidence.

The 79 view tests run under jest-expo in two projects, iOS and web, rather than
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

The pasted-word-list work turned up a bug of its own, and it was the parser's:
twelve words on twelve lines, with no separators and no blank lines, read as a
single paragraph — the first word became the front and the other eleven were
concatenated onto its back. One plausible-looking, entirely wrong card, which is
worse than an error, because nothing about it looks like a failure. The block
format now requires an actual blank line between two cards.

Adding the pasted-list walkthrough turned up a flaw in the walkthroughs
themselves. "Paste a word list" is on two screens — the deck list and a deck —
and expo-router keeps the screen underneath the current one mounted, so the
label matches twice. `waitForSelector(visible: true)` checks the *first* match,
which is the one on the hidden screen and never becomes visible: a button plainly
on screen timed out as missing. Both scripts now wait for any visible match and
click the last one.

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
  the views are covered by 71 render tests plus a browser walkthrough of the
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
- Neither desktop build is signed by a real identity. Windows also skips the
  executable resource edit — see below. The macOS build is ad-hoc signed, which
  is not a Developer ID and is not notarisation: a downloaded copy is
  quarantined and needs right-click → Open the first time.
- The macOS build has only been made and run on Apple Silicon. No x64 or
  universal build has been produced, so an Intel Mac is untested.
- The Windows walkthrough has not been re-run since `verify-desktop.mjs` changed
  how it finds a control (see Testing). The change is platform-independent DOM
  logic, but "should be fine" is not the same as having watched it.
- The wide layout has only been seen at 1100pt and 700pt, which is what
  `verify:desktop` drives. Nothing has looked at it on a 27-inch display, where
  a 680pt column sits in a great deal of window.
- The sidebar recounts every deck's due total whenever the deck list changes.
  That is one `count(*)` per deck and invisible at the scale anyone has tested;
  it is the wrong shape for someone with two hundred decks.
- Text import drops a third column rather than mapping it. Anki's CSV export
  puts tags there, and there is nowhere in the card model for them yet.
- **The model, when it is reached at all, is wrong about one word in three** and
  wrong most often on uncommon words. It is now the fallback rather than the
  path, and its rows are labelled, but nothing makes its answers trustworthy.
- Looking words up is desktop-only. The phone has ONNX Runtime but has never
  run it (see above) and no dictionary is shipped to it; the browser build has
  neither. Putting the dictionary on the phone is the obvious next step — it is
  a 5–40 MB SQLite file and expo-sqlite already reads those.
- The Spanish dictionary is 40 MB, which is mostly its 665,709 inflected forms.
  Dropping the rarest of them would trade coverage for size; no one has measured
  where that trade stops being worth it.
- Sense selection is a heuristic — interjections first, then shorter glosses.
  It fixes `zdravo` ("hello!", not "healthily") and `hvala` ("thank you!", not
  "praise"), and it still hands back "asset, history" for `habiendo`.
- Neither the model nor the dictionaries are checksummed after download. A
  corrupted file fails when it is opened rather than when it is fetched.
- Phase-2 items from the brief (deck sharing, TTS, image occlusion, streaks) are
  not started.

## Building the desktop app

```
npm run desktop           # installs Electron, builds, packages for this platform
npm run desktop:win       # ...or for Windows explicitly: installer + portable exe
npm run desktop:mac       # ...or for macOS: a .dmg
npm run verify:desktop    # launches the packaged app and drives it
```

That writes installers — two on Windows, a `.dmg` on macOS — and takes minutes.
It is the wrong loop for trying a change out.

Neither the dictionaries nor the model are in there.
`npm run fetch-dictionaries` and `npm run fetch-desktop-model` put them in the
app's user data directory instead; see
[Looking up a word list](#looking-up-a-word-list).

### Testing a new version without downloading one

A packaged FluentFlow is 386 MB on disk: 290 MB of Electron runtime, 88 MB of
ONNX Runtime binaries, and about 3 MB that actually changes between versions —
the web export, `main.js`, `preload.js` and `ai.js`. So a new version is a file
copy, not a download.

```
npm run desktop:pack               # once: an unpacked build, no installer
npm run desktop:refresh            # each version after: rebuild and push, ~30 s
npm run desktop:refresh -- --run   # ...and launch it
```

`refresh` updates every packaged FluentFlow it can find — the unpacked build in
`dist/`, an installed copy under `%LOCALAPPDATA%/Programs/FluentFlow`, and
`/Applications/FluentFlow.app` or `~/Applications` on macOS — so the entry on
the Start menu or in the Dock can be kept current without ever downloading
anything. This works only because `asar: false` is set: the app files sit loose
on disk instead of sealed inside an archive. It refuses to write into a copy
that is currently running, and it cannot update the portable exe at all, which
unpacks itself into a temporary directory on every launch.

On macOS the payload lives inside the bundle, at `Contents/Resources/app`, which
the bundle's code signature covers — so `refresh` re-signs ad hoc afterwards and
`codesign --verify` keeps passing.

An Electron version bump still needs a real rebuild. Nothing else does.

For UI work there is a faster loop again: `npm run web` in one terminal and
`npm run desktop:dev` in another points the shell at the Metro dev server, and a
save shows up in the window straight away. That is not the packaged code path,
though — the `app://` scheme and the production CSP only exist in a real build —
so confirm anything shell-shaped with `refresh` before believing it.

### Two macOS notes

**Ad-hoc signing is done deliberately, and is not Gatekeeper.** `identity: null`
tells electron-builder not to hunt for a Developer ID it will not find, and what
that leaves is not cleanly unsigned: the Electron binary keeps the linker's own
ad-hoc signature, which declares that the bundle has sealed resources when it
has none. `codesign --verify` refuses it with "code has no resources but
signature indicates they must be present". `apps/desktop/scripts/after-pack.cjs`
therefore signs the finished bundle ad hoc, which makes it self-consistent and
matches the state `desktop:refresh` restores. It buys nothing with Gatekeeper —
ad-hoc is not a Developer ID and nothing is notarised, so a downloaded copy is
still quarantined and still needs right-click → Open.

**A broken seal is not what stops an app from launching.** Writing into
`Contents/Resources` invalidates the signature, and the obvious conclusion — that
macOS will refuse to start it — is wrong for the builds here: a locally built,
never-quarantined copy launches with an invalid seal without complaint. It is
quarantine that Gatekeeper acts on. Worth knowing before spending an afternoon
on signing when the actual problem is elsewhere.

### Two notes that apply everywhere

**A nested `npm install` inherits the outer npm's config.** `npm run` exports
every setting as `npm_config_*`, and the inner install reads those back as if
they had been typed on its command line — so a user-level `allow-scripts`
setting (Claude Code's installer writes one) reaches it as `--allow-scripts`,
which npm 11 refuses in a project-scoped install with `EALLOWSCRIPTS`. The
desktop scripts therefore go through
[scripts/desktop-build.mjs](scripts/desktop-build.mjs), which strips it and
lets `apps/desktop/package.json`'s own `allowScripts` field decide instead.

**A file missing from electron-builder's `files` list fails silently.** Adding
`dictionary.js` to the main process and forgetting to add it to the bundle
produced an app that started, opened no window, and printed nothing at all — not
the missing-module error, not a crash, nothing. `--enable-logging` added no
output either. The `files` list is a pattern now (`*.js`) rather than a roll
call, so a new main-process file cannot be left out of it.

**`ELECTRON_RUN_AS_NODE` must not be set.** Editors built on Electron — VS Code
among them — export it for their own child processes, and any Electron binary
that inherits it runs as plain Node: no window, no `protocol`, and an immediate
exit with status 0. It imitates a broken build convincingly enough to send you
looking at asar and code signing first. Every script here strips it before
spawning Electron — that is the whole reason `apps/desktop/scripts/launch.mjs`
exists — so `npm start`, `desktop:refresh --run` and the verification scripts are
immune to it. A bare `npx electron .` is not.

### One Windows-specific note, learned the hard way

**The build skips the executable resource edit.** electron-builder fetches a
signing toolchain whose archive contains macOS symlinks, and Windows refuses to
create those without Developer Mode or an elevated prompt, so the extraction
fails and takes the build with it. Nothing here is signed anyway, and asking
every contributor to change a Windows setting is worse than losing the version
metadata stamped into the exe. `signAndEditExecutable: false` now sits in the
build config rather than in a `dist:win:unsigned` script, so every way of
building for Windows gets it.

