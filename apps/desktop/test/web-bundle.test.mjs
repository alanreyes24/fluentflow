import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Keeping the desktop app's web build in step with the hosted one.
 *
 * The network is a map of URL → bytes, so each test says exactly what the
 * server serves. What is asserted is what the shell will run: the bundled
 * copy, a downloaded one, or nothing new.
 */

const require = createRequire(import.meta.url);
const {
  createWebBundles,
  manifestForDirectory,
  parseManifest,
  bundleId,
} = require('../src/web-bundle.js');
const server = await import('../../server/src/desktop-bundle.ts');

const SHELL = 'a'.repeat(64);
const ORIGIN = 'https://fluentflow.example';

function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}

function writeTree(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, ...relative.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
}

function setup({ bundled, hosted, shell = SHELL }) {
  const base = mkdtempSync(join(tmpdir(), 'fluentflow-bundles-'));
  const bundledRoot = join(base, 'web');
  const hostedRoot = join(base, 'hosted');
  writeTree(bundledRoot, bundled);
  writeTree(hostedRoot, { ...hosted, 'desktop-shell.json': JSON.stringify({ fingerprint: shell }) });
  const storeDir = join(base, 'store');

  const requests = [];
  const served = new Map();
  const publish = (commit = 'c0ffee1234567') => {
    served.clear();
    const manifest = server.desktopBundleManifest(hostedRoot, commit);
    served.set(`${ORIGIN}/api/desktop-bundle`, Buffer.from(JSON.stringify(manifest)));
    for (const file of manifest.files) {
      served.set(`${ORIGIN}/${file.path}`, readFileSync(join(hostedRoot, ...file.path.split('/'))));
    }
    return manifest;
  };
  const fetch = async (url) => {
    requests.push(url);
    const body = served.get(url);
    return {
      ok: Boolean(body),
      status: body ? 200 : 404,
      json: async () => JSON.parse(body.toString()),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  const open = () => createWebBundles({ bundledRoot, storeDir, shell: SHELL, source: ORIGIN, fetch });
  return { base, bundledRoot, hostedRoot, storeDir, served, requests, publish, open };
}

const BUNDLED = {
  'index.html': '<!doctype html>v1',
  '_expo/static/js/web/entry-1.js': 'console.log(1)',
  'assets/font.ttf': 'font-bytes',
};
const HOSTED = {
  'index.html': '<!doctype html>v2',
  '_expo/static/js/web/entry-2.js': 'console.log(2)',
  'assets/font.ttf': 'font-bytes',
};

test('the server and the shell compute the same bundle id', () => {
  const { base, hostedRoot } = setup({ bundled: BUNDLED, hosted: HOSTED });
  try {
    const fromServer = server.desktopBundleManifest(hostedRoot, null);
    const fromShell = manifestForDirectory(hostedRoot);
    assert.equal(fromServer.id, fromShell.id);
    assert.deepEqual(fromServer.files, fromShell.files);
    assert.equal(fromServer.shell, SHELL);
    assert.equal(server.bundleId(fromServer.files), bundleId(fromShell.files));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('downloads a newer hosted build, fetching only the files it lacks', async () => {
  const env = setup({ bundled: BUNDLED, hosted: HOSTED });
  try {
    env.publish();
    const bundles = env.open();
    assert.equal(bundles.activeRoot(), env.bundledRoot);

    const status = await bundles.check();
    assert.equal(status.state, 'ready');
    assert.equal(status.pending.commit, 'c0ffee1234567');
    // The font is byte-for-byte the bundled one, so it was copied, not fetched.
    assert.ok(!env.requests.includes(`${ORIGIN}/assets/font.ttf`));
    assert.ok(env.requests.includes(`${ORIGIN}/_expo/static/js/web/entry-2.js`));

    // The window keeps the old build until it reloads into the new one.
    assert.equal(bundles.activeRoot(), env.bundledRoot);
    assert.equal(bundles.activatePending(), true);
    assert.equal(readFileSync(join(bundles.activeRoot(), 'index.html'), 'utf8'), '<!doctype html>v2');

    // A second check finds nothing new.
    assert.equal((await bundles.check()).state, 'current');
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('the next launch runs the downloaded build', async () => {
  const env = setup({ bundled: BUNDLED, hosted: HOSTED });
  try {
    env.publish();
    await env.open().check();

    const relaunched = env.open();
    assert.notEqual(relaunched.activeRoot(), env.bundledRoot);
    assert.equal(readFileSync(join(relaunched.activeRoot(), 'index.html'), 'utf8'), '<!doctype html>v2');
    assert.equal(relaunched.status().active.kind, 'downloaded');
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('a refreshed app drops downloads made for its previous bundled build', async () => {
  const env = setup({ bundled: BUNDLED, hosted: HOSTED });
  try {
    env.publish();
    await env.open().check();

    // `npm run desktop:refresh` replaces the bundled export.
    writeFileSync(join(env.bundledRoot, 'index.html'), '<!doctype html>v3');
    const relaunched = env.open();
    assert.equal(relaunched.activeRoot(), env.bundledRoot);
    assert.equal(existsSync(join(env.storeDir, 'current.json')), false);
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('waits for a shell refresh when the hosted build needs a different shell', async () => {
  const env = setup({ bundled: BUNDLED, hosted: HOSTED, shell: 'b'.repeat(64) });
  try {
    env.publish();
    const bundles = env.open();
    const status = await bundles.check();
    assert.equal(status.state, 'shell-mismatch');
    assert.equal(status.pending, null);
    assert.equal(bundles.activeRoot(), env.bundledRoot);
    assert.equal(env.requests.length, 1, 'only the manifest is fetched');
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('discards a download whose file does not match the manifest', async () => {
  const env = setup({ bundled: BUNDLED, hosted: HOSTED });
  try {
    env.publish();
    env.served.set(`${ORIGIN}/_expo/static/js/web/entry-2.js`, Buffer.from('tampered'));
    const bundles = env.open();
    const status = await bundles.check();
    assert.equal(status.state, 'error');
    assert.match(status.message, /did not match/);
    assert.equal(bundles.activeRoot(), env.bundledRoot);
    assert.equal(existsSync(join(env.storeDir, 'current.json')), false);
    assert.equal(env.open().activeRoot(), env.bundledRoot);
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('an unreachable server leaves the app on what it has', async () => {
  const env = setup({ bundled: BUNDLED, hosted: HOSTED });
  try {
    const bundles = env.open();
    const status = await bundles.check();
    assert.equal(status.state, 'error');
    assert.equal(bundles.activeRoot(), env.bundledRoot);
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('updates are off without a source', async () => {
  const env = setup({ bundled: BUNDLED, hosted: HOSTED });
  try {
    const bundles = createWebBundles({
      bundledRoot: env.bundledRoot,
      storeDir: env.storeDir,
      shell: SHELL,
      source: null,
      fetch: () => assert.fail('nothing should be fetched'),
    });
    assert.equal((await bundles.check()).state, 'disabled');
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('a manifest cannot name a file outside the bundle', () => {
  const file = (path) => ({ path, size: 1, sha256: sha('x') });
  const manifest = (files) => ({ id: bundleId(files), files });
  const index = file('index.html');
  for (const bad of ['../main.js', '/etc/passwd', 'a/../../b', 'a\\b', 'a//b', './a']) {
    assert.throws(() => parseManifest(manifest([index, file(bad)])), /safely/, bad);
  }
  assert.throws(() => parseManifest({ ...manifest([index]), id: 'f'.repeat(64) }), /does not match/);
  assert.throws(() => parseManifest(manifest([file('app.js')])), /index\.html/);
  assert.doesNotThrow(() => parseManifest(manifest([index, file('_expo/static/js/web/entry.js')])));
});
