import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

/**
 * Which bounds a launch opens with.
 *
 * The rest of the window state is a file read and a debounced write, and
 * `verify-desktop.mjs` covers those against the real packaged app. This is the
 * part with a judgement in it: a stored position is only worth restoring if a
 * display still contains enough of the window to grab. Getting that wrong opens
 * the app somewhere the user cannot reach it and cannot drag it back from —
 * which is the state a laptop is in every time it is undocked.
 *
 * `chooseBounds` takes the displays rather than asking Electron for them, so the
 * awkward monitor arrangements can be written down here instead of plugged in.
 */

const require = createRequire(import.meta.url);
const { chooseBounds, DEFAULT_BOUNDS, MIN_WIDTH, MIN_HEIGHT } = require('../src/window-state.js');

/** A single 1920×1080 screen with a taskbar along the bottom. */
const LAPTOP = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];

/** The same laptop with a second monitor to the right of it. */
const DOCKED = [...LAPTOP, { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }];

test('restores a window that is still on a screen', () => {
  const stored = { x: 200, y: 120, width: 1280, height: 900 };
  assert.deepEqual(chooseBounds(stored, LAPTOP), stored);
});

test('restores a window from the second monitor while it is still attached', () => {
  const stored = { x: 2400, y: 200, width: 1200, height: 800 };
  assert.deepEqual(chooseBounds(stored, DOCKED), stored);
});

test('falls back to the default once that monitor is gone', () => {
  const stored = { x: 2400, y: 200, width: 1200, height: 800 };
  assert.deepEqual(chooseBounds(stored, LAPTOP), DEFAULT_BOUNDS);
});

test('refuses a position with only a sliver on screen', () => {
  // Sixty pixels of title bar is not enough to aim at.
  const stored = { x: 1860, y: 400, width: 1100, height: 800 };
  assert.deepEqual(chooseBounds(stored, LAPTOP), DEFAULT_BOUNDS);
});

test('opens at the default with nothing stored', () => {
  assert.deepEqual(chooseBounds(undefined, LAPTOP), DEFAULT_BOUNDS);
});

test('ignores a state file someone has edited into nonsense', () => {
  for (const stored of [
    { x: 0, y: 0, width: 'wide', height: 800 },
    { x: Number.NaN, y: 0, width: 1100, height: 800 },
    { width: 1100, height: 800 },
    null,
  ]) {
    assert.deepEqual(chooseBounds(stored, LAPTOP), DEFAULT_BOUNDS);
  }
});

test('never restores a window too small to use', () => {
  // A stored size can be below the minimum — a window manager that ignores
  // `minWidth`, or a state file edited by hand — and the app is unusable at
  // 200x300. The position is still honoured; only the size is corrected.
  const chosen = chooseBounds({ x: 100, y: 100, width: 200, height: 300 }, LAPTOP);
  assert.deepEqual(chosen, { x: 100, y: 100, width: MIN_WIDTH, height: MIN_HEIGHT });
});
