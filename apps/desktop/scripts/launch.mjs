#!/usr/bin/env node
/**
 * Start Electron with a clean environment.
 *
 * `electron .` looks like it needs no wrapper. It does, on one machine in
 * particular: editors built on Electron — VS Code among them — export
 * ELECTRON_RUN_AS_NODE=1 into their integrated terminal for their own child
 * processes. Any Electron binary that inherits it runs as plain Node: no
 * window, no `app`, no `protocol`, and an immediate exit with status 0. That
 * reads exactly like the app being broken, and costs an hour to find.
 *
 * Anything after `--` is forwarded to the app.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [APP_DIR, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: environment,
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
