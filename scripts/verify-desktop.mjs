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
 *   node scripts/verify-desktop.mjs            # uses dist/win-unpacked
 *   node scripts/verify-desktop.mjs --headed   # leave the window up at the end
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { buildApkg, spanishNotes } from '../packages/core/test/helpers/anki-fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = join(ROOT, '.desktop-shots');
const DEBUG_PORT = 9222;
const APP_ORIGIN = 'app://fluentflow';

/** Deliberately unlike the 1100x800 default, so a restore is unambiguous. */
const REMEMBERED_BOUNDS = { x: 80, y: 60, width: 940, height: 720 };
const APP_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'),
).version;

const options = { headed: process.argv.includes('--headed') };
const checks = [];

async function main() {
  const executable = findExecutable();
  if (!executable) {
    console.error('No packaged app found. Run: npm run desktop:win');
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

  // A throwaway profile per run. The desktop app keeps its SQLite database in
  // the user data directory, which survives between launches — so a second run
  // would find the first run's deck and never see the empty state it is
  // supposed to be checking.
  const profile = mkdtempSync(join(tmpdir(), 'fluentflow-verify-'));

  const app = spawn(
    executable,
    [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: environment },
  );

  const crashes = [];
  app.stderr.on('data', (chunk) => {
    const line = String(chunk);
    // Electron writes a lot of GPU and DevTools chatter to stderr on Windows;
    // only genuine failures matter here.
    if (/FATAL|Uncaught|Error:/i.test(line)) crashes.push(line.trim());
  });

  let browser;
  try {
    browser = await connectWhenReady();
    await run(browser, crashes, app, { app, executable, profile, environment });
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

async function run(browser, crashes, app, session) {
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
  check('revealing shows the meaning and its examples', revealed.includes('hello'));
  check('example sentences are generated', await hasText(page, 'examples', 15000));
  // The deck's language, not the interface's, decides what the examples are
  // written in — the two are deliberately separate.
  check(
    'the examples are in the deck language',
    (await bodyText(page)).includes('znači'),
    'Bosnian fallback for a Bosnian deck',
  );
  await shoot(page, '03-study');

  await page.keyboard.press('3');
  check(
    'the keyboard shortcut rates the card',
    await hasText(page, 'nothing left to review', 8000),
  );
  // Counted in the session's own state, not read back from the database — so
  // this says the summary renders, not that the rating was persisted. What it
  // was written to is covered by the reload check in the web walkthrough.
  check(
    'the session summary counts what was reviewed',
    await hasText(page, 'accuracy', 5000),
  );
  await shoot(page, '04-session-complete');

  // --- the shell, as the page sees it --------------------------------------
  //
  // Everything below this line is desktop-only. It is the part the web
  // walkthrough cannot cover, because in a browser tab none of it exists.
  const bridge = await page.evaluate(() => {
    const api = globalThis.fluentflowDesktop;
    if (!api) return null;
    return {
      platform: api.platform,
      appVersion: api.appVersion,
      canImportLocally: api.canImportLocally,
      hasLocalModel: api.hasLocalModel,
      callable: ['pickApkg', 'importApkg', 'onImportRequest', 'reportTheme'].every(
        (name) => typeof api[name] === 'function',
      ),
    };
  });

  check('the page can see the shell bridge', bridge !== null);
  check('the bridge exposes every call the app makes', bridge?.callable === true);
  check('the shell says it can import without the sync server', bridge?.canImportLocally === true);
  check(
    'the bridge reports the packaged version, not a blank',
    bridge?.appVersion === APP_VERSION,
    bridge?.appVersion,
  );

  // A deep link into the packaged build, which is the reason the export is
  // served over `app://` at all: under `file://` this lands on a blank page.
  // It also reloads, so the deck has to come back out of SQLite rather than out
  // of the session that created it.
  await page.goto(`${APP_ORIGIN}/decks`);
  await waitForText(page, 'FluentFlow');
  await clickLabel(page, 'Continue without an account');
  await waitForText(page, 'Bosnian Basics');
  check('a deep link resolves instead of hitting a blank page', true);
  check(
    'the deck and its review survived a reload',
    await hasText(page, '1 cards', 8000),
  );

  // --- the statistics that review produced ---------------------------------
  //
  // The web walkthrough covers this screen too, but over a different database:
  // there it reads wa-sqlite in OPFS, here it reads the shell's SQLite. The
  // streak is the number worth watching in the packaged build specifically —
  // it is computed from local calendar days, so it depends on the machine's
  // clock and timezone rather than a test's, and a review rated a moment ago
  // has to land on today for the count to be right.
  await clickLabel(page, 'Statistics');
  const statsReady = await hasText(page, 'Day streak', 15000);
  check('the statistics screen opens from the deck list', statsReady);

  if (statsReady) {
    const stats = await bodyText(page);
    check(
      'the streak counts the review rated in the packaged app',
      /kept up today/i.test(stats),
      stats.match(/Best \d+/)?.[0],
    );
    check(
      'retention and the rating split are reported',
      /retention/i.test(stats) && /how you rated/i.test(stats),
    );
    check(
      'the study calendar is drawn',
      await hasSelector(page, '[aria-label^="Study calendar"]'),
    );
    await shoot(page, '05-statistics');
  }

  // Back through client-side routing rather than a reload: an account-less
  // session lives in memory, and a `goto` here would land on sign-in again.
  await page.evaluate(() => history.back());
  await waitForText(page, 'Bosnian Basics');

  await clickLabel(page, 'Settings');
  await waitForText(page, 'desktop app');
  check(
    'settings names the build it is running in',
    await hasText(page, `FluentFlow ${APP_VERSION}`, 5000),
  );
  // "not installed in this build" invites someone to go and install it. On the
  // desktop there is nothing to install.
  check(
    'settings calls the missing model permanent rather than uninstalled',
    await hasText(page, 'mobile-only module', 5000),
  );
  await shoot(page, '06-settings-desktop');

  // --- opening a deck with the app -----------------------------------------
  //
  // The whole reason this path exists: in a browser tab an import needs the
  // sync server *and* an account, for a file already on the disk. Here a second
  // copy of the app is started with a `.apkg` on its command line, which is what
  // double-clicking one in Explorer does. It should hand the file to the copy
  // already running and exit, rather than opening a second window over the same
  // database.
  const deckPath = writeSampleDeck();
  const second = spawn(session.executable, [deckPath, `--user-data-dir=${session.profile}`], {
    stdio: 'ignore',
    env: session.environment,
  });
  const secondExit = await waitForExit(second, 20000);
  check(
    'a second copy hands over its file and exits instead of opening a window',
    secondExit === 0,
    secondExit === null ? 'still running after 20s' : `exit ${secondExit}`,
  );

  await waitForText(page, 'spanish a1.apkg');
  check('the deck opened from Explorer reaches the import screen', true);
  // Named, not imported: the language and subdeck choices are still the user's.
  check('the import is offered rather than performed', await hasText(page, 'import as', 5000));

  await clickLabel(page, 'Import from Anki');
  await waitForText(page, 'import complete');
  check('the shell parses the deck with no server and no account', true);
  check('all sixty cards arrive', await hasText(page, '60 cards', 5000));
  await shoot(page, '07-import-complete');

  await clickLabel(page, 'Decks');
  await waitForText(page, 'spanish a1');
  check('the imported deck is in the list and usable straight away', true);
  await shoot(page, '08-imported-deck');

  // --- the window remembers itself -----------------------------------------
  //
  // The app tells the shell which theme it rendered, and the shell stores it
  // alongside the window's size. Neither is something the shell can work out on
  // its own: `nativeTheme` knows what Windows prefers, not that this user forced
  // light inside the app.
  await delay(1200); // the state writer debounces
  const state = readWindowState(session.profile);

  check('the window state is written to the profile', state !== null);
  check(
    'the app reported the theme it is rendering',
    state?.theme === 'light' || state?.theme === 'dark',
    state?.theme,
  );

  // Restoring it is the half a user sees, so it is checked against a real
  // relaunch: a stored size is written into the profile and the app is started
  // again over it. Electron does not implement the DevTools `Browser` domain,
  // so there is no way to resize the window from here and watch it be recorded —
  // `apps/desktop/test/window-state.test.mjs` covers the decision instead.
  const restored = await relaunchWith(session, { ...state, bounds: REMEMBERED_BOUNDS });
  check(
    'a relaunch opens at the remembered size',
    Math.abs((restored?.width ?? 0) - REMEMBERED_BOUNDS.width) <= 2 &&
      Math.abs((restored?.height ?? 0) - REMEMBERED_BOUNDS.height) <= 2,
    restored ? `${restored.width}x${restored.height}` : 'the app did not come back',
  );

  // --- nothing broke -------------------------------------------------------
  const blocked = consoleErrors.filter((message) => /Content Security Policy/i.test(message));
  check('the content security policy does not block the app', blocked.length === 0, blocked[0]);

  const fatal = consoleErrors.filter((message) => !/DevTools|Autofill|favicon/i.test(message));
  check('the renderer logged no errors', fatal.length === 0, fatal.slice(0, 2).join(' | '));
  check('the app did not crash', crashes.length === 0, crashes[0]);
}

// --- helpers ----------------------------------------------------------------

/**
 * A real Anki archive, written where Explorer would have one.
 *
 * Built here rather than checked in or taken from `npm run sample-deck`, so the
 * walkthrough needs nothing prepared: it uses the same fixture builder the core
 * and server test suites do, which means the bytes are a genuine SQLite
 * collection inside a genuine zip, `unicase` collation and all.
 */
function writeSampleDeck() {
  const path = join(mkdtempSync(join(tmpdir(), 'fluentflow-deck-')), 'Spanish A1.apkg');
  writeFileSync(
    path,
    buildApkg({
      schema: 18,
      decks: ['Spanish A1'],
      fieldNames: ['Front', 'Back', 'Example'],
      notes: spanishNotes(60),
    }),
  );
  return path;
}

/** Resolves to the exit code, or null if the process outlived the wait. */
function waitForExit(child, timeout) {
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), timeout);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done(code ?? 0);
    });
  });
}

/**
 * Stop the app, write a state file, start it again, and measure the window.
 *
 * `outerWidth` is the window rather than the page, so it is what the shell
 * actually opened — the point being that a restore is measured, not assumed.
 * The relaunch shares the profile, so it also proves the single-instance lock
 * released when the first copy exited.
 */
async function relaunchWith(session, state) {
  session.app.kill();
  await delay(1500);
  writeFileSync(join(session.profile, 'window-state.json'), JSON.stringify(state, null, 2));

  const relaunched = spawn(
    session.executable,
    [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${session.profile}`],
    { stdio: 'ignore', env: session.environment },
  );

  let browser;
  try {
    browser = await connectWhenReady();
    const pages = await browser.pages();
    const page = pages.find((candidate) => !candidate.url().startsWith('devtools://'));
    if (!page) return null;

    await waitForText(page, 'FluentFlow');
    return await page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));
  } catch {
    return null;
  } finally {
    await browser?.disconnect();
    // Under --headed this is the copy left on screen, since the first one had
    // to be stopped to write the state file it restores from.
    if (!options.headed) {
      relaunched.kill();
      await delay(500);
    }
  }
}

/** What the shell will read on the next launch. */
function readWindowState(profile) {
  try {
    return JSON.parse(readFileSync(join(profile, 'window-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function findExecutable() {
  const candidates = [
    join(ROOT, 'apps', 'desktop', 'dist', 'win-unpacked', 'FluentFlow.exe'),
    join(ROOT, 'apps', 'desktop', 'dist', 'mac', 'FluentFlow.app', 'Contents', 'MacOS', 'FluentFlow'),
    join(ROOT, 'apps', 'desktop', 'dist', 'linux-unpacked', 'fluentflow'),
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

/**
 * Click a control by its accessibility label.
 *
 * The last *visible* match, which is not the same as the last match. Earlier
 * screens stay mounted and hidden behind the current one, so a label that also
 * appears on a previous screen — "Import from Anki" is on both the deck list and
 * the import screen — would otherwise resolve to something nobody can click, and
 * `waitForSelector` checks the first match rather than searching for a usable
 * one.
 */
async function clickLabel(page, label) {
  const handle = await waitForVisible(page, `[aria-label="${label}"]`, label);
  await handle.click();
  await delay(250);
}

async function waitForVisible(page, selector, description, timeout = 20000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const matches = await page.$$(selector);
    for (const candidate of matches.reverse()) {
      const box = await candidate.boundingBox();
      if (box && box.width > 0 && box.height > 0) return candidate;
    }
    await delay(150);
  }

  // A bare "waiting for selector failed" says nothing about why. The labels
  // actually on screen usually say it in one line.
  const present = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label]')]
      .filter((node) => node.getBoundingClientRect().height > 0)
      .map((node) => node.getAttribute('aria-label')),
  );
  throw new Error(`No visible "${description}". On screen: ${present.join(' | ') || '(nothing)'}`);
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
  await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  const handle = await page.$(selector);
  await handle.click({ clickCount: 3 });
  await handle.type(value, { delay: 8 });
  await delay(150);
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

async function hasSelector(page, selector) {
  return (await page.$(selector)) !== null;
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
