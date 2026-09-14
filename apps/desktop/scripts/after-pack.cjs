'use strict';

/**
 * Ad-hoc sign the macOS bundle after packaging.
 *
 * These builds are unsigned — there is no Developer ID here — and `identity:
 * null` tells electron-builder not to look for one. What that leaves behind is
 * not "unsigned" in a clean sense: the Electron binary keeps the linker's own
 * ad-hoc signature, which declares that the bundle has sealed resources, while
 * the bundle has none. `codesign --verify` says so:
 *
 *   code has no resources but signature indicates they must be present
 *
 * An ad-hoc signature over the finished bundle makes it self-consistent, and
 * leaves it in the same state `scripts/refresh-desktop.mjs` restores after it
 * pushes a new build into an installed copy.
 *
 * It does not make the app pass Gatekeeper. Ad-hoc is not a Developer ID and
 * nothing here is notarised, so a downloaded copy is still quarantined and
 * still needs right-click → Open. That is a distribution problem, not a
 * packaging one.
 */

const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // When a real Developer ID is in play, electron-builder's own signing step
  // runs after this one — an ad-hoc signature here would just be in the way.
  // Its presence is signalled by the standard electron-builder env vars.
  if (process.env.CSC_LINK || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true') {
    return;
  }

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Electron's helper and framework bundles retain linker signatures. Seal them before
  // signing the containing app so verification succeeds for nested code too.
  const frameworks = join(app, 'Contents', 'Frameworks');
  for (const entry of readdirSync(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/\.(app|framework)$/.test(entry.name)) continue;
    const entitlements = entry.name.endsWith('.app')
      ? ['--entitlements', join(__dirname, '..', 'build', 'entitlements.mac.plist')]
      : [];
    execFileSync(
      'codesign',
      ['--force', '--sign', '-', '--options', 'runtime', ...entitlements, join(frameworks, entry.name)],
      { stdio: 'inherit' },
    );
  }
  // `--options runtime` keeps the ad-hoc signature consistent with
  // `hardenedRuntime: true` in the config and the entitlements file.
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', join(__dirname, '..', 'build', 'entitlements.mac.plist'), app],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${app}`);
};
