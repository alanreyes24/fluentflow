#!/usr/bin/env node
/**
 * Copy the built core package into the desktop shell.
 *
 * The Electron main process needs `parseApkg` so Windows can import an Anki
 * package without a sync server. It cannot simply `require('@fluentflow/core')`
 * in a packaged build: `apps/desktop` is installed on its own (`npm --prefix
 * apps/desktop install`) rather than as a workspace, so the symlink that makes
 * that resolve in the repository does not exist in `dist/`, and electron-builder
 * copies only what a package's own `dependencies` declare.
 *
 * So the core build is vendored the same way the web export already is: a build
 * step writes it into `apps/desktop/`, and the shell loads it by path. Two
 * details make that a flat copy rather than a bundler:
 *
 *  - Only `.js` is copied. The declarations and source maps are for editors and
 *    are dead weight next to `refresh-desktop.mjs`, which pushes this directory
 *    into an installed copy as a file copy.
 *  - Core's single bare import — `fflate`, in the `.apkg` unzip — is rewritten
 *    to a relative path, because a bare specifier would need a `node_modules`
 *    directory here and electron-builder filters those. `fflate`'s browser
 *    build is one self-contained file with no imports of its own, which is what
 *    makes the rewrite a one-liner instead of a resolution problem. It is
 *    written as `.mjs` so Node reads it as ESM without a `type` marker beside
 *    it — `apps/desktop` itself is CommonJS.
 *
 *   node scripts/vendor-core.mjs              # build core, then vendor it
 *   node scripts/vendor-core.mjs --skip-build # vendor whatever is already built
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = join(ROOT, 'packages', 'core', 'dist');
const FFLATE_ESM = join(ROOT, 'node_modules', 'fflate', 'esm', 'browser.js');
const VENDOR = join(ROOT, 'apps', 'desktop', 'vendor');
const CORE_OUT = join(VENDOR, 'core');
const FFLATE_OUT = join(VENDOR, 'fflate.mjs');

const skipBuild = process.argv.includes('--skip-build');

async function main() {
  if (!skipBuild) {
    // One string through a shell rather than an argument array: on Windows npm
    // is a `.cmd`, which Node refuses to spawn directly, and passing *args*
    // alongside `shell: true` is deprecated. There is no interpolation here.
    const built = spawnSync('npm run build -w @fluentflow/core', {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    });
    if (built.status !== 0) {
      console.error('Building @fluentflow/core failed.');
      process.exitCode = 1;
      return;
    }
  }

  for (const [label, path] of [['core build', CORE_DIST], ['fflate', FFLATE_ESM]]) {
    if (!existsSync(path)) {
      console.error(`No ${label} at ${path}. Run npm install and npm run build.`);
      process.exitCode = 1;
      return;
    }
  }

  await rm(VENDOR, { recursive: true, force: true });
  await mkdir(CORE_OUT, { recursive: true });

  await writeFile(FFLATE_OUT, await readFile(FFLATE_ESM, 'utf8'), 'utf8');

  let copied = 0;
  for (const file of await javascriptFiles(CORE_DIST)) {
    const target = join(CORE_OUT, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewriteFflateImport(await readFile(join(CORE_DIST, file), 'utf8'), file), 'utf8');
    copied++;
  }

  // A `type: module` marker, so Node reads the copied `.js` files as ESM. The
  // source package declares it; a bare directory would default to CommonJS.
  await writeFile(
    join(CORE_OUT, 'package.json'),
    `${JSON.stringify({ name: '@fluentflow/core-vendored', private: true, type: 'module', main: 'index.js' }, null, 2)}\n`,
    'utf8',
  );

  console.log(`Vendored ${copied} core modules and fflate into ${relative(ROOT, VENDOR)}`);
}

/** Every `.js` under the build, as paths relative to it. Declarations excluded. */
async function javascriptFiles(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await javascriptFiles(join(directory, entry.name), name)));
    } else if (entry.name.endsWith('.js')) {
      found.push(name);
    }
  }
  return found;
}

/** `from 'fflate'` → the vendored copy, relative to the file doing the import. */
function rewriteFflateImport(source, file) {
  if (!source.includes("'fflate'")) return source;
  const depth = file.split('/').length - 1;
  const path = `${'../'.repeat(depth + 1)}fflate.mjs`;
  return source.replaceAll("from 'fflate'", `from '${path}'`);
}

await main();
