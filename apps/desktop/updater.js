'use strict';

/**
 * Auto-update, through electron-updater and the GitHub Releases feed configured
 * in package.json's `build.publish`.
 *
 * State of play per platform:
 *
 *  - **Windows** works now. An unsigned NSIS build updates itself fine; the only
 *    friction is SmartScreen on the very first download, which an update is not.
 *  - **macOS** does not, yet. Squirrel.Mac refuses to update a bundle that is not
 *    signed with a Developer ID — `autoUpdater` raises "Could not get code
 *    signature for running application" and stops. That check is wired here
 *    anyway so it starts working the moment real signing is switched on (see
 *    the entitlements/notarize notes in package.json and the README). Until
 *    then the error handler swallows it.
 *
 * Nothing here runs in development or against the Metro dev server — an
 * unpackaged app has no feed to check against.
 */

const path = require('node:path');
const { existsSync } = require('node:fs');
const { app, dialog } = require('electron');

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * electron-builder writes this next to the app when `publish` is configured and
 * a real installer is built. A `--dir` / `pack` build has no feed to check, and
 * `checkForUpdates()` throws (loudly) without it.
 */
function hasUpdateConfig() {
  return (
    existsSync(path.join(process.resourcesPath, 'app-update.yml')) ||
    existsSync(path.join(app.getAppPath(), 'dev-app-update.yml'))
  );
}

let autoUpdater;
let mainWindow = null;
let started = false;

function load() {
  if (!autoUpdater) ({ autoUpdater } = require('electron-updater'));
  return autoUpdater;
}

/** A signature failure on an ad-hoc macOS build is the expected state, not a bug. */
function isExpectedUnsignedError(error) {
  return /code signature|not signed|Developer ID/i.test(String(error?.message ?? error));
}

function wire() {
  const updater = load();
  // electron-updater logs its own failures through electron-log by default,
  // which reaches stderr and reads like a crash to a build check. The dialog
  // path and the events below are all the signal that is wanted.
  updater.logger = null;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('update-downloaded', async (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `FluentFlow ${info.version} is ready`,
      detail: 'Restart to finish updating.',
    });
    if (response === 0) updater.quitAndInstall();
  });

  // A failed background check is never worth interrupting anyone over — not a
  // dialog, and not stderr noise that a build check would read as a crash.
  // The manual "Check for Updates…" path reports failures itself.
  updater.on('error', () => {});
}

/**
 * Begin checking: once shortly after launch, then on a slow timer. A no-op in
 * development or when the app is not packaged.
 */
function start(window) {
  mainWindow = window;
  if (started) return;
  if (!app.isPackaged || process.env.FLUENTFLOW_DEV_URL || !hasUpdateConfig()) return;
  started = true;

  wire();

  const check = () => load().checkForUpdates().catch(() => {});
  setTimeout(check, 3000).unref?.();
  setInterval(check, SIX_HOURS).unref?.();
}

/**
 * A manual check from the "Check for Updates…" menu item. Unlike the background
 * check, this one tells the user when there is nothing to do.
 */
async function checkNow() {
  if (!app.isPackaged || !hasUpdateConfig()) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Updates are only checked in a published build.',
    });
    return;
  }

  if (!started) wire();

  try {
    const result = await load().checkForUpdates();
    const available = result?.updateInfo && result.updateInfo.version !== app.getVersion();
    if (!available) {
      await dialog.showMessageBox({
        type: 'info',
        message: `FluentFlow ${app.getVersion()} is up to date.`,
      });
    }
    // When there is an update, autoDownload takes over and 'update-downloaded'
    // shows the restart prompt.
  } catch (error) {
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Could not check for updates.',
      detail: isExpectedUnsignedError(error)
        ? 'Automatic updates need a signed build, which this one is not yet.'
        : String(error?.message ?? error),
    });
  }
}

module.exports = { start, checkNow };
