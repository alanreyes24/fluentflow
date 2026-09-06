#!/usr/bin/env node
/**
 * Turn one source PNG into the icons electron-builder wants.
 *
 *   apps/desktop/build/icon-source.png   1024×1024, supplied by hand
 *        ↓
 *   apps/desktop/build/icon.icns         macOS app + DMG icon
 *   apps/desktop/build/icon.png          512×512, for the Linux AppImage
 *
 * Run once and commit the results — the packaged build must not depend on
 * `sips` and `iconutil` having been run first, and the icon changes rarely.
 *
 *   node apps/desktop/scripts/make-icon.mjs        # from a real icon-source.png
 *   node apps/desktop/scripts/make-icon.mjs        # or generate a placeholder
 *
 * If `icon-source.png` is missing, a plain placeholder is written so the build
 * pipeline works end to end; replace it with real art and run this again.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SOURCE = join(BUILD_DIR, 'icon-source.png');
const ICNS = join(BUILD_DIR, 'icon.icns');
const PNG_512 = join(BUILD_DIR, 'icon.png');

/** Lazily built CRC-32 table for the placeholder PNG encoder. */
let crcTable;

mkdirSync(BUILD_DIR, { recursive: true });

if (!existsSync(SOURCE)) {
  console.log('No build/icon-source.png — writing a placeholder. Replace it with real art.');
  writeFileSync(SOURCE, placeholderPng(1024));
}

if (process.platform !== 'darwin') {
  console.error('This needs `sips` and `iconutil`, which are macOS-only.');
  console.error('The committed icon.icns / icon.png are used until this is run on a Mac.');
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

// --- placeholder ------------------------------------------------------------

/**
 * A flat rounded tile with a single card on it. Deliberately plain — it exists
 * so the build has *something* that is not the Electron feather, not to be the
 * final icon.
 */
function placeholderPng(size) {
  const accent = [31, 111, 92, 255];
  const card = [251, 250, 248, 255];
  const clear = [0, 0, 0, 0];

  const tileInset = Math.round(size * 0.06);
  const tileRadius = Math.round(size * 0.22);
  const cardInsetX = Math.round(size * 0.24);
  const cardInsetY = Math.round(size * 0.3);
  const cardRadius = Math.round(size * 0.05);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let colour = clear;
      if (inRoundedRect(x, y, tileInset, tileInset, size - tileInset, size - tileInset, tileRadius)) {
        colour = accent;
      }
      if (
        inRoundedRect(
          x,
          y,
          cardInsetX,
          cardInsetY,
          size - cardInsetX,
          size - cardInsetY,
          cardRadius,
        )
      ) {
        colour = card;
      }
      // A divider line across the card, the way a flashcard splits front/back.
      if (
        x > cardInsetX + size * 0.04 &&
        x < size - cardInsetX - size * 0.04 &&
        Math.abs(y - size / 2) < size * 0.006
      ) {
        colour = accent;
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = colour[3];
    }
  }

  return encodePng(size, size, pixels);
}

function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const nx = Math.min(Math.max(x, left + radius), right - radius);
  const ny = Math.min(Math.max(y, top + radius), bottom - radius);
  return Math.hypot(x - nx, y - ny) <= radius;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
