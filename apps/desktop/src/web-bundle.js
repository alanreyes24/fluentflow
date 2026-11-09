'use strict';

/**
 * Keep the desktop app's web build in step with the deployed web app.
 *
 * Almost all of FluentFlow is the Expo web export; the Electron shell around it
 * (main, preload, the AI and dictionary handlers) changes rarely. So instead of
 * shipping a whole new app for every push, the shell downloads the export the
 * hosted server is serving and runs that:
 *
 *  1. The server publishes a manifest at `/api/desktop-bundle`: every file in
 *     its export with a SHA-256, an id derived from those hashes, the commit,
 *     and the fingerprint of the desktop shell that export was built against.
 *  2. The shell fetches it. A different id means a different build. Files it
 *     already has (most of them, usually) are copied locally by hash; the rest
 *     are downloaded and each one is checked against the manifest before the
 *     bundle is accepted. A failed or partial download is thrown away.
 *  3. The finished bundle is recorded in `current.json` and served from the
 *     next launch, or straight away if the user chooses to reload.
 *
 * Two rules keep this from running a bundle the shell cannot support:
 *
 *  - **Shell fingerprint.** A bundle is only applied when the shell files it
 *    was built with hash to the same value as this shell's. When the shell
 *    has changed, the bundle waits for `npm run desktop:refresh`.
 *  - **Bundled copy wins after a refresh.** A downloaded bundle remembers which
 *    bundled export it replaced. Once a refresh changes the bundled export,
 *    older downloads are dropped and the next check starts from the new one.
 *
 * The page keeps its `app://fluentflow` origin throughout, so its local
 * database, sign-in, and settings carry over between bundles.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Shell files that the web bundle talks to; see `shellFingerprint`. */
const SHELL_FILES = ['main.js', 'preload.js', 'ai.js', 'cloud.js', 'dictionary.js'];
const SHELL_DIRS = ['src'];

/** A deployed export is ~4 MB. Anything far beyond that is not one. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

const HEX64 = /^[0-9a-f]{64}$/;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Every regular file under `root`, as sorted POSIX-style relative paths. */
function listFiles(root) {
  const found = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(root, '');
  return found.sort();
}

/**
 * The id of a set of files: a hash over each path and its content hash.
 *
 * `apps/server/src/desktop-bundle.ts` computes the same value for the export it
 * serves; `test/web-bundle.test.mjs` holds the two implementations together.
 */
function bundleId(files) {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join('');
  return sha256(lines);
}

/** Hash an export directory into the same shape the server publishes. */
function manifestForDirectory(root) {
  const files = listFiles(root).map((relative) => {
    const data = fs.readFileSync(path.join(root, ...relative.split('/')));
    return { path: relative, size: data.length, sha256: sha256(data) };
  });
  return { id: bundleId(files), files };
}

/**
 * A hash of the shell's own source, the files a web bundle depends on.
 *
 * Line endings are normalised so a Windows checkout and a macOS one agree.
 * `scripts/desktop-shell-fingerprint.mjs` writes this value into the web app's
 * `public/desktop-shell.json`, which is how a deployed export says which shell
 * it was built against.
 */
function shellFingerprint(appDir) {
  const files = [];
  for (const name of SHELL_FILES) {
    const file = path.join(appDir, name);
    if (fs.existsSync(file)) files.push(name);
  }
  for (const directory of SHELL_DIRS) {
    const root = path.join(appDir, directory);
    if (!fs.existsSync(root)) continue;
    for (const relative of listFiles(root)) {
      if (relative.endsWith('.js')) files.push(`${directory}/${relative}`);
    }
  }
  const hashed = files.map((relative) => {
    const text = fs.readFileSync(path.join(appDir, ...relative.split('/')), 'utf8').replace(/\r\n/g, '\n');
    return { path: relative, sha256: sha256(text) };
  });
  return bundleId(hashed);
}

/** A path from a manifest that stays inside the bundle directory. */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Check a manifest from the network before trusting any part of it. */
function parseManifest(body) {
  if (!body || typeof body !== 'object') throw new Error('The update server sent no manifest.');
  const { id, files, shell, commit } = body;
  if (typeof id !== 'string' || !HEX64.test(id)) throw new Error('The manifest has no valid id.');
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new Error('The manifest lists no usable files.');
  }
  let total = 0;
  const seen = new Set();
  for (const file of files) {
    if (
      !file ||
      !isSafeRelativePath(file.path) ||
      typeof file.sha256 !== 'string' ||
      !HEX64.test(file.sha256) ||
      !Number.isInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error('The manifest lists a file it cannot describe safely.');
    }
    if (seen.has(file.path)) throw new Error(`The manifest lists ${file.path} twice.`);
    seen.add(file.path);
    total += file.size;
  }
  if (total > MAX_BUNDLE_BYTES) throw new Error('The update is larger than any real web build.');
  if (!seen.has('index.html')) throw new Error('The update has no index.html.');
  if (bundleId(files) !== id) throw new Error('The manifest id does not match its files.');
  return {
    id,
    files: files.map(({ path: p, size, sha256: hash }) => ({ path: p, size, sha256: hash })),
    shell: typeof shell === 'string' ? shell : null,
    commit: typeof commit === 'string' && commit ? commit : null,
  };
}

/** `https://host` or a loopback `http://` URL, without a trailing slash. */
function normaliseSource(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return url.origin;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write through a temporary file so a crash never leaves half a record. */
function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/**
 * The bundle manager for one shell.
 *
 * @param {object} options
 * @param {string} options.bundledRoot  the export shipped inside the app
 * @param {string} options.storeDir     where downloaded bundles live (userData)
 * @param {string} options.shell        this shell's fingerprint
 * @param {string|null} options.source  the hosted app's origin, or null for off
 * @param {typeof fetch} [options.fetch]
 */
function createWebBundles({ bundledRoot, storeDir, shell, source, fetch: fetchImpl = globalThis.fetch }) {
  const origin = normaliseSource(source);
  const bundled = fs.existsSync(path.join(bundledRoot, 'index.html'))
    ? manifestForDirectory(bundledRoot)
    : null;

  /** What the protocol handler serves right now. */
  let active = { kind: 'bundled', id: bundled?.id ?? null, root: bundledRoot, commit: null, files: bundled?.files ?? [] };
  /** A bundle downloaded this session but not yet loaded into the window. */
  let pending = null;
  let checking = null;
  let lastCheck = { state: origin ? 'idle' : 'disabled', checkedAt: null, message: null };

  restore();

  function restore() {
    const record = readJson(path.join(storeDir, 'current.json'));
    if (!record || typeof record.id !== 'string' || !HEX64.test(record.id)) return;
    const root = path.join(storeDir, record.id);
    const manifest = readJson(path.join(storeDir, `${record.id}.json`));
    const usable =
      bundled &&
      record.baseBundledId === bundled.id &&
      record.shell === shell &&
      manifest &&
      Array.isArray(manifest.files) &&
      fs.existsSync(path.join(root, 'index.html'));
    if (!usable) {
      // A refresh replaced the bundled export, or the shell changed under the
      // download. Either way the bundled copy is the one that matches.
      prune(new Set());
      return;
    }
    active = { kind: 'downloaded', id: record.id, root, commit: record.commit ?? null, files: manifest.files };
  }

  /** Delete every stored bundle except the ids in `keep`. */
  function prune(keep) {
    if (!fs.existsSync(storeDir)) return;
    for (const entry of fs.readdirSync(storeDir)) {
      const id = entry.replace(/(\.json|\.partial)$/, '');
      if (entry === 'current.json' && keep.size > 0) continue;
      if (keep.has(id) && !entry.endsWith('.partial')) continue;
      fs.rmSync(path.join(storeDir, entry), { recursive: true, force: true });
    }
  }

  async function request(url, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every file the manifest lists, copied from what is on disk or fetched. */
  async function download(manifest) {
    const partial = path.join(storeDir, `${manifest.id}.partial`);
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });

    // Files with the same hash are the same file, whichever bundle has them.
    const local = new Map();
    for (const [root, files] of [[active.root, active.files], [bundledRoot, bundled?.files ?? []]]) {
      for (const file of files) {
        if (!local.has(file.sha256)) local.set(file.sha256, path.join(root, ...file.path.split('/')));
      }
    }

    let downloaded = 0;
    for (const file of manifest.files) {
      const destination = path.join(partial, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });

      const existing = local.get(file.sha256);
      if (existing && fs.existsSync(existing)) {
        const data = fs.readFileSync(existing);
        if (sha256(data) === file.sha256) {
          fs.writeFileSync(destination, data);
          continue;
        }
      }

      const url = `${origin}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      const data = Buffer.from(await (await request(url)).arrayBuffer());
      if (data.length !== file.size || sha256(data) !== file.sha256) {
        throw new Error(`${file.path} did not match the manifest; the update was discarded.`);
      }
      fs.writeFileSync(destination, data);
      downloaded += 1;
    }

    const finished = path.join(storeDir, manifest.id);
    fs.rmSync(finished, { recursive: true, force: true });
    fs.renameSync(partial, finished);
    writeJsonAtomic(path.join(storeDir, `${manifest.id}.json`), { files: manifest.files });
    return { root: finished, downloaded };
  }

  async function runCheck() {
    if (!origin) {
      lastCheck = { state: 'disabled', checkedAt: new Date().toISOString(), message: null };
      return status();
    }
    if (!bundled) {
      lastCheck = { state: 'error', checkedAt: new Date().toISOString(), message: 'This app has no bundled web build.' };
      return status();
    }

    try {
      const manifest = parseManifest(await (await request(`${origin}/api/desktop-bundle`, 15_000)).json());
      const current = pending ?? active;

      if (manifest.id === current.id || (manifest.id === bundled.id && current.kind === 'bundled')) {
        lastCheck = { state: pending ? 'ready' : 'current', checkedAt: new Date().toISOString(), message: null, commit: manifest.commit };
        return status();
      }
      if (manifest.shell !== shell) {
        lastCheck = { state: 'shell-mismatch', checkedAt: new Date().toISOString(), message: null, commit: manifest.commit };
        return status();
      }

      fs.mkdirSync(storeDir, { recursive: true });
      if (manifest.id === bundled.id) {
        // The server is back on what shipped in the app: drop the download.
        fs.rmSync(path.join(storeDir, 'current.json'), { force: true });
        pending = { kind: 'bundled', id: bundled.id, root: bundledRoot, commit: manifest.commit, files: bundled.files };
      } else {
        const { root } = await download(manifest);
        writeJsonAtomic(path.join(storeDir, 'current.json'), {
          id: manifest.id,
          commit: manifest.commit,
          shell,
          baseBundledId: bundled.id,
          installedAt: new Date().toISOString(),
        });
        pending = { kind: 'downloaded', id: manifest.id, root, commit: manifest.commit, files: manifest.files };
      }
      // Keep what the window is still showing until it reloads.
      prune(new Set([active.id, pending.id].filter(Boolean)));
      lastCheck = { state: 'ready', checkedAt: new Date().toISOString(), message: null, commit: manifest.commit };
      return status();
    } catch (error) {
      if (fs.existsSync(storeDir)) {
        for (const entry of fs.readdirSync(storeDir)) {
          if (entry.endsWith('.partial')) fs.rmSync(path.join(storeDir, entry), { recursive: true, force: true });
        }
      }
      lastCheck = {
        state: 'error',
        checkedAt: new Date().toISOString(),
        message: error?.name === 'AbortError' ? 'The update server did not answer in time.' : String(error?.message ?? error),
      };
      return status();
    }
  }

  /** One check at a time; a second caller waits for the first. */
  function check() {
    if (!checking) checking = runCheck().finally(() => { checking = null; });
    return checking;
  }

  /** Switch the protocol handler to the pending bundle. The caller reloads. */
  function activatePending() {
    if (!pending) return false;
    active = pending;
    pending = null;
    lastCheck = { ...lastCheck, state: 'current' };
    return true;
  }

  function status() {
    return {
      source: origin,
      active: { kind: active.kind, id: active.id, commit: active.commit },
      pending: pending ? { kind: pending.kind, id: pending.id, commit: pending.commit } : null,
      state: lastCheck.state,
      checkedAt: lastCheck.checkedAt,
      message: lastCheck.message,
      latestCommit: lastCheck.commit ?? null,
    };
  }

  return {
    activeRoot: () => active.root,
    check,
    activatePending,
    status,
  };
}

module.exports = {
  bundleId,
  createWebBundles,
  isSafeRelativePath,
  manifestForDirectory,
  normaliseSource,
  parseManifest,
  shellFingerprint,
};
