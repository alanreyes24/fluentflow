#!/usr/bin/env node
/**
 * Draw the app icon, the Android adaptive icon, the splash mark, the favicon,
 * the macOS source and the Windows `.ico`.
 *
 * A script rather than five checked-in binaries, for the same reason
 * `prepare-model.mjs` is a script: the design is then readable and arguable,
 * and changing the accent colour is an edit here rather than a round trip
 * through an image editor nobody has installed.
 *
 * It writes PNGs with `node:zlib` and no image dependencies. That sounds worse
 * than it is — a PNG is a header, one deflated block of scanlines and a
 * trailer, and the mark is two rounded rectangles. Pulling in a canvas
 * implementation to draw two rectangles would cost more than it saves.
 *
 *   node scripts/make-icons.mjs
 */

import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'apps', 'mobile', 'assets');
const DESKTOP_BUILD = join(ROOT, 'apps', 'desktop', 'build');
const DESKTOP_ICON_SCRIPT = join(ROOT, 'apps', 'desktop', 'scripts', 'make-icon.mjs');

/**
 * Sizes inside the Windows icon.
 *
 * Windows picks the nearest entry and scales the rest, and it asks for all of
 * these in different places: 16 in the title bar, 32 in the taskbar, 48 in
 * Explorer's medium view, 256 for the large view and the installer. Each is
 * drawn at its own size rather than downscaled from one big one, so the
 * antialiasing is computed for the pixels it actually occupies.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * The palette, kept in step with `apps/mobile/src/ui/theme.tsx` by hand.
 * These four are the only ones an icon needs, and duplicating them here beats
 * importing a React module into a build script.
 */
const ACCENT = [0x05, 0x96, 0x69]; // light `accent`
const ACCENT_DARK_THEME = [0x34, 0xd3, 0x99]; // dark `accent`
const CREAM = [0xf4, 0xf7, 0xf5]; // light `background`
const STANDARD_ICON = { background: ACCENT, ink: CREAM, scale: 0.8 };

/**
 * The mark: two cards, the one behind tilted away from the one in front.
 *
 * Flashcards are the product, so the mark is a pair of them rather than a
 * letterform — "FF" would read as initials at 1024px and as a smudge at 48.
 * The tilt is what stops the two rectangles reading as a single thick one.
 */
function mark(size) {
  const w = size * 0.46;
  const h = size * 0.62;
  const r = size * 0.09;
  return [
    { cx: size * 0.455, cy: size * 0.485, w, h, r, angle: -14, alpha: 0.45 },
    { cx: size * 0.545, cy: size * 0.515, w, h, r, angle: 7, alpha: 1 },
  ];
}

async function main() {
  await mkdir(ASSETS, { recursive: true });

  const outputs = [
    // The iOS icon and the store listing. The ground is full bleed - iOS
    // applies its own mask, and a rounded square inside a rounded mask reads
    // as a mistake - but the mark is inset, or the corner rounding clips it.
    { file: 'icon.png', size: 1024, background: ACCENT, ink: CREAM, scale: 0.78 },

    // Android masks the foreground to a shape of its choosing and can crop to
    // the inner 66%, so the mark is drawn smaller and the colour behind it is
    // set in app.json rather than painted in.
    { file: 'adaptive-icon.png', size: 1024, background: null, ink: CREAM, scale: 0.56 },

    // The splash mark sits on the app background, so it is drawn in the accent
    // instead of on it — once per theme, because a dark accent on a near-black
    // ground is not a splash screen, it is a rumour.
    { file: 'splash-icon.png', size: 512, background: null, ink: ACCENT, scale: 0.86 },
    {
      file: 'splash-icon-dark.png',
      size: 512,
      background: null,
      ink: ACCENT_DARK_THEME,
      scale: 0.86,
    },

    // Browser tabs. Drawn at its real size rather than downscaled from 1024,
    // so the antialiasing is computed for the pixels it will actually occupy.
    { file: 'favicon.png', size: 48, ...STANDARD_ICON },
  ];

  for (const output of outputs) {
    const pixels = render(output);
    await writeFile(join(ASSETS, output.file), encodePng(output.size, output.size, pixels));
    console.log(`  ${output.file} — ${output.size}x${output.size}`);
  }

  console.log(`\nWritten to ${ASSETS}`);

  // Keep the desktop source at the same design scale as the favicon. The
  // macOS iconset is built from this high-resolution copy below, while the
  // Windows icon keeps its own set of pixel-sized entries.
  await mkdir(DESKTOP_BUILD, { recursive: true });
  await writeFile(
    join(DESKTOP_BUILD, 'icon-source.png'),
    encodePng(1024, 1024, render({ size: 1024, ...STANDARD_ICON })),
  );
  console.log('  icon-source.png — 1024x1024 (macOS source)');

  // The desktop shell. Without this the packaged Windows app carries Electron's
  // own atom in the taskbar, the Start menu and the installer.
  const ico = encodeIco(
    ICO_SIZES.map((size) => ({
      size,
      png: encodePng(size, size, render({ size, ...STANDARD_ICON })),
    })),
  );
  await writeFile(join(DESKTOP_BUILD, 'icon.ico'), ico);
  console.log(`  icon.ico — ${ICO_SIZES.join(', ')}`);
  console.log(`Written to ${DESKTOP_BUILD}`);

  // iconutil and sips are macOS-only. On that platform, build the checked-in
  // ICNS from the same source used for the favicon so `npm run build` cannot
  // leave the app icon behind when the mark changes.
  if (process.platform === 'darwin') {
    execFileSync(process.execPath, [DESKTOP_ICON_SCRIPT], { stdio: 'inherit' });
  }
}

// --- drawing ----------------------------------------------------------------

function render({ size, background, ink, scale }) {
  const pixels = new Uint8Array(size * size * 4);

  if (background) {
    for (let i = 0; i < size * size; i++) {
      pixels[i * 4] = background[0];
      pixels[i * 4 + 1] = background[1];
      pixels[i * 4 + 2] = background[2];
      pixels[i * 4 + 3] = 255;
    }
  }

  for (const card of mark(size)) {
    const scaled = {
      ...card,
      // Scale about the centre, so a smaller mark stays centred.
      cx: size / 2 + (card.cx - size / 2) * scale,
      cy: size / 2 + (card.cy - size / 2) * scale,
      w: card.w * scale,
      h: card.h * scale,
      r: card.r * scale,
    };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Sample at the pixel centre; the distance field is then in pixels and
        // half a pixel either side of the edge is exactly the coverage ramp.
        const distance = roundedRect(x + 0.5, y + 0.5, scaled);
        const coverage = clamp(0.5 - distance, 0, 1) * scaled.alpha;
        if (coverage > 0) blend(pixels, (y * size + x) * 4, ink, coverage);
      }
    }
  }

  return pixels;
}

/** Signed distance to a rotated rounded rectangle: negative inside. */
function roundedRect(px, py, { cx, cy, w, h, r, angle }) {
  const radians = (-angle * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  const x = Math.abs(dx * Math.cos(radians) - dy * Math.sin(radians)) - (w / 2 - r);
  const y = Math.abs(dx * Math.sin(radians) + dy * Math.cos(radians)) - (h / 2 - r);
  const outside = Math.hypot(Math.max(x, 0), Math.max(y, 0));
  const inside = Math.min(Math.max(x, y), 0);
  return outside + inside - r;
}

/** Source-over, carrying the destination alpha so transparent output works. */
function blend(pixels, offset, colour, alpha) {
  const dstAlpha = pixels[offset + 3] / 255;
  const outAlpha = alpha + dstAlpha * (1 - alpha);
  if (outAlpha === 0) return;

  for (let channel = 0; channel < 3; channel++) {
    const dst = pixels[offset + channel];
    pixels[offset + channel] = Math.round(
      (colour[channel] * alpha + dst * dstAlpha * (1 - alpha)) / outAlpha,
    );
  }
  pixels[offset + 3] = Math.round(outAlpha * 255);
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

// --- PNG --------------------------------------------------------------------

function encodePng(width, height, rgba) {
  // Filter byte 0 (none) per scanline. The image is flat colour over flat
  // colour, so deflate does the work and a filter would only get in its way.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --- ICO --------------------------------------------------------------------

/**
 * A directory of PNGs, which is all a modern `.ico` is.
 *
 * The format also allows raw BMP entries, and before Vista that was the only
 * option — hence most of the complexity in icon writers. Windows 7 onwards
 * reads PNG entries at every size, and every Windows this app can run on is
 * well past that, so the images go in exactly as `encodePng` produced them.
 *
 * @param images `{ size, png }`, one per entry
 */
function encodeIco(images) {
  const HEADER = 6;
  const ENTRY = 16;

  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon, 2 = cursor
  header.writeUInt16LE(images.length, 4);

  let offset = HEADER + images.length * ENTRY;
  const directory = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(ENTRY);
    // 256 is written as 0: the field is one byte, and 256 does not fit in it.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette size, meaningless for 32-bit colour
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...directory, ...images.map(({ png }) => png)]);
}

await main();
