'use strict';

/**
 * Remember the window's size and position between launches.
 *
 * Electron does not do this for you, and `NSQuitAlwaysKeepsWindows` is off, so
 * without this every launch is the same hardcoded rectangle in whatever spot
 * macOS decides. A ~50-line file writing one JSON blob is enough — the
 * `electron-window-state` package does the same thing plus a display-change
 * listener this does not need.
 *
 * The saved rectangle is validated against the current displays before it is
 * used: a window restored onto a monitor that has since been unplugged would
 * open off-screen with no way to drag it back.
 */

const path = require('node:path');
const { readFileSync, writeFileSync } = require('node:fs');
const { app, screen } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'window-state.json');

/** Defaults, used on first launch and whenever the saved state is unusable. */
const DEFAULT = { width: 1100, height: 800 };

function read() {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8'));
    if (
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height) &&
      parsed.width >= 480 &&
      parsed.height >= 520
    ) {
      return parsed;
    }
  } catch {
    // No file yet, or it was hand-edited into nonsense. Fall through.
  }
  return null;
}

/** Is the rectangle's centre inside some display's work area? */
function onAVisibleDisplay(bounds) {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      cx >= workArea.x &&
      cx <= workArea.x + workArea.width &&
      cy >= workArea.y &&
      cy <= workArea.y + workArea.height
    );
  });
}

/**
 * The bounds to open the next window with, and whether it should be maximized.
 *
 * `x`/`y` are omitted when there is no usable saved position, which lets the OS
 * place the window itself.
 */
function initialState() {
  const saved = read();
  if (!saved) return { bounds: { ...DEFAULT }, maximized: false };

  const bounds = { width: saved.width, height: saved.height };
  if (saved.x != null && saved.y != null && onAVisibleDisplay(saved)) {
    bounds.x = saved.x;
    bounds.y = saved.y;
  }
  return { bounds, maximized: Boolean(saved.isMaximized) };
}

/**
 * Persist the window's rectangle as it changes.
 *
 * `getNormalBounds()` rather than `getBounds()` so a maximized or full-screen
 * window still records the size it will return to. Writes are debounced because
 * a drag fires `move` continuously.
 */
function track(window) {
  let timer;

  const save = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    try {
      writeFileSync(
        FILE(),
        JSON.stringify({ ...bounds, isMaximized: window.isMaximized() }),
      );
    } catch {
      // A failed write just means the next launch uses the previous state.
    }
  };

  const scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
    timer.unref?.();
  };

  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

module.exports = { initialState, track };
