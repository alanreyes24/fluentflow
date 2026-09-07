'use strict';

/**
 * Where the window was, and what it looked like, last time.
 *
 * A desktop app that reopens at 1100×800 in the middle of the screen every
 * launch is the clearest tell that something is a wrapped web page. Four things
 * are remembered here, and each has a failure mode worth naming:
 *
 *  - **Bounds.** Restored only if they still land on a display that exists. A
 *    laptop undocked from a second monitor would otherwise reopen the window at
 *    x=2400, off every screen, with no way to drag it back.
 *  - **Maximised.** Stored separately from the bounds, so un-maximising returns
 *    the window to the size it had before rather than to the screen's.
 *  - **Zoom.** Applied as a `zoomFactor` before the first paint rather than set
 *    after load, so the app does not visibly re-lay-out on every launch.
 *  - **Theme.** Not the app's setting — a copy of what the app last rendered, so
 *    the *next* cold start can paint the right background before the bundle
 *    loads. `nativeTheme` alone cannot tell us this: it knows what Windows
 *    prefers, not that this user forced light inside the app.
 *
 * Writes are debounced, because `resize` and `move` fire continuously while a
 * window is being dragged, and this is a file on disk.
 */

const { app, screen } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const FILENAME = 'window-state.json';
const WRITE_DELAY_MS = 400;

const DEFAULT_BOUNDS = { width: 1100, height: 800 };
const MIN_WIDTH = 480;
const MIN_HEIGHT = 520;

/** How much of the window has to be on a display for someone to drag it back. */
const GRABBABLE = { width: 120, height: 60 };

/**
 * The app's own background colours, so a cold start does not flash. These are
 * `background` from the light and dark palettes in
 * `apps/mobile/src/ui/theme.tsx`; they are duplicated because the shell needs
 * them before any bundle has loaded.
 */
const BACKGROUNDS = { light: '#f4f7f5', dark: '#0b1512' };

/** What `nativeTheme.themeSource` accepts, and what the app's setting offers. */
const THEME_SOURCES = ['system', 'light', 'dark'];

/** Chromium's zoom ratio: one step is 1.2x, the same as Ctrl+Plus. */
const ZOOM_STEP = 1.2;
/** Roughly 50% to 300%, past which the app is unusable rather than zoomed. */
const ZOOM_RANGE = [-3.8, 6.0];

function clampZoom(level) {
  return Math.min(Math.max(level, ZOOM_RANGE[0]), ZOOM_RANGE[1]);
}

function statePath() {
  return path.join(app.getPath('userData'), FILENAME);
}

function read() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    // No file on first launch, and a corrupt one is not worth reporting: the
    // defaults below are a perfectly good window.
    return {};
  }
}

let pending = null;
let queued = {};

function write(patch) {
  queued = { ...queued, ...patch };
  if (pending) clearTimeout(pending);
  pending = setTimeout(flush, WRITE_DELAY_MS);
}

function flush() {
  if (pending) clearTimeout(pending);
  pending = null;
  if (Object.keys(queued).length === 0) return;

  const merged = { ...read(), ...queued };
  queued = {};
  try {
    writeFileSync(statePath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch {
    // A read-only or full profile directory is not a reason to fail a launch.
  }
}

/**
 * The bounds to open with, given what was stored and which displays exist.
 *
 * Pure, and exported, because this is the part with a decision in it: stored
 * bounds are only usable if a display still contains enough of them to grab.
 * A laptop undocked from a second monitor has bounds at x=2400 in its state
 * file, and restoring those opens the window where nobody can reach it.
 *
 * @param stored the `bounds` field of the state file, or undefined
 * @param displays `screen.getAllDisplays()`, or a stand-in in tests
 */
function chooseBounds(stored, displays) {
  if (!isVisible(stored, displays)) return { ...DEFAULT_BOUNDS };

  return {
    x: stored.x,
    y: stored.y,
    width: Math.max(MIN_WIDTH, Math.round(stored.width)),
    height: Math.max(MIN_HEIGHT, Math.round(stored.height)),
  };
}

function isVisible(bounds, displays) {
  if (!bounds) return false;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(bounds[key])) return false;
  }

  return displays.some(({ workArea }) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    // A sliver on screen is not enough to grab a title bar with.
    return overlapX > GRABBABLE.width && overlapY > GRABBABLE.height;
  });
}

/**
 * What `new BrowserWindow` should be given, plus whether to maximise afterwards.
 *
 * `maximize()` is deliberately not folded into the constructor options: Electron
 * has no such option, and calling it before `show` is what avoids a visible
 * resize on launch.
 */
function restore() {
  const stored = read();
  const usable = chooseBounds(stored.bounds, screen.getAllDisplays());

  const theme = stored.theme === 'dark' ? 'dark' : 'light';
  const themeSource = THEME_SOURCES.includes(stored.themeSource) ? stored.themeSource : 'system';
  const zoomLevel = Number.isFinite(stored.zoomLevel) ? clampZoom(stored.zoomLevel) : 0;

  return {
    bounds: usable,
    maximized: stored.maximized === true,
    fullScreen: stored.fullScreen === true,
    // Chromium's own conversion between the two scales: `BrowserWindow` takes a
    // factor, `webContents` reports a level.
    zoomFactor: Math.pow(ZOOM_STEP, zoomLevel),
    theme,
    themeSource,
    backgroundColor: BACKGROUNDS[theme],
  };
}

/** Start recording what the user does to the window. */
function track(window) {
  const record = () => {
    // `getNormalBounds` is the restored size even while maximised, which is
    // exactly what un-maximising should return to.
    const patch = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    };
    // The menu's zoom roles change the level without emitting `zoom-changed`,
    // which only covers the mouse wheel — so read it here too.
    try {
      patch.zoomLevel = window.webContents.getZoomLevel();
    } catch {
      // The contents are gone; the last recorded level stands.
    }
    write(patch);
  };

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    window.on(event, record);
  }

  window.webContents.on('zoom-changed', () => {
    write({ zoomLevel: window.webContents.getZoomLevel() });
  });

  // `close` rather than `closed`: the window still has bounds to read here.
  window.on('close', () => {
    record();
    flush();
  });
}

/**
 * Remember the theme the app is actually rendering, for the next cold start.
 *
 * Both halves matter: `name` is what to paint the window before the bundle
 * loads, `preference` is whether the next launch should follow the system at
 * all — which is what decides the title bar on Windows.
 */
function rememberTheme(name, preference) {
  if (name !== 'light' && name !== 'dark') return;
  const patch = { theme: name };
  if (THEME_SOURCES.includes(preference)) patch.themeSource = preference;
  write(patch);
}

module.exports = {
  restore,
  track,
  rememberTheme,
  flush,
  chooseBounds,
  BACKGROUNDS,
  DEFAULT_BOUNDS,
  MIN_WIDTH,
  MIN_HEIGHT,
};
