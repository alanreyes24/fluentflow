#!/usr/bin/env node
/**
 * Run the browser app and its local API together for development.
 *
 * The Expo dev server keeps the bundle in memory and Fast Refreshes changed
 * files. The sync server is local-only, so this gives the browser workflow the
 * same API endpoint used by the app without requiring a Firebase project.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync(new URL('../.env', import.meta.url))) {
  process.loadEnvFile(new URL('../.env', import.meta.url));
}

const WEB_PORT = 8081;
const API_PORT = 8787;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Set();
let stopping = false;
const webEnvironment = { ...process.env };
// Expo does not need the credential, and keeping it out of the web process
// makes it impossible for a future bundler change to ship it to Chrome.
delete webEnvironment.GEMINI_API_KEY;
delete webEnvironment.GOOGLE_API_KEY;

const api = start('server', [
  'run',
  'server',
], {
  FLUENTFLOW_MODE: 'local',
  NODE_ENV: 'development',
  PORT: String(API_PORT),
});

const web = start('web', [
  'run',
  'web',
  '-w',
  '@fluentflow/mobile',
  '--',
  '--port',
  String(WEB_PORT),
], {}, webEnvironment);

Promise.all([
  waitFor(`${API_URL}/health`, 'local API'),
  waitFor(WEB_URL, 'Expo web server'),
])
  .then(() => {
    console.log(`[fluentflow] app: ${WEB_URL}`);
    console.log(`[fluentflow] api: ${API_URL}`);
    console.log('[fluentflow] edit files for Fast Refresh; press Ctrl-C to stop.');
    openChrome(WEB_URL);
  })
  .catch((error) => {
    console.error(`[fluentflow] ${error.message}`);
    void stop(1);
  });

api.on('exit', (code) => childExited('local API', code));
web.on('exit', (code) => childExited('Expo web server', code));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void stop(0));
}

function start(name, args, extraEnv = {}, environment = process.env) {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    env: { ...environment, ...extraEnv },
    stdio: 'inherit',
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  });
  children.add(child);
  child.once('error', (error) => {
    console.error(`[fluentflow] could not start ${name}: ${error.message}`);
    void stop(1);
  });
  return child;
}

async function waitFor(url, name) {
  const deadline = Date.now() + 60_000;
  let lastError = 'not responding';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }

  throw new Error(`${name} did not become ready at ${url} (${lastError}).`);
}

function openChrome(url) {
  if (process.env.FLUENTFLOW_OPEN_BROWSER === '0') return;

  let command;
  let args;
  if (process.env.CHROME_PATH) {
    command = process.env.CHROME_PATH;
    args = [url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = ['-a', 'Google Chrome', url];
  } else if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', url];
  } else {
    command = 'google-chrome';
    args = [url];
  }

  const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
  browser.once('error', () => {
    console.log(`[fluentflow] open ${url} in Chrome`);
  });
  browser.unref();
}

function childExited(name, code) {
  if (stopping) return;
  console.error(`[fluentflow] ${name} stopped${code === 0 ? '' : ` with code ${code}`}.`);
  void stop(code ?? 1);
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      child.kill();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  await delay(100);
  process.exit(code);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
