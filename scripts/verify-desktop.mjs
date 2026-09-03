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
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = join(ROOT, '.desktop-shots');
const DEBUG_PORT = 9222;

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
  await shoot(page, '04-session-complete');

  // --- nothing broke -------------------------------------------------------
  const blocked = consoleErrors.filter((message) => /Content Security Policy/i.test(message));
  check('the content security policy does not block the app', blocked.length === 0, blocked[0]);

  const fatal = consoleErrors.filter((message) => !/DevTools|Autofill|favicon/i.test(message));
  check('the renderer logged no errors', fatal.length === 0, fatal.slice(0, 2).join(' | '));
  check('the app did not crash', crashes.length === 0, crashes[0]);
}

// --- helpers ----------------------------------------------------------------

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

async function clickLabel(page, label) {
  const selector = `[aria-label="${label}"]`;
  await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  const matches = await page.$$(selector);
  await matches[matches.length - 1].click();
  await delay(250);
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
