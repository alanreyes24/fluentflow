# Platform status

FluentFlow is a personal language-practice app. A shared UI and a build target
do not mean every platform has been tested equally.

| Platform | Current scope |
| --- | --- |
| macOS | Main desktop development path. Packaging targets Apple Silicon (`arm64`). Intel builds are not configured. |
| Web | Local development and static export are supported. Browser Anki import needs the API; Gemini needs a server-side proxy. |
| Windows | Electron installer and portable targets are configured, with earlier walkthroughs recorded in project history. Re-test any new release on Windows. |
| iOS / Android | Expo targets exist, but no completed hardware-testing record is included. Treat them as experimental. |
| Linux | An AppImage target is configured, but no Linux desktop verification is recorded. |

## Limits

- The macOS packaging defaults use ad-hoc signing, without notarization.
  Windows packaging has no signing identity configured. These are not
  store-ready releases.
- The native mobile targets do not include a local language model. Hosted AI
  support is implemented through the desktop bridge and browser API proxy.
- Firebase sync is optional and requires your own configuration. Local API
  tests do not validate a deployed project's Firestore rules or access controls.
- Anki import is vocabulary-oriented: reverse and cloze siblings are merged,
  and some newer compressed exports are rejected. Keep the original deck.
- Dependency advisories remain open; see [SECURITY.md](../SECURITY.md).

## Verification

`npm test`, `npm run typecheck`, and `npm run verify` exercise the code and local
API. `npm run verify:web` and `npm run verify:desktop` exercise real builds with
browser automation. They require additional local software; see
[development.md](development.md).

For native testing, use the [device checklist](device-checklist.md) and record
the OS, device, commit, and results. Passing a build or a desktop test is not a
substitute for running the app on a phone.
