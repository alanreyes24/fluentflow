#!/usr/bin/env node
/**
 * Turn the shared high-resolution source PNG into the icons electron-builder
 * wants.
 *
 *   apps/desktop/build/icon-source.png   1024×1024, generated with the favicon
 *        ↓
 *   apps/desktop/build/icon.icns         macOS app + DMG icon
 *   apps/desktop/build/icon.png          512×512, for the Linux AppImage
 *
 * Run on macOS and commit the results — the packaged build must not depend on
 * `sips` and `iconutil` having been run first.
 *
 *   node apps/desktop/scripts/make-icon.mjs        # from icon-source.png
 *
 * `scripts/make-icons.mjs` normally writes the source and invokes this script
 * on macOS. This file remains directly runnable for regenerating the ICNS.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SOURCE = join(BUILD_DIR, 'icon-source.png');
const ICNS = join(BUILD_DIR, 'icon.icns');
const PNG_512 = join(BUILD_DIR, 'icon.png');

mkdirSync(BUILD_DIR, { recursive: true });

if (process.platform !== 'darwin') {
  console.error('This needs `sips` and `iconutil`, which are macOS-only.');
  console.error('Run it on macOS after `scripts/make-icons.mjs` has written icon-source.png.');
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  console.error('Missing build/icon-source.png — run `node ../../scripts/make-icons.mjs` first.');
  process.exit(1);
}

const iconset = mkdtempSync(join(tmpdir(), 'fluentflow-iconset-')) + '/icon.iconset';
mkdirSync(iconset, { recursive: true });

try {
  for (const [size, name] of [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ]) {
    resize(SOURCE, join(iconset, name), size);
  }

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', ICNS], { stdio: 'inherit' });
  resize(SOURCE, PNG_512, 512);
  console.log(`Wrote ${ICNS} and ${PNG_512}`);
} finally {
  rmSync(dirname(iconset), { recursive: true, force: true });
}

function resize(from, to, size) {
  execFileSync('sips', ['-z', String(size), String(size), from, '--out', to], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
