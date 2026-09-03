#!/usr/bin/env node
/**
 * Fetch, convert and quantise the on-device language model.
 *
 * The weights are not in version control — a quantised TinyLlama is ~600 MB and
 * an fp32 export is over 4 GB, which is not something to put in a git history.
 * This script produces the three files the app looks for:
 *
 *   apps/mobile/assets/models/model.onnx       the quantised graph
 *   apps/mobile/assets/models/tokenizer.json   vocabulary and BPE merges
 *   apps/mobile/assets/models/config.json      layer/head geometry for the KV cache
 *
 * It shells out to Hugging Face Optimum rather than reimplementing the export:
 * getting `use_cache=True` right, with the `past_key_values.*` inputs and
 * `present.*` outputs the decoder in src/ai/model.ts expects, is exactly what
 * Optimum's ONNX exporter already does.
 *
 * Usage:
 *   node scripts/prepare-model.mjs                       # TinyLlama 1.1B, int8
 *   node scripts/prepare-model.mjs --model phi2          # Phi-2 2.7B
 *   node scripts/prepare-model.mjs --precision fp16
 *   node scripts/prepare-model.mjs --keep-work           # keep the fp32 export
 */

import { spawn } from 'node:child_process';
import { mkdir, copyFile, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, 'apps', 'mobile', 'assets', 'models');
const WORK_DIR = join(ROOT, '.model-work');

/**
 * Supported models.
 *
 * `family` must match the `ai.modelFamily` in app.json, because it selects the
 * chat template in packages/core/src/ai/prompt.ts. Feeding TinyLlama a Phi-2
 * prompt produces fluent nonsense rather than an error, so the two have to
 * agree.
 */
const MODELS = {
  tinyllama: {
    repo: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0',
    family: 'tinyllama',
    approxQuantisedMb: 620,
    note: '1.1B parameters. The realistic choice for a phone.',
  },
  phi2: {
    repo: 'microsoft/phi-2',
    family: 'phi2',
    approxQuantisedMb: 1600,
    note: '2.7B parameters. Noticeably better sentences, and slower — expect to '
      + 'raise ai.budgetMs above 2000 on anything but a recent flagship.',
  },
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = MODELS[options.model];

  if (!model) {
    fail(`Unknown model "${options.model}". Choose one of: ${Object.keys(MODELS).join(', ')}.`);
  }

  console.log(`\nFluentFlow model preparation`);
  console.log(`  model      ${model.repo}`);
  console.log(`  precision  ${options.precision}`);
  console.log(`  output     ${OUTPUT_DIR}`);
  console.log(`  ${model.note}\n`);

  if (existsSync(join(OUTPUT_DIR, 'model.onnx')) && !options.force) {
    console.log('A model is already installed. Pass --force to replace it.');
    return;
  }

  await checkPython();
  await installPythonDeps(options);

  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const exportDir = join(WORK_DIR, options.model);
  await exportToOnnx(model, exportDir, options);
  const graph = await quantise(exportDir, options);
  await collect(exportDir, graph);

  if (!options.keepWork) {
    console.log('\nCleaning up the intermediate export…');
    await rm(WORK_DIR, { recursive: true, force: true });
  }

  await report(model);
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    model: 'tinyllama',
    precision: 'int8',
    force: false,
    keepWork: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--model':
        options.model = argv[++i] ?? options.model;
        break;
      case '--precision':
        options.precision = argv[++i] ?? options.precision;
        break;
      case '--force':
        options.force = true;
        break;
      case '--keep-work':
        options.keepWork = true;
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      default:
        fail(`Unrecognised argument "${arg}".\n\n${usage()}`);
    }
  }

  if (!['int8', 'fp16', 'fp32'].includes(options.precision)) {
    fail(`--precision must be int8, fp16 or fp32 (got "${options.precision}").`);
  }

  return options;
}

function usage() {
  return [
    'Usage: node scripts/prepare-model.mjs [options]',
    '',
    '  --model <name>       tinyllama (default) or phi2',
    '  --precision <mode>   int8 (default), fp16 or fp32',
    '  --force              replace an already-installed model',
    '  --keep-work          keep the intermediate fp32 export in .model-work/',
  ].join('\n');
}

async function checkPython() {
  const python = await firstWorking([
    ['python', ['--version']],
    ['python3', ['--version']],
  ]);

  if (!python) {
    fail(
      'Python 3.9+ is required to export the model.\n' +
        'Install it from https://www.python.org/downloads/ and run this again.',
    );
  }

  process.env.FLUENTFLOW_PYTHON = python;
  console.log(`Using ${python}.`);
}

async function firstWorking(candidates) {
  for (const [command, args] of candidates) {
    try {
      await run(command, args, { quiet: true });
      return command;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function installPythonDeps(options) {
  const python = process.env.FLUENTFLOW_PYTHON;
  console.log('\nInstalling the export toolchain (this can take a few minutes)…');

  // `optimum[exporters]` pulls in torch, which is the bulk of the download.
  const packages = ['optimum[exporters]>=1.24.0', 'onnx>=1.17.0', 'transformers>=4.44.0'];
  if (options.precision === 'int8') packages.push('onnxruntime>=1.20.0');

  await run(python, ['-m', 'pip', 'install', '--upgrade', ...packages]);
}

async function exportToOnnx(model, exportDir, options) {
  const python = process.env.FLUENTFLOW_PYTHON;
  console.log(`\nExporting ${model.repo} to ONNX…`);
  console.log('  The first run downloads the weights from Hugging Face.');

  // `--task text-generation-with-past` is the important flag: it produces the
  // KV-cache inputs and outputs the decoder relies on. Exporting plain
  // `text-generation` gives a graph that works for one token and then fails on
  // the second with a missing-input error.
  await run(python, [
    '-m',
    'optimum.exporters.onnx',
    '--model',
    model.repo,
    '--task',
    'text-generation-with-past',
    ...(options.precision === 'fp16' ? ['--dtype', 'fp16'] : []),
    '--opset',
    '17',
    exportDir,
  ]);
}

async function quantise(exportDir, options) {
  const source = join(exportDir, 'model.onnx');
  if (options.precision !== 'int8') return source;

  const python = process.env.FLUENTFLOW_PYTHON;
  const target = join(exportDir, 'model-int8.onnx');

  console.log('\nQuantising weights to int8…');

  // Dynamic quantisation, weights only: activations stay float, which keeps
  // output quality close to the original while cutting the download roughly
  // fourfold. Static quantisation would be smaller and faster but needs a
  // calibration dataset, and a badly calibrated small model produces garbage.
  const script = [
    'import onnx',
    'from onnxruntime.quantization import quantize_dynamic, QuantType',
    `quantize_dynamic(${JSON.stringify(source)}, ${JSON.stringify(target)},`,
    '    weight_type=QuantType.QInt8, extra_options={"MatMulConstBOnly": True})',
    'print("quantised")',
  ].join('\n');

  await run(python, ['-c', script]);
  return target;
}

async function collect(exportDir, graphPath) {
  console.log('\nCollecting the app assets…');

  await copyFile(graphPath, join(OUTPUT_DIR, 'model.onnx'));

  // A large export writes its tensors into sidecar `.onnx_data` files. ONNX
  // Runtime loads them by the name recorded in the graph, so they have to sit
  // next to model.onnx with their original names.
  for (const entry of await readdir(exportDir)) {
    if (entry.endsWith('.onnx_data') || entry.endsWith('.pb')) {
      await copyFile(join(exportDir, entry), join(OUTPUT_DIR, entry));
      console.log(`  external data: ${entry}`);
    }
  }

  for (const file of ['tokenizer.json', 'config.json']) {
    const source = join(exportDir, file);
    if (!existsSync(source)) {
      fail(
        `The export did not produce ${file}. ` +
          'The app needs it for tokenisation and KV-cache geometry.',
      );
    }
    await copyFile(source, join(OUTPUT_DIR, file));
  }
}

async function report(model) {
  const { size } = await stat(join(OUTPUT_DIR, 'model.onnx'));
  const megabytes = Math.round(size / (1024 * 1024));

  console.log('\nDone.');
  console.log(`  model.onnx  ${megabytes} MB`);
  console.log('\nNext steps:');
  console.log('  1. npm --workspace @fluentflow/mobile install onnxruntime-react-native');
  console.log(`  2. Set extra.ai.modelFamily to "${model.family}" in apps/mobile/app.json`);
  console.log('  3. npx expo prebuild && npx expo run:ios   (a dev build, not Expo Go)');
  console.log('\nThe app runs without any of this — examples fall back to written');
  console.log('sentences, and Settings says the model is not installed.\n');
}

function run(command, args, { quiet = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: quiet ? 'ignore' : 'inherit',
      // Needed on Windows, where python/pip are shims rather than executables.
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
