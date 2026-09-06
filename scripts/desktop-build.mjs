#!/usr/bin/env node
/**
 * Install the desktop app's dependencies and run one of its build scripts.
 *
 * This wrapper exists for the same reason `apps/desktop/scripts/launch.mjs`
 * does: something in the environment breaks a nested command, and the fix has
 * to be applied where the process is spawned rather than asked of every
 * contributor.
 *
 * Here it is npm's own config. `npm run` exports every npm setting into the
 * child environment as `npm_config_*`, and a *nested* `npm install` reads those
 * back as if they had been typed on its command line. A user-level
 * `allow-scripts` setting — Claude Code's installer writes one — therefore
 * arrives at the inner install as `--allow-scripts`, which npm 11 refuses in a
 * project-scoped install:
 *
 *   npm error code EALLOWSCRIPTS
 *   npm error --allow-scripts is not allowed in project-scoped installs.
 *
 * The setting is stripped rather than overridden, so npm falls back to what
 * `apps/desktop/package.json` declares in its own `allowScripts` field, which
 * is where this repo's answer belongs.
 *
 *   node scripts/desktop-build.mjs pack
 *   node scripts/desktop-build.mjs dist:mac
 *
 * Real macOS signing is off by default (`mac.identity: null` in the desktop
 * package.json, ad-hoc via scripts/after-pack.cjs). To turn it on, set
 * `APPLE_IDENTITY` to the Developer ID name — e.g.
 * "Developer ID Application: Jane Doe (TEAMID)" — and supply the certificate
 * either in the login keychain or via `CSC_LINK` + `CSC_KEY_PASSWORD`. For
 * notarization also set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
 * `APPLE_TEAM_ID`. This wrapper then overrides the null identity and enables
 * `mac.notarize`, and after-pack.cjs steps aside.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/desktop-build.mjs <script>   (pack, dist, dist:mac, dist:win)');
  process.exit(1);
}

const environment = { ...process.env };
delete environment.npm_config_allow_scripts;
// The same reasoning as launch.mjs: an inherited ELECTRON_RUN_AS_NODE makes
// any Electron the packager spawns exit silently as plain Node.
delete environment.ELECTRON_RUN_AS_NODE;

/**
 * When a real Developer ID is supplied, override the dormant `identity: null`
 * and switch notarization on. Passed as `-c.*` config overrides so the
 * committed package.json stays ad-hoc by default.
 */
const signingArgs = [];
if (environment.APPLE_IDENTITY) {
  signingArgs.push(`-c.mac.identity=${environment.APPLE_IDENTITY}`, '-c.mac.notarize=true');
  environment.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  console.log(`Signing with "${environment.APPLE_IDENTITY}" and notarizing.`);
}

function run(args) {
  return new Promise((done, fail) => {
    const child = spawn('npm', args, {
      stdio: 'inherit',
      env: environment,
      shell: process.platform === 'win32',
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`npm ${args.join(' ')} exited with ${code}`)),
    );
  });
}

try {
  await run(['--prefix', DESKTOP, 'install']);
  await run(['--prefix', DESKTOP, 'run', target, ...(signingArgs.length ? ['--', ...signingArgs] : [])]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
