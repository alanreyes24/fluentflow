#!/usr/bin/env node
/**
 * Tell the desktop shell which hosted web app to keep its bundle in step with.
 *
 * Reads `FLUENTFLOW_WEB_URL` from the environment or the root `.env` and writes
 * `apps/desktop/web-source.json`, which `main.js` reads at launch. A packaged
 * app started from Finder or the Start menu has no shell environment, so the
 * value has to travel with the app. Without it the file records `null` and the
 * app runs only the bundle it shipped with.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'apps', 'desktop', 'web-source.json');

function fromDotEnv(name) {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && match[1] === name) return match[2].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const raw = process.env.FLUENTFLOW_WEB_URL ?? fromDotEnv('FLUENTFLOW_WEB_URL') ?? '';
let url = null;
if (raw) {
  try {
    url = new URL(raw).origin;
  } catch {
    console.error(`FLUENTFLOW_WEB_URL is not a URL: ${raw}`);
    process.exit(1);
  }
}

writeFileSync(OUTPUT, `${JSON.stringify({ url }, null, 2)}\n`);
console.log(url ? `desktop web updates from ${url}` : 'desktop web updates off (FLUENTFLOW_WEB_URL is not set)');
