#!/usr/bin/env node
/**
 * Record which desktop shell the web app is built against.
 *
 * The desktop app downloads the hosted web build instead of waiting for a
 * rebuild (see `apps/desktop/src/web-bundle.js`), but only when the bundle was
 * built for the same shell: a bundle that calls a bridge method the installed
 * shell lacks would break. The shell's fingerprint is written into the web
 * app's `public/desktop-shell.json`, which every web export carries, and the
 * server publishes it with the bundle manifest.
 *
 *   node scripts/desktop-shell-fingerprint.mjs          # write it
 *   node scripts/desktop-shell-fingerprint.mjs --check  # fail if it is stale
 *
 * The desktop build runs the first; the desktop tests run the second, so a
 * shell change that was not recorded fails CI instead of silently blocking
 * updates.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const OUTPUT = join(ROOT, 'apps', 'mobile', 'public', 'desktop-shell.json');

const { shellFingerprint } = createRequire(import.meta.url)(join(DESKTOP, 'src', 'web-bundle.js'));
const fingerprint = shellFingerprint(DESKTOP);
const contents = `${JSON.stringify({ fingerprint }, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let recorded = null;
  try {
    recorded = JSON.parse(readFileSync(OUTPUT, 'utf8')).fingerprint;
  } catch {
    // Missing or unreadable reads as stale below.
  }
  if (recorded !== fingerprint) {
    console.error(
      'apps/mobile/public/desktop-shell.json is out of date with the desktop shell.\n' +
        'Run: node scripts/desktop-shell-fingerprint.mjs',
    );
    process.exit(1);
  }
} else {
  writeFileSync(OUTPUT, contents);
  console.log(`desktop shell fingerprint ${fingerprint.slice(0, 12)} → ${OUTPUT}`);
}
