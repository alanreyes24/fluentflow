#!/usr/bin/env node
/**
 * Push a new build into the desktop app you already have, without rebuilding
 * or re-downloading the 110 MB installer.
 *
 * A packaged FluentFlow is 370 MB on disk, and 367 MB of that is the Electron
 * runtime — the same bytes in every version. The part that actually changes is
 * `resources/app`: the web export, the shell and the vendored core, about 3 MB
 * together. So a new version is a 3 MB file copy, not a download.
 *
 * That works because `asar: false` is set in the desktop build config, which
 * leaves those files loose on disk instead of sealed in an archive.
 *
 *   node scripts/refresh-desktop.mjs              # rebuild, then update every install found
 *   node scripts/refresh-desktop.mjs --run        # ...and launch it
 *   node scripts/refresh-desktop.mjs --skip-build # push the existing export again
 *
 * The portable .exe is the one thing this cannot update: it unpacks itself into
 * a temporary directory on every launch, so it always carries its own copy.
 * Install the setup .exe once, or use dist/win-unpacked, and refresh that.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const EXPORT_DIR = join(DESKTOP, 'web');

/**
 * The files that differ between versions. Everything else is the runtime.
 *
 * `vendor` is the core build the main process parses `.apkg` with, and `src` is
 * the shell's own modules; both change with the app, and leaving either behind
 * would pair a new bundle with an old importer.
 */
const PAYLOAD = ['main.js', 'preload.js', 'src', 'vendor', 'web'];

const options = {
  run: process.argv.includes('--run'),
  skipBuild: process.argv.includes('--skip-build'),
};

async function main() {
  const targets = findInstalls();
  if (targets.length === 0) {
    console.error(
      'No desktop install found to refresh.\n' +
        '\n' +
        'Build one first — this is local, nothing is downloaded:\n' +
        '  npm run desktop:pack        # dist/win-unpacked, a minute or two\n' +
        '\n' +
        'Or install FluentFlow-Setup-0.1.0.exe once, and refresh that from then on.',
    );
    process.exitCode = 1;
    return;
  }

  const running = await runningInstances();
  const busy = targets.filter((target) => running.some((process_) => isInside(process_.path, target.dir)));
  if (busy.length > 0) {
    console.error(
      'These are running and cannot be updated underneath themselves:\n' +
        busy.map((target) => `  ${target.label} — ${target.dir}`).join('\n') +
        '\nClose FluentFlow and run this again.',
    );
    process.exitCode = 1;
    return;
  }

  if (!options.skipBuild) {
    console.log('Building the web export and vendoring core…');
    await runCommand('npm', ['--prefix', DESKTOP, 'run', 'build']);
  }

  if (!existsSync(join(DESKTOP, 'vendor', 'core', 'index.js'))) {
    console.error('No vendored core. Run: npm run desktop:vendor');
    process.exitCode = 1;
    return;
  }

  if (!existsSync(join(EXPORT_DIR, 'index.html'))) {
    console.error(`No web export at ${EXPORT_DIR}. Drop --skip-build.`);
    process.exitCode = 1;
    return;
  }

  const version = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version;

  for (const target of targets) {
    for (const entry of PAYLOAD) {
      const destination = join(target.appDir, entry);
      // Remove first: the export uses content-hashed filenames, so copying
      // over the top would leave every previous build's bundles behind.
      await rm(destination, { recursive: true, force: true });
      await cp(join(DESKTOP, entry), destination, { recursive: true });
    }
    stampVersion(target.appDir, version);
    console.log(`  updated ${target.label} → ${target.appDir}`);
  }

  console.log(`\n${targets.length} install(s) now running ${version}.`);

  if (options.run) {
    const [first] = targets;
    console.log(`Launching ${first.executable}`);
    launch(first.executable);
  }
}

// --- finding what to update -------------------------------------------------

/**
 * Every packaged FluentFlow on this machine, in the order worth preferring:
 * the build in the repo first, then a per-user install, then per-machine.
 */
function findInstalls() {
  const candidates = [
    { label: 'local build', dir: join(DESKTOP, 'dist', 'win-unpacked') },
    { label: 'installed (per-user)', dir: join(process.env.LOCALAPPDATA ?? '', 'Programs', 'FluentFlow') },
    { label: 'installed (all users)', dir: join(process.env.ProgramFiles ?? '', 'FluentFlow') },
    { label: 'local build', dir: join(DESKTOP, 'dist', 'mac', 'FluentFlow.app', 'Contents') },
    { label: 'local build', dir: join(DESKTOP, 'dist', 'linux-unpacked') },
  ];

  return candidates
    .map((candidate) => ({
      ...candidate,
      appDir: join(candidate.dir, 'resources', 'app'),
      executable: findExecutable(candidate.dir),
    }))
    .filter((candidate) => existsSync(candidate.appDir));
}

function findExecutable(dir) {
  const names = [
    join(dir, 'FluentFlow.exe'),
    join(dir, 'MacOS', 'FluentFlow'),
    join(dir, 'fluentflow'),
  ];
  return names.find((path) => existsSync(path)) ?? null;
}

/**
 * Keep the packaged metadata honest. electron-builder generates this file, so
 * only the version is rewritten — the rest of it belongs to the packager.
 */
function stampVersion(appDir, version) {
  const manifest = join(appDir, 'package.json');
  if (!existsSync(manifest)) return;
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  if (parsed.version === version) return;
  writeFileSync(manifest, `${JSON.stringify({ ...parsed, version }, null, 2)}\n`);
}

// --- process handling -------------------------------------------------------

/**
 * Copying over a running app leaves it half-updated, so refuse to.
 *
 * The path matters, not just the name: one Electron app is several processes,
 * and the portable build — which runs from a temporary directory and can never
 * be refreshed anyway — must not block an install that is sitting idle.
 */
async function runningInstances() {
  if (process.platform !== 'win32') return [];
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='FluentFlow.exe'\" | " +
    'ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }';

  return new Promise((done) => {
    const probe = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    probe.stdout.on('data', (chunk) => (output += chunk));
    probe.on('close', () => {
      const found = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [pid, ...rest] = line.split('|');
          return { pid, path: rest.join('|') };
        });
      done(found);
    });
    probe.on('error', () => done([]));
  });
}

function isInside(candidate, directory) {
  if (!candidate) return false;
  const normalise = (value) => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return normalise(candidate).startsWith(`${normalise(directory)}/`);
}

function launch(executable) {
  if (!executable) {
    console.error('  (no executable found next to that install)');
    return;
  }
  // See apps/desktop/scripts/launch.mjs: an inherited ELECTRON_RUN_AS_NODE
  // makes any Electron binary exit silently as plain Node.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  spawn(executable, [], { stdio: 'ignore', detached: true, env: environment }).unref();
}

function runCommand(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited with ${code}`)),
    );
    child.on('error', fail);
  });
}

await main();
