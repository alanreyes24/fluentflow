#!/usr/bin/env node
/**
 * Launch the packaged desktop app and check that it actually works.
 *
 * The Electron shell was written, packaged and reviewed long before anything
 * opened its window. This starts the built executable with a debugging port
 * and drives the real renderer over the same protocol Chrome uses, so the
 * things that only break in a packaged build get exercised: the custom `app://`
 * scheme, the SPA fallback behind it, the content security policy, and whether
 * SQLite works at all outside a browser tab.
 *
 *   node scripts/verify-desktop.mjs            # uses the build in apps/desktop/dist
 *   node scripts/verify-desktop.mjs --headed   # leave the window up at the end
 *   FLUENTFLOW_APP=/Applications/FluentFlow.app node scripts/verify-desktop.mjs
 *   FLUENTFLOW_DICTIONARY_DIR=<dir> node scripts/verify-desktop.mjs   # + lookup
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

// The API key lives in a gitignored `.env` at the repo root. Loading it here
// means `npm run verify:desktop` exercises the real hosted path without anyone
// having to remember to export anything.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No .env: the run checks the no-key state instead, which is also worth
  // checking and is what CI sees.
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = join(ROOT, '.desktop-shots');
const DEBUG_PORT = 9222;

const options = { headed: process.argv.includes('--headed') };
const checks = [];

async function main() {
  const executable = findExecutable();
  if (!executable) {
    console.error('No packaged app found. Run: npm run desktop:pack');
    process.exitCode = 1;
    return;
  }

  console.log(`Launching ${executable}`);

  // ELECTRON_RUN_AS_NODE has to go.
  //
  // Any Electron binary that inherits it runs as plain Node: no window, no
  // `app`, no `protocol`, and an immediate exit with status 0 — which reads
  // exactly like the packaged app being broken. Editors built on Electron
  // (VS Code among them) set it for their own child processes, so it arrives
  // in the environment without anyone asking for it.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;

  // A run that times out leaves its Electron alive on the debugging port, and
  // the next run's `connectWhenReady` then attaches to *that* — a stale
  // instance full of the previous run's decks — instead of the one it just
  // spawned. Clear the port first.
  await killStaleInstances();

  // A throwaway profile per run. The desktop app keeps its SQLite database in
  // the user data directory, which survives between launches — so a second run
  // would find the first run's deck and never see the empty state it is
  // supposed to be checking.
  const profile = mkdtempSync(join(tmpdir(), 'fluentflow-verify-'));
  seedApiKey(profile);

  const app = spawn(
    executable,
    [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: environment },
  );

  const crashes = [];
  app.stderr.on('data', (chunk) => {
    const line = String(chunk);
    // Electron writes a lot of GPU and DevTools chatter to stderr — on macOS
    // it also logs IMK and CoreText noise; only genuine failures matter here.
    if (/FATAL|Uncaught|Error:/i.test(line)) crashes.push(line.trim());
  });

  checkMacBundle(executable);

  let browser;
  try {
    browser = await connectWhenReady();
    await run(browser, crashes, app);
  } catch (error) {
    check('the app started and was reachable', false, String(error?.message ?? error));
  } finally {
    await browser?.disconnect();
    if (!options.headed) {
      app.kill();
      await delay(500);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }

  report();
}

async function run(browser, crashes, app) {
  check('the packaged app launches', app.exitCode === null);

  const pages = await browser.pages();
  const page = pages.find((candidate) => !candidate.url().startsWith('devtools://'));
  if (!page) throw new Error('The app opened no window.');

  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  // The custom scheme is what makes routing and a real origin work; file://
  // would give the page a null origin and break deep links.
  const url = page.url();
  check('the window is served over the app:// scheme, not file://', url.startsWith('app://'), url);

  await waitForText(page, 'FluentFlow');
  check('the interface renders', true);
  await shoot(page, '01-launched');

  // --- the same flow the web walkthrough covers, in the packaged shell ------
  await clickLabel(page, 'Continue without an account');
  await waitForText(page, 'No decks yet');
  check('an account-less session reaches the deck list', true);

  // --- the window buttons are not sitting on top of the app ----------------
  //
  // The shell hides the native title bar, so macOS paints close, minimise and
  // zoom over the top-left of the page — at coordinates the page cannot query.
  // A screenshot cannot catch this (the buttons are not part of the page) and
  // neither can any assertion about text, so it is checked as geometry: is
  // anything the app draws inside the rectangle those buttons occupy?
  //
  // The numbers come from `trafficLightPosition` in main.js and have to stay
  // in step with TITLE_BAR_HEIGHT and WINDOW_BUTTONS_WIDTH in ui/shell.ts.
  const collisions = await underWindowButtons(page);
  check('nothing is drawn under the window buttons', collisions.length === 0, collisions[0]);

  // Again with the window dragged narrow. The navigation stack's back arrow
  // sits exactly where the window buttons are, and a narrow window packs the
  // header and the bottom bar differently — so the wide window being clear
  // says nothing about this one.
  await page.setViewport({ width: 700, height: 800 });
  await delay(300);
  const narrowCollisions = await underWindowButtons(page);
  check(
    'nothing is drawn under them once the window is dragged narrow',
    narrowCollisions.length === 0,
    narrowCollisions[0],
  );
  await page.setViewport({ width: 1100, height: 800 });
  await delay(300);

  // With the title bar hidden the window has no handle until the page gives it
  // one, and a window that cannot be moved is a worse bug than an overlap.
  const draggable = await page.evaluate(() =>
    [...document.querySelectorAll('[data-drag-region]')].some((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 100 && box.height >= 20;
    }),
  );
  check('the window has a region to drag it by', draggable);

  await clickLabel(page, 'New deck');
  await typeInto(page, 'Deck name', 'Bosnian Basics');
  // Pick the target language explicitly. The form defaults to Spanish, and a
  // Bosnian deck left on that default produces Spanish example sentences for
  // Bosnian words — correct behaviour, and a meaningless thing to assert on.
  await clickLabel(page, 'Bosanski');
  await clickLabel(page, 'Create deck');
  await waitForText(page, 'Bosnian Basics');
  // SQLite is the thing most likely to differ in a packaged Electron build.
  check('SQLite works in the packaged app', true);

  await clickLabel(page, 'Add card');
  await typeInto(page, 'Word or phrase', 'zdravo');
  await typeInto(page, 'Meaning or translation', 'hello');
  await clickLabel(page, 'Save');
  await waitForText(page, 'zdravo');
  await clickLabel(page, 'Cancel');
  check('a card is added and listed', true);
  await shoot(page, '02-deck');

  await clickText(page, /^Study/);
  await waitForText(page, 'Show answer');
  await clickLabel(page, 'Show answer');
  await waitForText(page, 'Again');
  const revealed = (await bodyText(page)).toLowerCase();
  check('revealing shows the meaning', revealed.includes('hello'));

  // Wait for the generation to finish rather than for the word "examples":
  // the spinner reads "Writing examples…", so a substring check matches the
  // card mid-generation and reads the section before anything is in it.
  const usesModel = modelInstalled();
  const settled = await textGone(page, 'Writing examples', usesModel ? 120000 : 20000);
  check('example generation finishes', settled);

  const shown = (await bodyText(page)).toLowerCase();
  const offline = shown.includes('offline examples');
  const sentences = await exampleSentences(page, 'zdrav');
  await shoot(page, '03-study');

  if (usesModel) {
    // The point of calling the model from the main process: the renderer must
    // never hold the API key, so before that bridge existed every reveal landed
    // in the branch below no matter what was configured.
    // On a failure, ask the bridge directly rather than reporting page text.
    // The interesting part of "the examples are generic" is always the reason —
    // a refused key, a spent quota, a retired model name — and the page only
    // shows the sentences.
    const why = offline
      ? await page.evaluate(() =>
          window.fluentflowDesktop.ai
            .examples({ word: 'zdravo', meaning: 'hello', language: 'bs', count: 2 })
            .then((r) => r?.result?.error ?? r?.error ?? 'no reason given'),
        )
      : shown.slice(0, 120);
    check('the examples came from the model, not the offline frames', !offline, why);
    check(
      'the model wrote two different sentences using the word',
      sentences.length >= 2 && sentences[0] !== sentences[1],
      sentences.join(' | ') || 'none found',
    );
  } else {
    check(
      'with no API key the examples are labelled offline, not passed off',
      offline,
    );
    // The deck's language, not the interface's, decides what the examples are
    // written in — the two are deliberately separate.
    check(
      'the examples are in the deck language',
      shown.includes('znači'),
      'Bosnian fallback for a Bosnian deck',
    );
  }

  // "Good" (3) advances a new card through the learning steps rather than
  // graduating it in one press, so the one-card session takes a few. Alternate
  // rate (3) and reveal (Enter) until the queue drains — all from the keyboard,
  // which is what this check is really about; the press count is the
  // scheduler's business.
  let sessionDone = false;
  for (let press = 0; press < 4 && !sessionDone; press++) {
    await page.keyboard.press('3');
    sessionDone = await hasText(page, 'nothing left to review', 4000);
    if (!sessionDone) await page.keyboard.press('Enter');
  }
  check('the keyboard shortcut rates the card', sessionDone);
  await shoot(page, '04-session-complete');

  // --- a pasted word list becomes cards ------------------------------------
  // The second way cards get made, exercised in the packaged shell because it
  // writes to the same SQLite database the study flow just read from.
  await clickLabel(page, 'Decks');
  await waitForText(page, 'zdravo');

  await clickLabel(page, 'Paste a word list');
  await typeInto(page, 'Your list', 'hvala - thank you\nmolim - please\nnot a card');
  check(
    'a pasted list is turned into cards before anything is written',
    await hasText(page, '2 cards ready', 8000),
  );
  check(
    'the line it could not read is reported, not silently dropped',
    await hasText(page, '1 line(s) skipped', 5000),
  );
  await shoot(page, '05-paste');

  await clickLabel(page, 'Add to this deck');
  const added = await hasText(page, 'Import complete', 10000);
  check('the pasted cards are written to the deck', added);

  if (added) {
    await clickLabel(page, 'Decks');
    check('the deck lists what was pasted into it', await hasText(page, 'hvala', 10000));
    await shoot(page, '06-pasted-cards');
  }

  // --- a word list with no meanings, and the model that fills it in --------
  // The interesting half of text import: a paste that is just words. It must
  // never become one card with the rest of the list on its back, and whatever
  // the model says about those words has to be reviewable before it is written.
  await clickLabel(page, 'Paste a word list');
  // Bosnian words, because the deck is Bosnian: the lookup uses the deck's
  // language, and pasting Spanish here would send everything to the model and
  // quietly prove nothing about the dictionary.
  await typeInto(page, 'Your list', 'knjiga\nprijatelj\nljubav');

  check(
    'a bare word list is read as words, not as one card',
    await hasText(page, '0 of 3 ready', 8000) && await hasText(page, 'One word per line', 2000),
  );
  check(
    'words with no meaning are counted, and nothing can be imported yet',
    await hasText(page, '3 words with no meaning yet', 5000),
  );
  await shoot(page, '07-word-list');

  if (lookupInstalled()) {
    await clickLabel(page, 'Look up the meanings');
    // The first press is the dictionary alone, which answers in milliseconds
    // and cannot reach the network at all.
    const reviewed = await hasText(page, 'Check these before importing', 60000);
    check('the meanings are filled in', reviewed);

    if (reviewed) {
      // Nothing is billed to get here. If the dictionary left words over, the
      // model is a second button naming them, and this is where it is pressed.
      const askModel = await findVisibleLabel(page, /^Ask .* about the remaining \d+$/);
      if (askModel) {
        await clickLabel(page, askModel);
        // Settled either way: the button goes when the model has answered, and
        // also when it was asked and had nothing — a depleted key, say. Waiting
        // for the answer alone would stall for the whole timeout on a run that
        // had already finished.
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          if ((await findVisibleLabel(page, /^Ask .* about the remaining \d+$/)) === null) break;
          await delay(500);
        }
      }

      const shown = await bodyText(page);
      const fromDictionary = shown.match(/(\d+) from the dictionary/)?.[1] ?? '0';
      // The model half of the summary names the model rather than the word
      // "model", so that a count and a bill can be connected.
      const fromModel = shown.match(/(\d+) from gemini[\w.-]*/)?.[1] ?? '0';

      check(
        'every meaning says which source answered it',
        /from the dictionary|from gemini|with no answer/.test(shown),
        shown.match(/.*(from the dictionary|with no answer).*/)?.[0],
      );

      if (dictionaryInstalled()) {
        // The point of the whole arrangement: ordinary words come from the
        // dictionary and the model is never asked. A run where the model
        // answered these would mean the dictionary was not consulted at all.
        check(
          'the dictionary answered all three, and the model was not needed',
          fromDictionary === '3' && fromModel === '0',
          `dictionary ${fromDictionary}, model ${fromModel}`,
        );
        check(
          'nothing was offered to the model, because nothing was left over',
          askModel === null,
          askModel ?? 'no paid step offered',
        );
        check(
          'dictionary meanings are not flagged for review',
          !shown.includes('model — check this'),
        );
      } else {
        // The other half of the same policy. With no dictionary installed every
        // word falls to the model, and every one of those answers has to arrive
        // marked as a draft — this is the arrangement that caught "lodazal" as
        // "lodestar" before it became a card.
        check(
          'with no dictionary the model answers, and says that it did',
          fromDictionary === '0' && fromModel === '3',
          `dictionary ${fromDictionary}, model ${fromModel}`,
        );
        check(
          'every model meaning is flagged for review before import',
          shown.includes('model — check this'),
        );
      }

      // The glosses themselves, so a source that answered but returned nothing
      // useful cannot pass this. They live in input values, which are not part
      // of innerText — reading the page text would always find them empty and
      // the check would pass or fail for the wrong reason.
      const glosses = await Promise.all(
        ['knjiga', 'prijatelj', 'ljubav'].map((word) => fieldValue(page, word)),
      );
      check(
        'the meanings that came back are the right ones',
        /book/i.test(glosses[0] ?? '') &&
          /friend/i.test(glosses[1] ?? '') &&
          /love/i.test(glosses[2] ?? ''),
        glosses.join(' · '),
      );
      // The page is long by this point and the review list is below the fold;
      // a screenshot of the top proves nothing about it.
      await scrollTo(page, 'Check these before importing');
      await shoot(page, '08-review');

      // Every answer is a draft in an editable field. Correcting one is the
      // whole point: a model guess written straight into a deck teaches the
      // wrong word, and even a dictionary gloss may not be the wording wanted.
      await typeInto(page, 'ljubav', 'love');

      await clickLabel(page, 'Add to this deck');
      const added = await hasText(page, 'Import complete', 15000);
      check('the reviewed meanings are imported', added);

      if (added) {
        await clickLabel(page, 'Decks');
        await waitForText(page, 'knjiga');
        const listed = await bodyText(page);
        check(
          'the cards carry the reviewed meanings',
          listed.includes('love') && /book/i.test(listed),
          listed.match(/knjiga[\s\S]{0,40}/)?.[0]?.replace(/\s+/g, ' '),
        );
        await shoot(page, '09-looked-up-deck');
      }
    }
  } else {
    check(
      'with nothing installed the app says so rather than offering to look up',
      await hasText(page, 'No dictionary installed and no API key', 8000),
    );
  }

  // --- the settings screen's answer about the model ------------------------
  //
  // "Why are my examples generic?" is the question this app gets asked most,
  // and settings is where it is answered. The renderer never holds the API key,
  // so the screen asks the shell instead. This is that answer, in the packaged
  // app.
  await clickLabel(page, 'Settings');
  await waitForText(page, 'Cloud examples');
  const settings = await bodyText(page);

  check(
    modelInstalled()
      ? 'settings names the model the shell is calling'
      : 'settings says there is no key, and where to get one',
    modelInstalled()
      ? settings.includes('Connected') && /gemini/i.test(settings)
      : settings.includes('Not connected') && /aistudio\.google\.com/i.test(settings),
    settings.match(/(Connected|Not connected)[\s\S]{0,90}/)?.[0]?.replace(/\s+/g, ' '),
  );

  // The key must not be reachable from the page that draws deck content.
  check(
    'the renderer has no way to read the API key back',
    await page.evaluate(() => {
      const ai = window.fluentflowDesktop?.ai ?? {};
      return !('getCloud' in ai) && !('apiKey' in ai);
    }),
  );
  await shoot(page, '10-settings');

  // --- nothing broke -------------------------------------------------------
  const blocked = consoleErrors.filter((message) => /Content Security Policy/i.test(message));
  check('the content security policy does not block the app', blocked.length === 0, blocked[0]);

  const fatal = consoleErrors.filter((message) => !/DevTools|Autofill|favicon/i.test(message));
  check('the renderer logged no errors', fatal.length === 0, fatal.slice(0, 2).join(' | '));
  check('the app did not crash', crashes.length === 0, crashes[0]);
}

// --- helpers ----------------------------------------------------------------

/**
 * Is there anything for the app to look words up in?
 *
 * The dictionaries are not in the repository and the API key is not either, so
 * these checks are conditional: with either present the flow is driven, with
 * neither the app is checked for saying so. Point FLUENTFLOW_DICTIONARY_DIR at
 * a built dictionary — the app reads the same variable — and put a
 * GEMINI_API_KEY in the repo's `.env`.
 */
function lookupInstalled() {
  return dictionaryInstalled() || modelInstalled();
}

/** Is there a bilingual dictionary for the deck's language? */
function dictionaryInstalled() {
  const dictionaries = process.env.FLUENTFLOW_DICTIONARY_DIR;
  return Boolean(dictionaries && existsSync(join(dictionaries, 'bs-en.sqlite3')));
}

/**
 * Is there a model for the reveal to write examples with?
 *
 * Its own question, not a synonym for {@link lookupInstalled}: a dictionary
 * fills in meanings but cannot write a sentence, so a run with a dictionary and
 * no key should still expect the offline frames on a card reveal.
 *
 * Set GEMINI_API_KEY (the repo's gitignored `.env` carries one) and the run
 * drives the real hosted path — a real request, over the network, billed. With
 * it unset the app is checked for saying plainly that it has no model, which is
 * the state a fresh install is in.
 */
function modelInstalled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Give the throwaway profile the API key, the way the app stores one.
 *
 * `encrypted: false` is a supported shape in apps/desktop/cloud.js — it is what
 * a machine with no keychain falls back to — and it is the only way to seed a
 * key without driving the settings screen first. The profile is deleted at the
 * end of the run.
 */
function seedApiKey(profile) {
  if (!modelInstalled()) return;
  writeFileSync(
    join(profile, 'cloud.json'),
    JSON.stringify({ key: process.env.GEMINI_API_KEY, encrypted: false }, null, 2),
    { mode: 0o600 },
  );
}

/**
 * The parts of a packaged macOS bundle that only exist once, at build time —
 * the icon and the code signature — rather than anything the running app does.
 */
function checkMacBundle(executable) {
  if (process.platform !== 'darwin' || !executable.includes('.app/Contents/MacOS/')) return;

  const appDir = executable.replace(/\/Contents\/MacOS\/[^/]+$/, '');

  let iconFile = '';
  try {
    iconFile = execFileSync(
      'defaults',
      ['read', join(appDir, 'Contents', 'Info.plist'), 'CFBundleIconFile'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    // no such key — treated as "no custom icon" below
  }
  const iconPath = join(appDir, 'Contents', 'Resources', iconFile);
  const customIcon =
    iconFile !== '' &&
    iconFile !== 'electron.icns' &&
    existsSync(iconPath) &&
    statSync(iconPath).size > 1024;
  check('the app carries a custom icon, not the default Electron one', customIcon, iconFile);

  let signature = '';
  try {
    signature = execFileSync('codesign', ['-d', '--entitlements', ':-', appDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    signature = '';
  }
  check(
    'the bundle is signed with the hardened-runtime entitlements',
    /com\.apple\.security\.cs\.allow-jit/.test(signature),
  );

  let verified = false;
  try {
    execFileSync('codesign', ['--verify', '--strict', appDir], { stdio: 'ignore' });
    verified = true;
  } catch {
    verified = false;
  }
  check('the code signature is self-consistent', verified);
}

/** Kill any FluentFlow left holding the debugging port from an earlier run. */
async function killStaleInstances() {
  const pidsOnPort = () => {
    try {
      return execFileSync('lsof', ['-ti', `tcp:${DEBUG_PORT}`], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const pids = pidsOnPort();
  if (pids.length === 0) return;

  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  // Wait for the port to actually free before the new instance claims it.
  for (let attempt = 0; attempt < 20 && pidsOnPort().length > 0; attempt++) {
    await delay(100);
  }
}

function findExecutable() {
  // An explicit path, for checking a copy that is not in dist/ — the app out
  // of a mounted .dmg, or an installed one.
  if (process.env.FLUENTFLOW_APP) {
    const given = process.env.FLUENTFLOW_APP;
    const inside = given.endsWith('.app')
      ? join(given, 'Contents', 'MacOS', 'FluentFlow')
      : given;
    return existsSync(inside) ? inside : null;
  }

  const dist = join(ROOT, 'apps', 'desktop', 'dist');
  // electron-builder names the macOS directory after the architecture it built
  // for, so all three spellings are worth looking for.
  const macApp = (directory) => join(dist, directory, 'FluentFlow.app', 'Contents', 'MacOS', 'FluentFlow');
  const candidates = [
    join(dist, 'win-unpacked', 'FluentFlow.exe'),
    macApp('mac-arm64'),
    macApp('mac'),
    macApp('mac-universal'),
    join(dist, 'linux-unpacked', 'fluentflow'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Electron needs a moment before its debugging endpoint answers. */
async function connectWhenReady(attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await puppeteer.connect({
        browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
        defaultViewport: null,
      });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

async function clickLabel(page, label) {
  const handle = await visibleMatch(page, `[aria-label="${label}"]`);
  await handle.click();
  await delay(250);
}

/**
 * The last *visible* element matching a selector.
 *
 * expo-router keeps the screens under the current one mounted, so a label used
 * on two screens matches twice — and `waitForSelector(visible: true)` checks
 * the first match, which belongs to the screen underneath and never becomes
 * visible. That reads as a missing button on a screen that is showing it.
 */
async function visibleMatch(page, selector, timeout = 20000) {
  const onScreen = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  await page.waitForFunction(
    (sel) =>
      [...document.querySelectorAll(sel)].some((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }),
    { timeout },
    selector,
  );

  const matches = await page.$$(selector);
  let last = null;
  for (const handle of matches) {
    if (await handle.evaluate(onScreen)) last = handle;
  }
  if (!last) throw new Error(`No visible element matches ${selector}`);
  return last;
}

/**
 * The aria-label of a visible element matching a pattern, or null.
 *
 * Unlike {@link visibleMatch} this neither waits nor throws: it answers "is this
 * on screen right now", a question with two legitimate answers. The paid lookup
 * step only appears when the free dictionary pass left something over, and a run
 * where it never appears is a run that passed.
 */
async function findVisibleLabel(page, pattern) {
  return page.evaluate(
    (source, flags) => {
      const expression = new RegExp(source, flags);
      for (const node of document.querySelectorAll('[aria-label]')) {
        const label = node.getAttribute('aria-label') ?? '';
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.height > 0 && expression.test(label)) return label;
      }
      return null;
    },
    pattern.source,
    pattern.flags,
  );
}

async function clickText(page, pattern) {
  const { source, flags } = pattern;
  await page.waitForFunction(
    (src, flg) => {
      const expression = new RegExp(src, flg);
      return [...document.querySelectorAll('div,span,a')].some((node) =>
        expression.test((node.textContent ?? '').trim()),
      );
    },
    { timeout: 20000 },
    source,
    flags,
  );
  const handles = await page.$$('div,span,a');
  for (const handle of handles.reverse()) {
    const text = await handle.evaluate((node) => (node.textContent ?? '').trim());
    if (new RegExp(source, flags).test(text)) {
      await handle.click();
      break;
    }
  }
  await delay(250);
}

async function typeInto(page, label, value) {
  const selector = `input[aria-label="${label}"], textarea[aria-label="${label}"]`;
  const handle = await visibleMatch(page, selector);
  await handle.click({ clickCount: 3 });
  await handle.type(value, { delay: 8 });
  await delay(150);
}

/** Bring an element with the given text into view, for a screenshot. */
async function scrollTo(page, text) {
  await page.evaluate((needle) => {
    const node = [...document.querySelectorAll('div,span')].find((candidate) =>
      (candidate.textContent ?? '').trim().startsWith(needle),
    );
    node?.scrollIntoView({ block: 'start' });
  }, text);
  await delay(400);
}

/** The current value of a labelled input, which innerText never shows. */
async function fieldValue(page, label) {
  return page.evaluate((name) => {
    const node = document.querySelector(
      `input[aria-label="${name}"], textarea[aria-label="${name}"]`,
    );
    return node ? node.value : null;
  }, label);
}

/**
 * Anything the app paints inside the window buttons' rectangle.
 *
 * The numbers come from `trafficLightPosition` in main.js and have to stay in
 * step with TITLE_BAR_HEIGHT and WINDOW_BUTTONS_WIDTH in ui/shell.ts.
 */
function underWindowButtons(page) {
  return page.evaluate(
    (zone) => {
      const hits = [];
      for (const node of document.querySelectorAll('*')) {
        // Leaves only: a container that merely encloses the corner is not
        // something the user can see or press.
        if (node.children.length > 0) continue;
        const text = (node.textContent ?? '').trim();
        const control = node.getAttribute('role') === 'button' || node.tagName === 'INPUT';
        if (!text && !control) continue;

        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (box.left < zone.width && box.top < zone.height) {
          hits.push(`"${text.slice(0, 30)}" at ${Math.round(box.left)},${Math.round(box.top)}`);
        }
      }
      return hits;
    },
    { width: 82, height: 44 },
  );
}

function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function waitForText(page, text) {
  await page.waitForFunction(
    (needle) => document.body.innerText.toLowerCase().includes(needle),
    { timeout: 30000 },
    text.toLowerCase(),
  );
}

async function hasText(page, text, timeout) {
  try {
    await page.waitForFunction(
      (needle) => document.body.innerText.toLowerCase().includes(needle),
      { timeout },
      text.toLowerCase(),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The example sentences on the revealed card.
 *
 * Read as lines that use the word and are long enough to be a sentence, which
 * is the same thing core validates before accepting them. Matching on a stem
 * rather than the whole word is deliberate: Bosnian declines, so a sentence
 * demonstrating `zdravo` may well contain `zdrava`, and requiring the exact
 * form would fail the check for the one reason it should pass.
 */
async function exampleSentences(page, stem) {
  const text = await bodyText(page);
  const pattern = new RegExp(stem, 'i');
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => pattern.test(line) && line.split(/\s+/).length >= 3),
    ),
  ];
}

/** Wait for text to disappear — a spinner finishing, rather than appearing. */
async function textGone(page, text, timeout) {
  try {
    await page.waitForFunction(
      (needle) => !document.body.innerText.toLowerCase().includes(needle),
      { timeout, polling: 500 },
      text.toLowerCase(),
    );
    return true;
  } catch {
    return false;
  }
}

async function shoot(page, name) {
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function check(description, passed, detail) {
  checks.push({ description, passed, detail });
  console.log(`  ${passed ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
}

function report() {
  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const entry of failed) console.log(`  ✗ ${entry.description}`);
  }
  console.log(`Screenshots in ${SHOTS_DIR}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
