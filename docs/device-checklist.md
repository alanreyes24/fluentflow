# Device checklist: iPhone, Expo Go

`verify-web.mjs` drives the web build through Chrome and `verify-desktop.mjs`
drives the packaged desktop app. Nothing here can drive a phone, so this is the
manual equivalent: an ordered walkthrough where every step is a claim that
either holds or does not.

Use this to record native behavior that desktop tests cannot cover. Add the
device, OS version, commit, and results to [platform-status.md](platform-status.md).

Checklist for Expo SDK 57. This is a test plan, not a completed test record.

## Before you start

```
npm ci
npm run build          # the app imports @fluentflow/core from dist/
npm run sample-deck    # writes sample-deck-60-schema18.apkg
cd apps/mobile
npx expo start         # Expo dev server, then scan the QR code
```

Install **Expo Go** from the App Store first. The phone and this machine must be
on the same network.

Two things usually go wrong from Windows, in this order:

- **Windows Firewall** blocks Metro's port on first run. The prompt appears
  behind the terminal; allow it on private networks. If the QR code scans but
  the bundle never loads, this is why.
- **Client isolation** on the Wi-Fi network (common on guest and university
  networks) stops the phone reaching this machine at all. From `apps/mobile`,
  `npx expo start --tunnel` can route through Expo's relay instead.

## What this run can and cannot prove

Expo Go loads the JavaScript bundle into a pre-built native shell. That covers
most of the app and specifically excludes anything requiring a custom native
build:

| Reachable | Not reachable in Expo Go |
| --- | --- |
| Native `expo-sqlite` | The app icon and splash screen — Expo Go shows its own |
| `.apkg` import through the document picker | Desktop bridge and hosted AI features |
| NetInfo on a real radio | Firebase auth persistence — `extra.firebase` is empty, so there is no sign-in |
| Touch gestures, safe-area insets, dark mode | |
| The statistics screen under Hermes | |

Do not record the splash screen or the icon as verified after this run. They
need a development build.

## The walkthrough

Tick each line, or note what happened instead. The interesting outcome is a
failure — everything here already works in a browser, so anything that breaks
is native-specific and worth writing down precisely.

### 1. It starts at all

- [ ] The bundle loads and the sign-in screen appears.
- [ ] **Continue without an account** reaches an empty deck list.
- [ ] No red error screen, and no yellow warning box.

This is the first time the app has opened its SQLite database through the real
iOS implementation rather than wa-sqlite or `node:sqlite`.

### 2. Native SQLite really persists

- [ ] Create a deck, "Spanish Verbs", Español.
- [ ] Add three cards: hablar / to speak, comer / to eat, vivir / to live.
- [ ] Study the deck: reveal an answer, rate it **Good**.
- [ ] Force-quit the app from the app switcher, then reopen it.
- [ ] Continue without an account again — the deck, its three cards and the
      review are all still there.

The force-quit matters. A database that only appears to work until the process
dies is the failure this catches.

### 3. Anki import — the only on-device parse path

The web build hands `.apkg` files to the sync server; native parses them
locally, so this code has never executed anywhere but a test.

- [ ] AirDrop `sample-deck-60-schema18.apkg` to the phone (or put it in iCloud
      Drive and reach it through Files).
- [ ] **Import from Anki** → **Choose .apkg file** → the document picker opens.
- [ ] Pick the file. The detected language is shown before anything is written.
- [ ] Import it. The summary reports 60 cards.
- [ ] The imported deck appears in the list with its cards.

If the picker opens but the import fails, the error message matters — the
importer is written to say what it could not read.

### 4. Statistics under Hermes

The engine on a phone is Hermes, not V8. Day handling was the specific worry:
these labels are built from local calendar days, and a date parsed as UTC would
shift every one of them by a day for anyone west of Greenwich.

- [ ] Open **Statistics**. The streak reads **1** and says "Kept up today".
- [ ] Switch to **7 days**. The chart axis shows weekday initials, and the
      letter under the last bar is genuinely today's weekday.
- [ ] "Best day" shows today's date, not yesterday's or tomorrow's.
- [ ] The study calendar has exactly one filled square, in the last column.
- [ ] The rating split and forecast render without overflowing the card.

### 5. Touch

`useCardGestures` has been exercised by a unit test and by a mouse. Never by a
finger.

- [ ] Study a deck, reveal the answer, then **swipe the card left**. It rates
      Again and advances.
- [ ] Reveal the next answer and **swipe right**. It rates Good and advances.
- [ ] A short, hesitant drag that does not cross the threshold springs back
      without rating anything.
- [ ] Swiping while the answer is still hidden does nothing.

### 6. Layout and theme on real hardware

- [ ] Nothing is under the notch or the home indicator on any screen.
- [ ] The cards have visible depth. If everything looks flat, `boxShadow` is
      not rendering on the new architecture and the theme needs `shadow*` back.
- [ ] Switch iOS to dark mode with the app open. The app follows it.
- [ ] Settings → the segmented controls fit without their labels truncating.
- [ ] Adding a card: the keyboard does not cover the field being typed into.

### 7. Offline

- [ ] Turn on airplane mode.
- [ ] Study, add a card, import — all still work.
- [ ] The header shows "Offline" rather than an error.

Firebase is unconfigured, so the app is offline regardless; what this tests is
that NetInfo on a real radio does not report something the app mishandles.

## After the run

Record the result in [platform-status.md](platform-status.md). The iOS row
moves off "never run" only for what was actually seen — and only to "runs", not
to "verified", because a checklist a person walks is weaker evidence than a
script that fails a build.

If something broke, that is the valuable outcome: it is a defect that four
levels of testing did not catch, and it belongs in a test before it belongs in
a fix.
