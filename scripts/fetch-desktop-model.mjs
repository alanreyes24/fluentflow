#!/usr/bin/env node
/**
 * Download the model the desktop app runs.
 *
 * It does two jobs once installed: filling in the meanings a pasted word list
 * does not carry, and writing the two example sentences a card reveal shows.
 *
 * `prepare-model.mjs` is the other way to get a model, and it is a different
 * job: it shells out to Python, Optimum and torch to export and quantise a
 * model for the *phone*, which is a multi-gigabyte toolchain and twenty
 * minutes. Desktop needs no conversion — the ONNX exports already exist on
 * Hugging Face — so this is a download and nothing else. No Python.
 *
 *   node scripts/fetch-desktop-model.mjs               # Qwen2.5-1.5B, 4-bit
 *   node scripts/fetch-desktop-model.mjs --model small # Qwen2.5-0.5B
 *   node scripts/fetch-desktop-model.mjs --dir <path>  # somewhere else
 *
 * On which model, and why not the small one by default: the 0.5B answered five
 * of fourteen Spanish words correctly and invented the rest, and its int8 build
 * could not manage "comer". The 1.5B gets around ten of fourteen. Neither is
 * trustworthy enough to write a card unreviewed, which is why the app treats
 * every translation as a draft — but ten out of fourteen is worth reviewing and
 * five is not.
 *
 * Example sentences say the same thing more plainly. Asked to use `lodazal` in
 * a sentence the 0.5B wrote about "el loderazal", a word it had just invented,
 * and defined `comer` instead of using it; the 1.5B wrote "El campo estaba
 * lleno de lodazal". Being smaller does not help either: the 0.5B's only
 * unquantised export is 1.9 GB, larger than the 1.5B at 4-bit.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MODELS = {
  small: {
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    graph: 'onnx/model.onnx',
    approxMb: 1901,
    note: 'Qwen2.5-0.5B, unquantised. Fast and often wrong.',
  },
  default: {
    repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
    graph: 'onnx/model_q4f16.onnx',
    approxMb: 1165,
    note: 'Qwen2.5-1.5B, 4-bit weights. About 1.4 s per word on an M-series Mac.',
  },
};

/**
 * Where Electron puts `userData` on each platform. The app looks here, so the
 * download has to agree with it — `FLUENTFLOW_MODEL_DIR` overrides both.
 */
function defaultDir() {
  if (process.env.FLUENTFLOW_MODEL_DIR) return process.env.FLUENTFLOW_MODEL_DIR;
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'FluentFlow', 'models');
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'FluentFlow', 'models');
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'FluentFlow', 'models');
}

function parseArgs(argv) {
  const options = { model: 'default', dir: defaultDir(), force: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--model': options.model = argv[++i] ?? 'default'; break;
      case '--dir': options.dir = argv[++i] ?? options.dir; break;
      case '--force': options.force = true; break;
      case '--help':
      case '-h':
        console.log('Usage: node scripts/fetch-desktop-model.mjs [--model small|default] [--dir <path>] [--force]');
        process.exit(0);
        break;
      default:
        console.error(`Unrecognised argument "${argv[i]}".`);
        process.exit(1);
    }
  }
  return options;
}

async function download(url, destination, label) {
  // Written to a temporary name and renamed on success, so an interrupted
  // download is never mistaken for an installed model.
  const partial = `${destination}.partial`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${label}: HTTP ${response.status} from ${url}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  let lastReport = 0;

  const progress = new TransformStream({
    transform(chunk, controller) {
      // Pass the chunk on first. A transform that only counts is a transform
      // that swallows the download: every file lands at zero bytes, the
      // progress numbers count up to the full size regardless, and the failure
      // surfaces much later as an unreadable model.
      controller.enqueue(chunk);

      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 500) {
        lastReport = now;
        const mb = (received / 1048576).toFixed(0);
        const of = total ? ` / ${(total / 1048576).toFixed(0)} MB` : '';
        process.stdout.write(`\r  ${label}: ${mb} MB${of}   `);
      }
    },
  });

  await pipeline(response.body.pipeThrough(progress), createWriteStream(partial));

  // Check before the rename, so a truncated or empty download never takes the
  // name the app looks for.
  const { size } = await stat(partial);
  if (size === 0 || (total && size !== total)) {
    await rm(partial, { force: true });
    throw new Error(`${label}: expected ${total} bytes, got ${size}. Run it again.`);
  }

  await rename(partial, destination);
  process.stdout.write(`\r  ${label}: ${(size / 1048576).toFixed(0)} MB — done\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = MODELS[options.model];
  if (!model) {
    console.error(`Unknown model "${options.model}". Choose: ${Object.keys(MODELS).join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  console.log('\nFluentFlow desktop model');
  console.log(`  model   ${model.repo}`);
  console.log(`  size    ~${model.approxMb} MB`);
  console.log(`  into    ${options.dir}`);
  console.log(`  ${model.note}\n`);

  if (existsSync(join(options.dir, 'model.onnx')) && !options.force) {
    console.log('A model is already installed there. Pass --force to replace it.');
    return;
  }

  await mkdir(options.dir, { recursive: true });

  const base = `https://huggingface.co/${model.repo}/resolve/main`;
  // The app looks for these three names, whatever the model was called
  // upstream. The small ones come first: they fail fast if the repository name
  // is wrong, rather than after a gigabyte.
  await download(`${base}/tokenizer.json`, join(options.dir, 'tokenizer.json'), 'tokenizer.json');
  await download(`${base}/config.json`, join(options.dir, 'config.json'), 'config.json');
  await download(`${base}/${model.graph}`, join(options.dir, 'model.onnx'), 'model.onnx');

  console.log('\nDone. Restart FluentFlow, then paste a word list or reveal a card.');
}

await main();
