import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/store/memory.ts';

let server: Server;
let baseUrl: string;
let webDir: string;
const store = new MemoryStore();

before(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'fluentflow-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(webDir, 'manifest.json'), '{"name":"FluentFlow"}');
  mkdirSync(join(webDir, '_expo', 'static', 'js'), { recursive: true });
  writeFileSync(join(webDir, '_expo', 'static', 'js', 'entry-abc.js'), 'console.log(1)');

  const config = loadConfig({
    FLUENTFLOW_MODE: 'local',
    FLUENTFLOW_WEB_DIR: webDir,
  } as NodeJS.ProcessEnv);
  server = await new Promise<Server>((resolve) => {
    const s = createApp({ config, store }).listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(webDir, { recursive: true, force: true });
});

test('the page is cross-origin isolated so the SQLite worker can share memory', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="root"/);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('client-side routes load the single page', async () => {
  const res = await fetch(`${baseUrl}/study/some-deck`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="root"/);
});

test('fingerprinted bundles are cached forever, other files revalidate', async () => {
  const bundle = await fetch(`${baseUrl}/_expo/static/js/entry-abc.js`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('cache-control') ?? '', /immutable/);
  assert.equal(bundle.headers.get('cross-origin-embedder-policy'), 'require-corp');

  const manifest = await fetch(`${baseUrl}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('cache-control'), 'no-cache');
});

test('unknown API paths still answer with JSON, not the page', async () => {
  const res = await fetch(`${baseUrl}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  const health = await fetch(`${baseUrl}/health`);
  assert.equal((await health.json()).status, 'ok');
});

test('publishes a manifest of the export for the desktop app to update from', async () => {
  const res = await fetch(`${baseUrl}/api/desktop-bundle`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const manifest = (await res.json()) as {
    id: string;
    files: { path: string; size: number; sha256: string }[];
  };
  assert.match(manifest.id, /^[0-9a-f]{64}$/);
  const paths = manifest.files.map((file) => file.path);
  assert.deepEqual(paths, ['_expo/static/js/entry-abc.js', 'index.html', 'manifest.json']);
  const bundle = manifest.files.find((file) => file.path === '_expo/static/js/entry-abc.js');
  assert.equal(bundle?.size, 'console.log(1)'.length);
});
