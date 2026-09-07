# Platform status

Where each target actually stands. The README says what the app does; this says
which platforms it has been watched doing it on, which is a shorter list.

Current as of 7 September 2026.

## Stages

Most of the disagreement about whether a platform is "done" comes from
collapsing these four into one word:

| Stage | Means |
| --- | --- |
| **Builds** | the bundle compiles and exports |
| **Runs** | someone launched the real artifact and used it |
| **Verified** | a script drives the real artifact and fails if it breaks |
| **Distributable** | a stranger could install it without being warned off |

| Platform | Builds | Runs | Verified | Distributable |
| --- | --- | --- | --- | --- |
| Web | yes | yes | yes, 22 checks | yes, once hosted |
| Windows | yes | yes | yes, 35 checks | unsigned only |
| iOS | yes | **never** | no | no |
| Android | yes | **never** | no | no |
| macOS | **never attempted** | no | no | no |

Windows is the only desktop platform that exists as an artifact. iOS is the only
platform where the on-device model could ever run. Neither of those is true of
the other.

## Windows: packaged, driven, unsigned

The furthest along, and the only target besides web that has been watched
running.

**The shell.** [apps/desktop/main.js](../apps/desktop/main.js) is a complete
Electron host, not a placeholder. The web export is served over a custom `app://`
scheme registered as `standard` and `secure`: `standard` gives it a real origin
so client-side routing works, `secure` is what makes IndexedDB available, which
expo-sqlite's web backend requires. Unknown paths fall back to `index.html` so
deep links resolve, and anything resolving outside the export directory is
refused. The CSP is applied as a response header rather than a meta tag, the
renderer runs with `contextIsolation` on, `nodeIntegration` off and `sandbox` on,
and `will-attach-webview` is unconditionally blocked. `connect-src` allows
Firebase's hosts and loopback — the latter because `app.json` ships pointing at
`http://localhost:8787`, and without it every request to a sync server the user
is running fails as a policy violation, which reads as the server being down.

**The artifacts.** `npm run desktop` produces both an NSIS installer and a
portable executable, 110 MB each. Both currently sit in `apps/desktop/dist/`
alongside `win-unpacked/`. `asar: false` is deliberate: it is what lets
`npm run desktop:refresh` push a ~3 MB update into an already-installed copy
instead of rebuilding a 110 MB installer.

**Anki import runs here, not on the server.** The renderer is the web export, so
the app's own import path defers to the sync server — a browser has no SQLite
that can mount a collection from bytes. That made import unreachable on Windows
in practice: it needed a running server *and* a Firebase account, for a file
already on the disk, and the shell's CSP did not even allow `localhost`.

Electron 44 ships Node 24, where `node:sqlite` is unflagged, so
[apps/desktop/src/apkg.js](../apps/desktop/src/apkg.js) runs the same `parseApkg`
from core that `apps/server/src/sqlite.ts` does. The file reaches it four ways —
the picker, the File menu, a drop on the window, or a `.apkg` opened in Explorer,
which starts the app — and the language and subdeck choices are still offered
before anything is written. The renderer never names a path the user did not
choose: the main process keeps the set of files that arrived from a dialog, a
drop or the command line, and refuses anything else.

Core is vendored into the shell by
[scripts/vendor-core.mjs](../scripts/vendor-core.mjs), because `apps/desktop` is
installed outside the workspaces and electron-builder copies only what a
package's own dependencies declare.

**The rest of the shell.** The window remembers its size, position, maximised
state and zoom, and refuses to restore a position on a monitor that is no longer
attached. The app tells the shell which theme it rendered, which is what colours
the window background before the bundle loads and the title bar afterwards —
`nativeTheme` knows what Windows prefers, not that this user forced light inside
the app. A single-instance lock means a second launch hands over its command line
and exits rather than opening a second window over the same SQLite database.
Settings names the build and says plainly that example sentences here are
written rather than generated, which is permanent and not an install away.

**The evidence.** [scripts/verify-desktop.mjs](../scripts/verify-desktop.mjs)
launches the packaged executable with a debugging port and drives the real
renderer over the DevTools protocol. Thirty-five checks, including that the
window is served over `app://` and not `file://`, that a deep link resolves
rather than landing on a blank page, that a deck survives a reload because it
went to SQLite, that the statistics screen reads that review back as a day
streak — computed from the machine's own calendar days rather than a test's —
with its retention, rating split and study calendar drawn, that a second copy
hands over its file and exits, that a 60-card `.apkg` opened from Explorer
imports with no server and no account, that a relaunch opens at the remembered
size, that the CSP does not block the app, that the renderer logged no errors,
and that the process did not crash. It runs against a throwaway user-data
directory each time, so it sees the empty state rather than the previous run's
deck. Screenshots land in `.desktop-shots/`.

Twelve more tests run in plain Node against the shell's own modules
([apps/desktop/test](../apps/desktop/test)): the importer, over real archives
built by the same fixture helper core and the server use, and the window-bounds
decision, over monitor arrangements that are awkward to plug in.

One route into the importer is *not* covered: dropping a file on the window.
Everything downstream of it is — the drop handler resolves a path and then joins
the same queue the command line does, which the walkthrough drives — but the drop
itself needs a real `File` with a real path behind it, and neither the DevTools
protocol nor a synthetic event can produce one. So the handler in `preload.js`
has been written and reviewed and never watched working, which on the scale at
the top of this document is "builds", not "runs". Dragging a `.apkg` onto the
window is the one-minute check nobody has done.

**What is left.**

- **Unsigned.** SmartScreen shows "More info, Run anyway" on first launch. This
  is the single largest barrier to anyone else installing it, and a certificate
  is the only thing that removes it.
- **No auto-update.** No update channel is configured, and no `electron-updater`
  is wired in. `desktop:refresh` is a developer tool, not a distribution
  mechanism, and it cannot touch the portable executable at all, which unpacks
  itself into a temporary directory on every launch.
- **No on-device AI, permanently.** `onnxruntime-react-native` is a native mobile
  module, so the desktop build always uses the written-sentence fallback. Settings
  now says so in those words rather than "not installed". That is a property of
  the Electron approach, not a gap to close.
- **The installer claims no file association, on purpose.** Opening a `.apkg`
  with FluentFlow works, and Explorer's "Open with" is how you ask for it. The
  installer does not register `.apkg` itself: that extension is Anki's, and an
  installer that quietly takes it over from the app the decks were exported from
  is the wrong default. It is a one-line `fileAssociations` entry if that
  judgement changes.
- The README links a GitHub releases page for the packaged builds. Whether a
  release is actually published there, and whether it matches the artifacts in
  `dist/`, has still not been checked — `gh` is not authenticated on this machine.

**What is no longer left.** The executable used to carry no version metadata and
Electron's own icon, because `signAndEditExecutable=false` disabled the resource
edit along with the signing that could not run.
[apps/desktop/scripts/stamp-executable.js](../apps/desktop/scripts/stamp-executable.js)
now does that edit with `resedit`, in JavaScript, needing no privileges; the
packaged `FluentFlow.exe` reports its own name, version, description and
copyright, and carries the app's icon at seven sizes.

## macOS: configured, never executed

Every macOS decision has been made and none of them has been tested.

**What exists.** `dist:mac` targets a dmg
([apps/desktop/package.json:14](../apps/desktop/package.json#L14)) under
`public.app-category.education`. The shell has real darwin branches rather than
Windows code that happens to compile: a `hiddenInset` title bar
([main.js:91](../apps/desktop/main.js#L91)), the `appMenu` role prepended to the
menu bar ([main.js:162](../apps/desktop/main.js#L162)), and the platform
convention of staying alive when the last window closes
([main.js:215](../apps/desktop/main.js#L215)). Both desktop scripts already look
for `dist/mac/FluentFlow.app`: `verify-desktop.mjs` knows the path to the
executable inside the bundle, and `refresh-desktop.mjs` knows where
`resources/app` sits within it. Neither needs changing. They need a build to
point at.

**What is missing.** The build config has no `hardenedRuntime`, no entitlements
plist, no notarization step, no signing identity, and no architecture targets,
so no arm64/x64 split and no universal binary. A dmg built today would be
refused by Gatekeeper on any machine except the one that built it.

**And it needs a Mac.** electron-builder cannot cross-build a signed and
notarized macOS target from Windows. That is the blocker; everything else is
downstream of it.

**Order of work.** Get a Mac, then `npm run desktop` there, which builds the web
export and packages the dmg. `npm run verify:desktop` should then find the
`.app` without modification. Decide arm64 versus universal. Finally, and only if
it is to leave that machine, an Apple Developer certificate, `hardenedRuntime`,
entitlements and notarization.

## iOS: code-complete, zero device time

The most misleading of the three, because everything reads as finished.

**What is true.** `platforms` includes `ios`, the bundle identifier is
`com.fluentflow.app`, the new architecture is enabled, tablets are supported, and
`npx expo export --platform ios` completes through Hermes. Sixty-five view tests
cover the screens.

**What that is not.** Those tests run under the `jest-expo/ios` *preset*
([apps/mobile/jest.config.js](../apps/mobile/jest.config.js)), which is a Jest
environment that sets `Platform.OS` to `ios`. It is not a simulator. The tests
are genuinely useful, because they exercise the real platform branch instead of
a mock, and the repository underneath them is real SQLite through `node:sqlite`.
But nothing here has launched on a phone or a simulator, and the browser
walkthrough drives the same components through react-native-web, which is a
different renderer.

**Almost nothing has been prepared for a device.** There is no
`apps/mobile/ios/` directory, so `expo prebuild` has never run. There is no
`eas.json`, no development build and no provisioning profile.

The one piece now in place is the artwork. `app.json` declares an `icon`, an
`android.adaptiveIcon`, a `web.favicon` and an `expo-splash-screen` config with
a light and a dark mark, generated by
[scripts/make-icons.mjs](../scripts/make-icons.mjs). Until that landed,
[app/_layout.tsx:4](../apps/mobile/app/_layout.tsx#L4) called
`SplashScreen.preventAutoHideAsync()` against a splash screen that had never
been configured. The assets exist and the web export consumes the favicon; the
splash itself is a native artefact and has still never been displayed, because
that needs the prebuild below.

**The native-only paths this leaves unexercised.** Each of these has a web
implementation that is tested and a native implementation that is not:

| Path | Where | Why web does not cover it |
| --- | --- | --- |
| SQLite | [src/db/repository.ts](../apps/mobile/src/db/repository.ts) | web is wa-sqlite over OPFS, native is the platform library, and the tests use `node:sqlite`. Three implementations, one tested. |
| `.apkg` import | [src/anki/import.ts:43](../apps/mobile/src/anki/import.ts#L43) | native is the **only** on-device parse path, since web defers to the sync server ([line 85](../apps/mobile/src/anki/import.ts#L85)). The document picker has never opened. |
| Auth persistence | [src/firebase/client.ts:59](../apps/mobile/src/firebase/client.ts#L59) | web uses `browserLocalPersistence`, native uses a hand-written AsyncStorage adapter. Getting this wrong signs the user out on every cold start. |
| Connectivity | [src/state/app.tsx:157](../apps/mobile/src/state/app.tsx#L157) | NetInfo reports differently on a real radio than in a browser tab. |
| Model assets | [src/ai/assets.ts](../apps/mobile/src/ai/assets.ts) | `expo-asset` unpacking a ~620 MB file out of the bundle on first launch, onto a device with finite storage. |
| ONNX Runtime | [src/ai/model.ts](../apps/mobile/src/ai/model.ts) | not installed at all. Metro substitutes a stub when it is absent ([metro.config.js](../apps/mobile/metro.config.js)), so the decode loop has never met a real graph. |

iOS is the only target where the AI pipeline can be more than a fallback, and it
is the target with the least evidence behind it.

**Order of work.** The cheapest device time first: Expo Go on a physical
iPhone, following [device-checklist.md](device-checklist.md). That needs no
Apple Developer account, no Mac and no cloud build, and it reaches three of the
six rows above - SQLite, `.apkg` import and connectivity - plus touch gestures,
safe-area insets and Hermes, none of which are in that table and none of which
have ever run. Auth persistence is not reachable either way until a Firebase
project exists to persist against. `npm run sample-deck` writes the `.apkg`
that makes the import row testable at all.

The project is ready for that run: `npx expo-doctor` passes 21/21, and
`npx expo export --platform ios` completes through Hermes with the current
interface. What Expo Go cannot show is the icon and splash - it substitutes its
own - so those stay unverified until a development build.

After that: `expo prebuild`, then `eas.json` and a
development build with `onnxruntime-react-native` installed, which is the first
time the decoder in `model.ts` would execute. Then an Apple Developer account
and TestFlight.

Android sits at exactly the same stage for the same reasons. It is listed
separately only because the store and signing work differs.

## The two targets that are further along

For contrast, since the above reads as though nothing runs.

**Web** is the most exercised target here. `npm run verify:web` builds the
export, serves it, and walks Chrome through the whole brief: continue without an
account, create a Spanish deck, add cards, reveal, rate with the keyboard,
reload, read the statistics those reviews produced, and switch the interface to
Bosnian. Twenty-two checks, screenshots in `.web-export-shots/`. It is also what
the Windows build renders, which is why Windows inherited a working app rather
than needing one built for it. The exception is Anki import: the web path needs
the sync server, and the Windows shell parses the archive itself.

**The sync server** is complete and tested against a local store, but has never
run against a real Firebase project. The Firestore backend and the security
rules in `firestore.rules` are unproven against the live service. That gap
applies to every platform equally.

## Re-checking this document

Every claim above is meant to be re-verifiable rather than trusted:

| Claim | Check |
| --- | --- |
| Windows artifacts exist | `ls apps/desktop/dist` |
| Windows runs and works | `npm run verify:desktop`, 35 checks, rewrites `.desktop-shots/` |
| Web runs and works | `npm run verify:web`, 22 checks |
| The logic is correct across devices | `npm run verify`, 26 checks against the real server |
| Test counts | `npm test`, 236 unit and integration tests |
| The project is ready for a device | `npx expo-doctor`, 21/21 |
| The iOS bundle still builds | `npx expo export --platform ios`, completes through Hermes |
| iOS has never been prebuilt | `ls apps/mobile/ios`, no such directory |
| No EAS config | `ls apps/mobile/eas.json`, no such file |
| Icon and splash are configured | `grep -E "icon\|splash" apps/mobile/app.json`, and `ls apps/mobile/assets/*.png` |
| ONNX is absent | `grep onnxruntime apps/mobile/package.json`, no matches |
| macOS has never been built | `ls apps/desktop/dist/mac`, no such directory |
| The Windows exe names itself | `(Get-Item apps/desktop/dist/win-unpacked/FluentFlow.exe).VersionInfo` |
| Windows is still unsigned | the same `VersionInfo`, and SmartScreen on a first launch |
