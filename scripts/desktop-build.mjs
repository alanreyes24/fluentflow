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
  await run(['--prefix', DESKTOP, 'run', target]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
