#!/usr/bin/env node
/**
 * Drive the real web build through a real browser.
 *
 * `verify-flow.mjs` covers everything under the UI: two devices, one account,
 * an Anki archive and a network that comes and goes. What it cannot cover is
 * the layer the user actually touches. This walks the success criteria from
 * the brief through Chrome, against the exported bundle rather than a dev
 * server, so what is tested is what would ship.
 *
 * It uses `puppeteer-core` and the Chrome already installed on the machine —
 * downloading a second browser to test a flashcard app is not a reasonable
 * trade.
 *
 *   node scripts/verify-web.mjs               # headless
 *   node scripts/verify-web.mjs --headed      # watch it happen
 *   node scripts/verify-web.mjs --keep-build  # reuse the last export
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { MemoryStore } from '../apps/server/src/store/memory.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_DIR = join(ROOT, '.web-export');
const SHOTS_DIR = join(ROOT, '.web-export-shots');

const options = parseArgs(process.argv.slice(2));
const checks = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

async function main() {
  if (!options.keepBuild || !existsSync(join(EXPORT_DIR, 'index.html'))) {
    await buildWebExport();
  }

  const sync = await startSyncServer();
  const site = await startStaticServer();
  const browser = await launchChrome();
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });

  try {
    await run(page, site.url);
  } catch (error) {
    check('the walkthrough ran to completion', false, String(error?.message ?? error));
    // A screenshot and the visible text of wherever it stopped: a selector
    // timeout says nothing about which screen the app was actually on.
    await shoot(page, 'failure');
    console.log('');
    console.log('On screen when it failed:');
    console.log(indent(await bodyText(page)));
  } finally {
    await browser.close();
    await Promise.all([closeServer(site.server), closeServer(sync)]);
  }

  report();
}

// --- the walkthrough --------------------------------------------------------

async function run(page, baseUrl) {
  // A thrown error is a failure even if the UI limps on afterwards.
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  // --- 1. The bundle loads at all ------------------------------------------
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await waitForText(page, 'FluentFlow');
  check('the exported bundle boots', true);
  await shoot(page, '01-sign-in');

  // --- 2. Start without an account -----------------------------------------
  // Firebase is unconfigured in app.json, so this is the only way in — and the
  // one a first-time user takes.
  await clickLabel(page, 'Continue without an account');
  await waitForText(page, 'No decks yet');
  check('an account-less session reaches the deck list', true);

  // --- 3. Create a Spanish deck --------------------------------------------
  await clickLabel(page, 'New deck');
  await typeInto(page, 'Deck name', 'Spanish Verbs');
  await clickLabel(page, 'Create deck');
  await waitForText(page, 'Spanish Verbs');
  check('a Spanish deck is created and opened', true);

  // --- 4. Add cards ---------------------------------------------------------
  const words = [
    ['hablar', 'to speak'],
    ['comer', 'to eat'],
    ['vivir', 'to live'],
  ];
  for (const [front, back] of words) {
    // The form stays open after a save so several cards can be entered in a
    // row, so the button is only there for the first one.
    if (await hasSelector(page, '[aria-label="Add card"]')) {
      await clickLabel(page, 'Add card');
    }
    await typeInto(page, 'Word or phrase', front);
    await typeInto(page, 'Meaning or translation', back);
    await clickLabel(page, 'Save');
    await waitForText(page, front);
  }
  await clickLabel(page, 'Cancel');
  check(`${words.length} cards are added and listed`, true, words.map(([word]) => word).join(', '));
  await shoot(page, '02-deck');

  // --- 5. Study: reveal, then rate -----------------------------------------
  await clickText(page, /^Study/);
  await waitForText(page, 'Show answer');
  const frontOnly = await bodyText(page);
  check(
    'the answer is hidden until asked for',
    !frontOnly.includes('to speak') && !frontOnly.includes('to eat'),
  );
  await shoot(page, '03-card-front');

  await clickLabel(page, 'Show answer');
  await waitForText(page, 'Again');
  const onReveal = await bodyText(page);
  check('revealing shows the meaning', /to (speak|eat|live)/.test(onReveal));
  // The rating buttons are live before the examples arrive, by design — the
  // brief's budget is about not making a learner wait. So the examples get
  // their own wait rather than being asserted in the same breath.
  check('the ratings are live before the examples arrive', /Again/.test(onReveal));

  const examplesArrived = await hasText(page, 'examples', 15000);
  const revealed = (await bodyText(page)).toLowerCase();
  check(
    'example sentences appear with the answer',
    examplesArrived,
    examplesArrived ? undefined : lastError(consoleErrors),
  );
  check(
    'fallback sentences are labelled rather than passed off as generated',
    revealed.includes('offline examples'),
    'no model is installed in this build',
  );
  check(
    'the fallback says why it is generic',
    revealed.includes('the on-device model was unavailable'),
  );
  await shoot(page, '04-card-revealed');

  // --- 6. The keyboard shortcut the brief asks for --------------------------
  const beforeRating = await progressCounter(page);
  await page.keyboard.press('3');
  const advanced = await waitFor(page, (previous) => !document.body.innerText.includes(previous), {
    arg: beforeRating,
    timeout: 8000,
  });
  check('pressing 3 rates the card Good and advances', advanced, `was ${beforeRating}`);

  // --- 7. The review survives a reload -------------------------------------
  // This is the only thing that exercises expo-sqlite's wasm backend and its
  // browser-side persistence; nothing else in the repository touches it.
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2' });
  await waitForText(page, 'FluentFlow');
  // An account-less session lives in React state, so a reload lands back on
  // sign-in. Waiting generously here: the database has to open and migrate
  // before the app decides which screen to show, and giving up early would
  // read as lost data rather than as a slow start.
  await resumeOfflineSession(page);
  const persisted = await hasText(page, 'Spanish Verbs', 15000);
  check(
    'the deck and its review survive a page reload',
    persisted,
    persisted ? 'SQLite persisted in the browser' : `on screen: ${await oneLine(page)}`,
  );

  if (persisted) {
    // Deck rows carry "<name>, <n> due" as their accessible label, so match on
    // the prefix rather than the whole string — the due count is the thing
    // under test and should not have to be predicted here.
    await clickLabelPrefix(page, 'Spanish Verbs');
    await waitForText(page, 'hablar');
    const counts = await bodyText(page);
    const breakdown = counts.match(/(New|Learning|Mastered) \d+/g);
    check(
      'the rated card is counted as learning, not new',
      /Learning 1/.test(counts),
      breakdown?.join(' · '),
    );
    await shoot(page, '05-after-reload');
  }

  // --- 8. The statistics those reviews just produced ------------------------
  // The streak is the one number a user will argue with, and it is computed
  // from local calendar days — worth watching it appear in a real browser,
  // where the timezone is the machine's rather than a test's.
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2' });
  await resumeOfflineSession(page);

  if (await hasText(page, 'Spanish Verbs', 15000)) {
    await shoot(page, '06-decks');
    await clickLabel(page, 'Statistics');
    const statsReady = await hasText(page, 'Day streak', 10000);
    check('the statistics screen opens from the deck list', statsReady);

    if (statsReady) {
      const stats = await bodyText(page);
      check(
        'the streak counts the day the review was made',
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
      await shoot(page, '07-statistics');
    }
  }

  // --- 9. The interface follows the language choice -------------------------
  // A deep link is served the app rather than a 404 — that is the SPA
  // fallback working. It then lands on sign-in, because an account-less
  // session lives in memory and a cold load has no one signed in. That is the
  // app being honest about not knowing who you are, not a routing failure.
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle2' });
  const servedApp = await hasText(page, 'FluentFlow', 10000);
  check('a deep link is served the app rather than a 404', servedApp);

  await resumeOfflineSession(page);
  if (await hasText(page, 'Spanish Verbs', 15000)) {
    await clickLabel(page, 'Settings');
  }
  const settingsReady = await hasText(page, 'Interface language', 10000);
  check('settings opens from the deck list', settingsReady);

  if (settingsReady) {
    await clickLabel(page, 'Bosanski');
    check('choosing Bosnian re-renders the interface', await hasText(page, 'Jezik sučelja', 5000));
    await shoot(page, '08-bosnian');

    await clickLabel(page, 'Español');
    check(
      'choosing Spanish re-renders the interface',
      await hasText(page, 'Idioma de la interfaz', 5000),
    );
    await clickLabel(page, 'English');
  }

  // --- 10. Nothing threw along the way -------------------------------------
  const fatal = consoleErrors.filter(isFatal);
  check(
    'the app logged no errors during the walkthrough',
    fatal.length === 0,
    fatal.slice(0, 3).join(' | '),
  );
}

/** The most recent real error, for a check that failed without saying why. */
function lastError(errors) {
  const real = errors.filter(isFatal);
  return real.length > 0 ? real[real.length - 1].slice(0, 300) : 'no error was logged';
}

/** Browser noise that says nothing about the app. */
function isFatal(message) {
  return !/favicon|React DevTools|ERR_CONNECTION_REFUSED|net::ERR_FAILED/i.test(message);
}

// --- page helpers -----------------------------------------------------------

/**
 * React Native Web maps `accessibilityLabel` onto `aria-label`, so every
 * Button in the app is addressable by the same string the unit tests use and a
 * screen reader announces.
 */
async function clickLabel(page, label) {
  await clickSelector(page, `[aria-label="${label}"]`);
}

/** Click a control whose accessible label starts with the given text. */
async function clickLabelPrefix(page, prefix) {
  await clickSelector(page, `[aria-label^="${prefix}"]`);
}

/**
 * A real click, not a synthesised event.
 *
 * `dispatchEvent(new MouseEvent('click'))` looks equivalent and is not: deck
 * rows are an expo-router `Link` rendering an anchor, and a synthetic event
 * runs the anchor's default navigation instead of the router's handler. That
 * reloads the whole document, which drops the in-memory session and lands back
 * on sign-in — a convincing imitation of a bug that is not there. Driving the
 * mouse through the browser exercises the same path a person does.
 */
async function clickSelector(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  const matches = await page.$$(selector);
  // The last match, where a label is shared: the later element is the explicit
  // control rather than a container that wraps it.
  await matches[matches.length - 1].click();
  await settle(page);
}

/** Click the deepest element whose text matches, for controls with no label. */
async function clickText(page, pattern) {
  const { source, flags } = pattern;
  await page.waitForFunction(
    (src, flg) => {
      const expression = new RegExp(src, flg);
      return [...document.querySelectorAll('div,span,a')].some((node) =>
        expression.test((node.textContent ?? '').trim()),
      );
    },
    { timeout: 15000 },
    source,
    flags,
  );
  await page.evaluate(
    (src, flg) => {
      const expression = new RegExp(src, flg);
      const nodes = [...document.querySelectorAll('div,span,a')].filter((node) =>
        expression.test((node.textContent ?? '').trim()),
      );
      // The deepest match is the text itself rather than a layout wrapper.
      nodes[nodes.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
    source,
    flags,
  );
  await settle(page);
}

async function typeInto(page, label, value) {
  const selector = `input[aria-label="${label}"], textarea[aria-label="${label}"]`;
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  const handle = await page.$(selector);
  await handle.click({ clickCount: 3 });
  await handle.type(value, { delay: 8 });
  await settle(page);
}

async function oneLine(page) {
  return (await bodyText(page)).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

/**
 * Get back past the sign-in screen after a reload, if it is showing.
 *
 * Not every reload lands there — expo-router may restore the previous route
 * first — so this is tolerant of the button never appearing.
 */
async function resumeOfflineSession(page) {
  if (await hasText(page, 'Continue without an account', 15000)) {
    await clickLabel(page, 'Continue without an account');
    await settle(page);
  }
}

/** Is this control on screen right now? Does not wait. */
function hasSelector(page, selector) {
  return page.evaluate((sel) => document.querySelector(sel) !== null, selector);
}

async function waitForText(page, text) {
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    { timeout: 20000 },
    text,
  );
}

/**
 * `waitForText` that reports rather than throws, for optional expectations.
 *
 * Case-insensitive on purpose. Several labels are uppercased with
 * `textTransform`, and Chrome's `innerText` reflects the transform — so a
 * section heading written "Interface language" reaches the DOM as
 * "INTERFACE LANGUAGE" and an exact match would fail against a correct app.
 */
async function hasText(page, text, timeout) {
  return waitFor(page, (needle) => document.body.innerText.toLowerCase().includes(needle), {
    arg: text.toLowerCase(),
    timeout,
  });
}

async function waitFor(page, predicate, { arg, timeout }) {
  try {
    await page.waitForFunction(predicate, { timeout }, arg);
    return true;
  } catch {
    return false;
  }
}

function progressCounter(page) {
  return page.evaluate(() => document.body.innerText.match(/\d+\s*\/\s*\d+/)?.[0] ?? '');
}

/** Let React commit and any animation land before the next interaction. */
function settle(page) {
  return new Promise((done) => setTimeout(done, 250));
}

async function shoot(page, name) {
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

// --- servers ----------------------------------------------------------------

async function buildWebExport() {
  console.log('Building the web export…');
  await rm(EXPORT_DIR, { recursive: true, force: true });
  await runCommand('npx', ['expo', 'export', '--platform', 'web', '--output-dir', EXPORT_DIR], {
    cwd: join(ROOT, 'apps', 'mobile'),
  });
}

/**
 * A static server with SPA fallback.
 *
 * The fallback is the point: `web.output: "single"` produces one index.html,
 * and a deep link such as /settings has to reach it rather than 404 — the same
 * reason the Electron shell registers a custom scheme instead of using file://.
 */
function startStaticServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(EXPORT_DIR, requested);

    if (!filePath.startsWith(EXPORT_DIR)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || !extname(filePath)) {
      filePath = join(EXPORT_DIR, 'index.html');
    }

    // Deliberately *not* cross-origin isolated.
    //
    // Sending COOP/COEP looks like the careful thing to do — OPFS and
    // SharedArrayBuffer are usually mentioned together — but it breaks this
    // app. Cross-origin isolation makes wa-sqlite select a synchronous access
    // handle VFS, and OPFS allows one access handle per file, so a reload
    // starts the new document while the old one still holds it:
    // `NoModificationAllowedError`, and the app cannot start. Without the
    // headers a reload is clean. This is a deployment caveat, recorded here
    // because it is invisible until someone enables the headers for an
    // unrelated reason.
    response.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  });

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({ server, url: `http://localhost:${server.address().port}` });
    });
  });
}

function startSyncServer() {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', PORT: '8787' });
  const app = createApp({ config, store: new MemoryStore() });
  return new Promise((done) => {
    const server = app.listen(8787, '127.0.0.1', () => done(server));
  });
}

function closeServer(server) {
  return new Promise((done) => server.close(done));
}

async function launchChrome() {
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('No Chrome or Edge found. Install one, or set CHROME_PATH to its executable.');
  }

  return puppeteer.launch({
    executablePath,
    headless: !options.headed,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

// --- plumbing ---------------------------------------------------------------

function runCommand(command, args, opts) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true, ...opts });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited with ${code}`)),
    );
  });
}

function parseArgs(argv) {
  return {
    headed: argv.includes('--headed'),
    keepBuild: argv.includes('--keep-build'),
  };
}

function indent(text) {
  return text
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n');
}

function check(description, passed, detail) {
  checks.push({ description, passed, detail });
  console.log(`  ${passed ? '\u2713' : '\u2717'} ${description}${detail ? ` — ${detail}` : ''}`);
}

function report() {
  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const entry of failed) console.log(`  \u2717 ${entry.description}`);
  }
  console.log(`Screenshots in ${SHOTS_DIR}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
