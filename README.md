# FluentFlow

A desktop flashcard app for language learning: spaced repetition over vocabulary
decks, with example sentences generated on the device rather than by an API,
Anki `.apkg` import, decks built from a pasted word list, and last-write-wins
sync across devices.

```
npm install
npm run build          # build the shared core package
npm test               # 326 tests
npm run verify         # end-to-end check of the success criteria
npm run verify:web     # the same criteria, driven through Chrome
npm run server         # sync API on :8787 (no Firebase project needed)
npm run web            # the app in a browser tab (Metro dev server)
npm run dev            # local API + web app, opens Chrome, Fast Refresh enabled
```

A packaged Windows build is on the
[releases page](https://github.com/alanreyes24/fluentflow/releases): a portable
executable that needs no installation, and an installer. Both are unsigned, so
SmartScreen asks for **More info → Run anyway** the first time.

macOS builds from the same command — `npm run desktop:mac` writes
`FluentFlow-0.1.0-arm64.dmg` (Apple Silicon; see the Intel note under Known
gaps). The bundle carries a real icon, a hardened runtime and its entitlements,
and is signed — but ad-hoc, not with a Developer ID, so a downloaded copy is
still quarantined and the first launch needs **right-click → Open**. The signing
and notarization pipeline is wired and one environment-variable set away from
producing a notarised build (see the macOS notes under Building the desktop
app). Nothing has been uploaded to the releases page for macOS yet.

Nothing above needs a Firebase project or the model weights. The server starts
in local mode with an in-memory store, and examples fall back to written
sentences until a model is installed. Both are covered below.

## Layout

```
packages/core      domain logic, no platform dependencies — 168 tests
apps/server        Express + Firestore sync API and Anki import — 17 tests
apps/mobile        the app's UI: an Expo app (iOS, Android, web export)
apps/desktop       Electron shell: Windows packaged, macOS configured — 12 tests
scripts            dictionaries, icon generation, end-to-end verification
docs               where each platform stands, and how to walk it on a phone
```

`packages/core` holds everything that is neither UI nor I/O: Anki's scheduler,
the `.apkg` parser, the pasted-text parser, sync merge, prompt construction,
output parsing and the hosted-model client. It is plain TypeScript with one dependency (`fflate`), which is why
it can be tested with `node --test` and reused unchanged by the app, the server
and the scripts. When the app and the server disagree about how a card should be
scheduled, there is one place to look.

## What works, and what is stubbed

Being direct about this, because "local AI" is the part most likely to be
misread:

| Area | State |
| --- | --- |
| Scheduling | Anki's SM-2 (v3) scheduler: learning steps, lapses, leeches, fuzz |
| `.apkg` import | Complete for schema 11 and 18; zstd exports rejected with a fix |
| Text import | Complete: separator detection, live preview, per-line reporting |
| Word lists | Complete: a list with no meanings is looked up, then reviewed |
| Dictionaries | Complete: Spanish and Bosnian, from Wiktionary, `npm run fetch-dictionaries` |
| Local SQLite | Complete: migrations, indexes, soft deletes, review log |
| Sync | Complete: LWW, offline queue, real-time listeners, tombstones |
| Statistics | Complete: streaks, retention, study calendar, forecast, per-deck mastery |
| Localisation | Complete: English, Spanish, Bosnian UI packs |
| AI pipeline | Complete: prompting, parsing, validation, budget, fallback |
| AI **key** | **Yours**, and optional. Paste it into Settings; free tier covers a personal deck |
| Generation | Real: Gemini 3.1 Flash-Lite, called from the main process — meanings *and* examples, measured below |
| iOS / Android / web | Expo, standard |
| Windows / macOS | Electron around the web export, not native RN. Both packaged; the shell imports `.apkg` locally |
| The views | render tests, and the web and desktop builds walked through by a browser |

The web build and both desktop builds are driven end to end by a real browser —
see Testing — so what is claimed below has been watched running, not only
compiled.

Where each platform actually stands — built, run, verified, shippable — and what
is left on each, is in [docs/platform-status.md](docs/platform-status.md). iOS
and Android build but have never run on hardware;
[docs/device-checklist.md](docs/device-checklist.md) is the walkthrough for
changing that with Expo Go, and `npm run sample-deck` writes the Anki archive it
needs.

The AI integration is real code — prompt construction per language, a response
schema, a parser that degrades through four extraction strategies, and
validation that throws away a sentence not containing the word it was meant to
demonstrate. What is not in the repository is an API key.

It goes in Settings, is stored in the OS keychain, and is used from Electron's
main process — the renderer is a plain web build that draws user-supplied deck
content and must never hold a credential. Until a key is present
`generateExamples` uses its fallback and the UI says so.

**This used to run a 1.2 GB Qwen2.5-1.5B locally under `onnxruntime-node`, and
that code is gone.** It worked, and the measurements are kept below because they
are the argument: it answered about ten words in fourteen against the
dictionary's twelve in twelve, took 5–7 s a card against about 1.9 s, wrote
Bosnian that was not really Bosnian, pinned the macOS build to arm64 because
onnxruntime-node ships no x64 binary, added 88 MB to the installer and 283 MB to
`node_modules`, and created its inference session on the main thread — which is
Chromium's browser process, so a cold start stalled window input for seconds.
A hosted Flash-Lite costs about five cents per thousand cards and is better on
every one of those axes except working on a plane.

[apps/desktop](apps/desktop) wraps the web export in Electron, which gives a real
installable app for Windows and macOS from one codebase. The same shell ships for
both: a `.dmg` for macOS alongside the Windows installers, packaged and driven
through the same 17-check walkthrough.

What that wrapping costs, and what it buys back, is worth being specific about.
Inside the shell `Platform.OS` is `web`, so the app takes the browser's path
everywhere — and the browser's Anki import hands the file to the sync server,
because a browser has no SQLite that can mount a collection from bytes. On the
desktop that made import unreachable in practice: it wanted a running server
*and* a signed-in account, for a `.apkg` already on the disk.

Electron 44 ships Node 24, where `node:sqlite` is unflagged, so the main process
runs the same `parseApkg` from core that the server does
([apps/desktop/src/apkg.js](apps/desktop/src/apkg.js)). Import is local, offline
and account-less: choose a file, drag one onto the window, or double-click a
`.apkg` in Explorer and the app opens with it. The app branches on a capability
the shell advertises rather than on `Platform.OS`, which lies in here.

The shell also does the things a wrapped web page cannot do for itself — remember
its size, position and zoom; paint the right background before the bundle loads,
by being told which theme the app rendered rather than guessing from the OS;
refuse to open a second window over the same database. The page's whole view of
it is one preload bridge
([apps/desktop/preload.js](apps/desktop/preload.js)); there is no filesystem
access and no general IPC, because the renderer draws deck content it did not
write.

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
npm run web           # the app in a browser tab
npm run dev            # both together at http://localhost:8081, opened in Chrome
```

Local mode exists so the app is demonstrable before anyone provisions Firebase.
When running `npm run dev`, a `GEMINI_API_KEY` in the repo's gitignored `.env`
is loaded by the local API and used through a server-side proxy; it is never
bundled into the browser. Restart the command after changing `.env`.
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
  as a list of words rather than mangled into one card. The dictionary fills in
  meanings automatically, free and offline; anything it misses is offered to
  Gemini with a cost estimate and confirmation before it is sent. See
  [Looking up a word list](#looking-up-a-word-list).
- **Import from Anki.** A `.apkg` exported from Anki Desktop; see the collation
  note under Design notes for why that is harder than it sounds.

### With Firebase

The free personal sync setup is already configured for the `fluentflow-47e21`
Firebase project. It uses Spark-plan Hosting, Email/Password auth, and
Firestore. The public web app is at <https://fluentflow-47e21.web.app>.

For a fresh checkout, copy `.env.example` to `.env` and fill in the Firebase
web-app values from Firebase Console → Project settings → General → Your apps.
These are browser-safe Firebase configuration values; never put a service
account JSON or private key in the app bundle.

Deploy the web app and sync rules with:

```bash
npx firebase-tools login
npm run firebase:deploy
```

The same Firebase configuration is used by the browser export and the Electron
desktop shell, so signing in with the same account keeps Windows, macOS, and
browser data synchronized.

Or run against the emulator suite: `firebase emulators:start`, then uncomment
`FIRESTORE_EMULATOR_HOST` in `.env`.

### Desktop

```
npm run desktop       # builds the web export, then packages for this platform
```

`apps/desktop` is deliberately outside the npm workspaces: Electron is a large
download and nobody working on the core or the server should pay for it on every
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
npm run desktop:pack            # a build that can use them
```

**The dictionary runs automatically.** It answers the pasted list for free and
offline. Only words it cannot find are offered to Gemini, and the screen shows
the model, the exact number of words, and a conservative cost estimate before
asking for confirmation. Meanings are assigned automatically; there are no
manual meaning fields. Words neither source can resolve are skipped instead of
becoming blank cards.

**The dictionary answers almost everything.** It is built from Wiktionary by way
of kaikki.org, distilled into SQLite — which the app already reads — and shipped
as two files: 40 MB for Spanish, 5 MB for Bosnian. Lookup is about a
millisecond.

Measured on the same fourteen Spanish words the model was measured on:

| | Size | Right | Per word |
| --- | --- | --- | --- |
| Dictionary | 40 MB | 12 of 12 | 0.2 ms |
| Qwen2.5-1.5B q4f16, on-device | 1.2 GB | ~10 of 14 | 1.4 s |
| Qwen2.5-0.5B int8, on-device | 488 MB | ~0 of 14 | 0.25 s |

The two local rows are why the on-device model was removed. They are kept
because they are the evidence, not nostalgia: a dictionary that answers
everything correctly in a fifth of a millisecond makes a gigabyte of weights a
strange thing to ship for the sake of the four words it gets wrong.

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

**The model is the fallback.** Anything the dictionary misses is sent only after
the user confirms, and it has two jobs: figure the word out, or fail validation
and be thrown away so the word comes back unresolved rather than wrong. That
ordering has a sharp edge worth stating — the model only ever sees what the
dictionary could not answer, which is the rare, the inflected and the misspelt.
Unresolved words are skipped rather than becoming blank cards.

The dictionary is read, and the model called, in the Electron **main** process
([ai.js](apps/desktop/ai.js), [dictionary.js](apps/desktop/dictionary.js)): the
renderer has a content security policy because it draws user-supplied deck
content, and it must never hold the API key. The renderer gets a handful of
functions over `contextBridge`, no filesystem, and no way to read the key back.
The policy — dictionary first, model for the rest, sources kept apart — is
[packages/core/src/ai/resolve.ts](packages/core/src/ai/resolve.ts), with both
the lookup and the inference injected so it can be tested with neither a
dictionary file nor a network anywhere near it.

A word list that the dictionary covers completely makes no network request at
all: `resolve` peeks first and only builds a client if something is left over.
Its `useModel` flag is the stronger version of the same promise — the import
screen's first pass passes `false`, so that pass cannot reach the network
whatever the word list turns out to contain.

Wiktionary is CC BY-SA. The attribution is written into a `meta` table in each
dictionary file so it travels with the data.

## Writing example sentences

Revealing a card asks the model for two sentences using the word. Same model and
same process as the long tail of the lookup above — but almost every setting
differs, because the two jobs are not the same job.

```
GEMINI_API_KEY=... npm run check-cloud-model   # verify a key before trusting it
```

Get a key free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
check it, then paste it into Settings → Cloud examples. The check script runs one
real request through the actual pipeline and prints the sentences, the latency
and the cost computed from the API's own token counts.

Measured on `gemini-3.1-flash-lite`, six words across both languages:

| | Cost |
| --- | --- |
| Two sentences, per card | 0.6–3.3 s, 1.9 s average |
| Tokens | ~84 in, ~22 out |
| Money | $0.000054 a card — **$0.05 per 1000 cards** |
| The same card again | 0 ms, $0 — cached by word in SQLite |

The generation is charged once per *word*, not per card or per review: the
result is written to `example_cache` and onto the card, so it syncs to the
user's other devices and a word appearing in two decks is generated once. A
thousand-word deck costs five cents, once, ever — and the free tier covers a
personal deck outright.

**Here the model has no competition, so it is the source rather than the
fallback.** That is the reverse of the lookup, and not an inconsistency: no
dictionary contains a sentence. What keeps it honest is the same validation
either way — core rejects a candidate that does not contain the word it was
meant to demonstrate, tolerating inflection, so a sentence about a word the
model has quietly changed never reaches a card. Six words out of six came back
usable when measured; the seventh, had there been one, would have been thrown
away rather than shown.

**Why this model.** `gemini-2.5-flash-lite` is cheaper on paper ($0.10/$0.40 per
million tokens against $0.25/$1.50) and was the first choice — but Google has
closed it to new keys, and it fails in the most annoying possible way: it appears
in a model listing and then refuses the request. `gemini-3.5-flash-lite` is both
newer and dearer ($0.30/$2.50) and measured no better at this. So the default is
a model that was measured, not the cheapest row in a pricing table, and the field
in Settings is editable because model names age faster than releases do.

**Asking for no thinking is worth doing, and cannot be done by model name.**
Thinking tokens bill as output at the dearer rate, and "write two short
sentences" needs none. But `gemini-3.1-flash-lite` accepts `thinkingBudget: 0`,
`gemini-3.5-flash-lite` rejects the entire request with a flat "invalid
argument", and the Pro models have a floor above zero. Rather than keep a list
that goes stale every release,
[remote.ts](packages/core/src/ai/remote.ts) tries it once and turns it off for
good on a 400. The cost of being wrong is one retried request per app run.

**The response schema replaced a pile of prompt engineering.** Asked for a JSON
array with `responseMimeType: application/json` and an array-of-strings schema,
the answer arrives parseable every time and ends at the closing bracket. The
parser's four fallback strategies — bracket scanning, quoted spans, bare lines —
are still there and still tested, because they cost nothing and the local model
needed all of them. Stop sequences are *not* sent alongside a schema: they can
only truncate valid JSON into invalid JSON.

**One attempt, not two.** The local path retried on a parse failure because a
1.5B returned usable JSON about two-thirds of the time and the retry was free.
A hosted retry is a second billed request for something that arrived correctly
the first time, so `retryOnParseFailure` is off. Core still keeps the best
partial answer, so a short result is not thrown away.

**Spanish is good, and Bosnian is now good too.** This is the clearest win from
the change. The local 1.5B wrote `Naravno je da je knjiga prazanje za glasne
ljudi.`, which is not a sentence; Flash-Lite writes `Ova knjiga je veoma
zanimljiva za čitanje.` Bosnian was thin in a 1.5B's training data for the same
reason it was thin in the dictionaries, and a larger model simply does not have
that problem.

The budget is 10 s, down from the 30 s a CPU decode loop needed. Against a
measured 0.6–3.3 s, anything past ten is not a slow answer but a network that is
not going to produce one, and a carrier sentence is waiting behind it.

**The key is the user's, and it never enters the bundle.** The app is packaged
with `asar: false`, so a key compiled in would be a key published on disk to
everyone who installs it. What is stored instead is what the user pastes,
encrypted with `safeStorage` — macOS Keychain — in
`Application Support/FluentFlow/cloud.json` at mode 0600. The preload bridge has
a setter and no getter: the key is read and used in the main process, and the
renderer, which draws user-supplied deck content, receives finished sentences and
never the credential. `npm run verify:desktop` asserts that from inside the page.

**Generation is still prefetched, and that is now almost free.** A study session
knows its whole queue, so the three cards ahead of the one on screen are
generated before they are revealed — measured at 6/6 reveals already finished
when the local model was doing the work, and a hosted call is five times faster
than that. See `PREFETCH_DEPTH` in
[service.ts](apps/mobile/src/ai/service.ts). Nothing is wasted: results go to
`example_cache`, so a prefetch the session never reaches is a reveal paid for
early rather than a request thrown away.

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

**The scheduler is Anki's, not the SM-2 paper's.** Cards here move between
decks and Anki through `.apkg`, and a card that schedules differently on the two
sides is a card the import quietly damaged. So
[packages/core/src/scheduler.ts](packages/core/src/scheduler.ts) is a port of
Anki's v3 scheduler rather than of Wozniak's 1990 algorithm, which it only
resembles: a card is in one of four phases — new, learning, review, relearning —
new cards walk the 1m/10m learning steps before earning a day-level interval,
ease moves by fixed deltas (again -0.20, hard -0.15, good 0, easy +0.15) rather
than by SM-2's quadratic in the grade, `good` is credited half the days a card
was overdue and `easy` all of them, `hard` is a flat 1.2 that ignores ease, a
lapse takes the interval to the lapse multiplier (0% by default) and walks the
10m relearning step, eight lapses make a leech, and every day-level interval is
fuzzed so a batch reviewed together does not stay together. Anki's own defaults
are the defaults, and every one of them is a field on `SchedulerConfig` so
per-deck options can be added without touching the algorithm.

Two things Anki does that this does not. Anki rolls the day over at 4am and
schedules review cards to a day number; `nextReview` here is an instant and
"days late" is elapsed 24-hour periods, which differs only for someone
answering within hours of a rollover. And Anki's per-deck new/review daily
limits are not implemented — that is queue building rather than scheduling, and
the study screen builds the queue. What the study screen does implement is the
other half of learning steps: a card answered onto a step ten minutes out comes
back at the end of the same session, because steps that never come back are
just a slower way of burying a card.

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

**One layout, and a toolbar that does not move.** The same bundle runs in a
narrow window, in a browser tab and in an 1100pt desktop window, as a single
column: a title strip for the window buttons, the screen you are looking at, and
a toolbar along the bottom of the window. The toolbar holds what belongs to the
app rather than to a screen — New deck, Paste a word list, Import from Anki,
Settings, and sync status at the trailing edge, which is where a Mac app puts
status — so those four stay in one place instead of appearing and disappearing
as screens change. Decks are navigated to rather than listed alongside the
content, which is what keeps the layout the same at every width. What the 900pt
breakpoint still changes is only fit: the content pane is set to a measure
(680pt, roughly 75 characters) rather than to the window, padding opens up, and
controls tighten to desktop proportions. That column is centred in the window,
with the stack's title centred over it — it used to hug the leading edge, which
was right while a sidebar sat beside it and reads as content that fell over
once the sidebar is gone.

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
its best. The paste screen makes that boundary visible and asks for confirmation
before any of those hard cases are sent.

**The on-device model was built, measured, and then deleted.** A BPE tokenizer
with byte-level and metaspace variants, a decode loop over an ONNX graph with KV
cache reuse, greedy and sampled paths, per-family chat templates — all of it
worked, and all of it is gone. What killed it was not that it was hard but that
the measurements came in: against a 0.2 ms dictionary lookup and a 1.9 s hosted
call costing five thousandths of a cent, a 1.2 GB download that answered ten
words in fourteen, froze the window while its session loaded, and pinned macOS
to arm64 had no axis left to win on. The lesson worth keeping is that the seam
survived the swap — everything platform-specific was behind one `InferenceFn`,
so replacing the entire backend touched the prompt layer and nothing else.

**Keeping the dictionary local was the other half of that decision.** It is the
common path, it is faster than a network round trip by four orders of magnitude,
it costs nothing, and it is the only source in the system that can say "I don't
know". Moving *everything* to the cloud would have been simpler and worse.

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
npm test              # 326 unit and integration tests
npm run verify        # 26 checks end-to-end against the real server
npm run verify:web    # 27 checks driving the web build through Chrome
npm run verify:desktop  # 37 checks driving the packaged desktop app
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
`FLUENTFLOW_DICTIONARY_DIR=<dir>` adds six checks that drive real lookups
through the review flow, asserting that the dictionary answered and the model was
not needed — without it the same run checks that the app says it has nothing
installed rather than offering to look anything up. A `GEMINI_API_KEY` in the
repo's gitignored `.env` is picked up automatically and makes the reveal check
drive a real, billed request against the hosted model instead of asserting the
offline frames. Both leave screenshots behind as evidence.

The 79 view tests run under jest-expo, and the repository they run against is
real SQLite through `node:sqlite`, so pressing "Good" in a test runs the same
scheduling code the app runs.

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

- Example generation needs an API key, as described above, so until one is
  pasted into Settings every reveal falls back to a written sentence. The web
  build (with no Electron shell) always does, because there is nowhere safe to
  keep a key in a page that draws deck content.
- Generation now needs a network. Reviewing offline still works — sentences live
  on the card and in `example_cache` — but a deck imported on a plane gets
  carrier frames until it is online. This is the one thing the on-device model
  did better, and it was traded knowingly.
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
  executable resource edit — see below. The macOS build runs the hardened
  runtime with its entitlements and is signed, but ad-hoc: not a Developer ID
  and not notarised, so a downloaded copy is quarantined and needs right-click →
  Open the first time. `APPLE_IDENTITY` (plus a certificate and the `APPLE_*`
  notarization vars) switches on real signing without any code change — see the
  macOS notes below.
- macOS builds arm64 only. This *was* a hard limit — `onnxruntime-node` dropped
  its macOS-x64 binary after 1.22, so an Intel build would have had no inference
  backend — and with that dependency gone it is now just a build setting that
  nobody has flipped. Adding `"x64"` to the `mac` targets in
  [apps/desktop/package.json](apps/desktop/package.json) should be the whole
  change; it is listed here because it is untested, not because it is blocked.
- Auto-update is configured (`electron-updater`, GitHub Releases feed). On
  Windows it works once a release is published. On macOS Squirrel.Mac requires a
  Developer ID signature, so it stays inert until real signing is switched on —
  the wiring is already there.
- The Windows walkthrough has not been re-run since `verify-desktop.mjs` changed
  how it finds a control (see Testing). The change is platform-independent DOM
  logic, but "should be fine" is not the same as having watched it.
- The layout has only been seen at 1100pt and 700pt, which is what
  `verify:desktop` drives. Nothing has looked at it on a 27-inch display, where
  a 680pt column sits in a great deal of window.
- The deck list recounts every deck's due total whenever the deck list changes.
  That is one `count(*)` per deck and invisible at the scale anyone has tested;
  it is the wrong shape for someone with two hundred decks.
- Text import drops a third column rather than mapping it. Anki's CSV export
  puts tags there, and there is nowhere in the card model for them yet.
- **The model, when it is reached at all, is wrong about one word in three** and
  wrong most often on uncommon words. It is now the fallback rather than the
  path, and its rows are labelled, but nothing makes its answers trustworthy.
- Looking words up needs the Electron shell: the dictionary and the model both
  run in the main process, so a plain browser tab has neither and offers no
  lookup.
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
npm run desktop:mac       # ...or for macOS: a .dmg (plus a .zip for auto-update)
npm run verify:desktop    # launches the packaged app and drives it
```

That writes installers — two on Windows, a `.dmg` on macOS — and takes minutes.
It is the wrong loop for trying a change out.

The app icon lives at `apps/desktop/build/icon-source.png` (a 1024² PNG);
`npm --prefix apps/desktop run make-icon` regenerates `build/icon.icns` and
`build/icon.png` from it, which are committed so the packaged build never
depends on `iconutil`. The one committed now is a placeholder.

The dictionaries are not in there. `npm run fetch-dictionaries` puts them in the
app's user data directory instead, alongside the stored API key; see
[Looking up a word list](#looking-up-a-word-list).

### Testing a new version without downloading one

A packaged FluentFlow is about 300 MB on disk: nearly all of it Electron
runtime, and about 3 MB that actually changes between versions — the web export,
`main.js`, `preload.js`, `ai.js` and `cloud.js`. So a new version is a file copy,
not a download. (It was 386 MB until the 88 MB of ONNX Runtime binaries went with
the on-device model.)

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

### Three macOS notes

**Ad-hoc signing is the default, and is not Gatekeeper.** `identity: null` tells
electron-builder not to hunt for a Developer ID it will not find, and what that
leaves is not cleanly unsigned: the Electron binary keeps the linker's own
ad-hoc signature, which declares that the bundle has sealed resources when it
has none. `codesign --verify` refuses it with "code has no resources but
signature indicates they must be present". `apps/desktop/scripts/after-pack.cjs`
therefore signs the finished bundle ad hoc — now with `--options runtime` and
`build/entitlements.mac.plist`, so an ad-hoc build behaves the same as a
Developer-ID one would (ONNX Runtime JITs, and needs `allow-jit` +
`disable-library-validation` under the hardened runtime). It matches the state
`desktop:refresh` restores. It still buys nothing with Gatekeeper — ad-hoc is
not a Developer ID and nothing is notarised, so a downloaded copy is still
quarantined and still needs right-click → Open.

**Turning on real signing is configuration, not code.** Set `APPLE_IDENTITY` to
the Developer ID name and supply the certificate (login keychain, or `CSC_LINK`
+ `CSC_KEY_PASSWORD`); `scripts/desktop-build.mjs` then overrides the null
identity and enables `mac.notarize`, and `after-pack.cjs` steps aside. For
notarization also set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`. The `mac.hardenedRuntime` / `entitlements` keys are already in
`package.json` waiting for that. Once a signed, notarised build is published to
GitHub Releases, `electron-updater` starts working on macOS too.

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
