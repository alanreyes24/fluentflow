# Platform status

Where each target actually stands. The README says what the app does; this says
which platforms it has been watched doing it on, which is a shorter list.

Current as of 3 September 2026.

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
| Windows | yes | yes | yes, 14 checks | unsigned only |
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
and `will-attach-webview` is unconditionally blocked.

**The artifacts.** `npm run desktop` produces both an NSIS installer and a
portable executable, 110 MB each. Both currently sit in `apps/desktop/dist/`
alongside `win-unpacked/`. `asar: false` is deliberate: it is what lets
`npm run desktop:refresh` push a ~3 MB update into an already-installed copy
instead of rebuilding a 110 MB installer.

**The evidence.** [scripts/verify-desktop.mjs](../scripts/verify-desktop.mjs)
launches the packaged executable with a debugging port and drives the real
renderer over the DevTools protocol. Fourteen checks, including that the window
is served over `app://` and not `file://`, that SQLite works at all outside a
browser tab, that the CSP does not block the app, that the renderer logged no
errors, and that the process did not crash. It runs against a throwaway
user-data directory each time, so it sees the empty state rather than the
previous run's deck. Screenshots land in `.desktop-shots/`.

**What is left.**

- **Unsigned.** SmartScreen shows "More info, Run anyway" on first launch. This
  is the single largest barrier to anyone else installing it.
- **No version metadata in the executable.** `dist:win:unsigned` passes
  `signAndEditExecutable=false`, because electron-builder's signing toolchain
  ships an archive containing macOS symlinks that Windows refuses to extract
  without Developer Mode. Nothing here is signed anyway, so the resource edit was
  the cheaper thing to lose.
- **No auto-update.** No update channel is configured. `desktop:refresh` is a
  developer tool, not a distribution mechanism, and it cannot touch the portable
  executable at all, which unpacks itself into a temporary directory on every
  launch.
- **No on-device AI, permanently.** `onnxruntime-react-native` is a native mobile
  module, so the desktop build always uses the written-sentence fallback and the
  UI says so. That is a property of the Electron approach, not a gap to close.
- The README links a GitHub releases page for the packaged builds. Whether a
  release is actually published there, and whether it matches the artifacts in
  `dist/`, has not been checked.

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
| ONNX Runtime | [src/ai/model.ts](../apps/mobile/src/ai/model.ts) | not installed at all. Metro substitutes a stub when it is absent ([metro.config.js:49](../apps/mobile/metro.config.js#L49)), so the decode loop has never met a real graph. |

iOS is the only target where the AI pipeline can be more than a fallback, and it
is the target with the least evidence behind it.

**Order of work.** `expo prebuild`, then a
simulator run walking the same brief the web build is walked through. Then
import, sync and auth exercised on a real device. Then `eas.json` and a
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
Bosnian. Twenty-two checks, screenshots in `.web-export-shots/`. It is also what the Windows build renders, which is why
Windows inherited a working app rather than needing one built for it.

**The sync server** is complete and tested against a local store, but has never
run against a real Firebase project. The Firestore backend and the security
rules in `firestore.rules` are unproven against the live service. That gap
applies to every platform equally.

## Re-checking this document

Every claim above is meant to be re-verifiable rather than trusted:

| Claim | Check |
| --- | --- |
| Windows artifacts exist | `ls apps/desktop/dist` |
| Windows runs and works | `npm run verify:desktop`, 14 checks, rewrites `.desktop-shots/` |
| Web runs and works | `npm run verify:web`, 22 checks |
| The logic is correct across devices | `npm run verify`, 26 checks against the real server |
| Test counts | `npm test`, 207 unit and integration tests |
| iOS has never been prebuilt | `ls apps/mobile/ios`, no such directory |
| No EAS config | `ls apps/mobile/eas.json`, no such file |
| Icon and splash are configured | `grep -E "icon\|splash" apps/mobile/app.json`, and `ls apps/mobile/assets/*.png` |
| ONNX is absent | `grep onnxruntime apps/mobile/package.json`, no matches |
| macOS has never been built | `ls apps/desktop/dist/mac`, no such directory |
