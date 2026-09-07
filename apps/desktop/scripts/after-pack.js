'use strict';

/**
 * The one `afterPack` hook, dispatching to the per-platform ones.
 *
 * electron-builder takes a single `afterPack`, and this build has two things to
 * do after packaging — one on each platform:
 *
 *   macOS   `after-pack.cjs` ad-hoc signs the bundle, so `codesign --verify`
 *           stops reporting a signature that promises sealed resources the
 *           bundle does not have.
 *   Windows `stamp-executable.js` writes the version resource and the icon,
 *           which `signAndEditExecutable: false` disables along with the
 *           signing that cannot run here.
 *
 * Both guard on `context.electronPlatformName` themselves, so this calls both
 * and lets each decide whether it is on. They are awaited in sequence rather
 * than in parallel: only one ever does work, and a stack trace that says which
 * is worth more than the overlap.
 */

const signMacBundle = require('./after-pack.cjs').default;
const stampWindowsExecutable = require('./stamp-executable.js');

module.exports = async function afterPack(context) {
  await signMacBundle(context);
  await stampWindowsExecutable(context);
};
