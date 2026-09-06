#!/usr/bin/env node
/**
 * Check a hosted-model API key, end to end, before trusting it in the app.
 *
 * It runs the real pipeline — the app's prompt, the app's HTTP call, the app's
 * parser and the app's validation — against the real service, and prints what
 * came back plus what it cost. That is worth having as a separate script
 * because the three things that go wrong here fail in ways that look identical
 * from inside the app: a key with the wrong permissions, a model name that has
 * been retired, and a network that quietly drops the request all end as "the
 * examples are generic again".
 *
 *   GEMINI_API_KEY=... node scripts/check-cloud-model.mjs
 *   node scripts/check-cloud-model.mjs --key AIza... --word lodazal
 *   node scripts/check-cloud-model.mjs --model gemini-2.5-flash-lite
 *
 * Nothing here reads or writes the app's stored key. The app keeps its own in
 * the OS keychain (apps/desktop/cloud.js); this takes one on the command line
 * so that checking a key is not the same act as installing it.
 */

// The key lives in a gitignored `.env` at the repo root. Loaded here rather
// than required in the environment so that running this is one command, and
// tolerated when absent because `--key` is the other way in.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No .env: --key or an exported variable, or the error below.
}

import {
  DEFAULT_REMOTE_MODEL,
  EXAMPLES_SCHEMA,
  REMOTE_FAMILY,
  createRemoteInference,
  generateExamples,
} from '@fluentflow/core';

/**
 * Published rates per million tokens, September 2026, for the default model.
 *
 * Only ever used to print an estimate. It is here because "it worked" is not
 * the question people actually have about a metered API — "what will a deck
 * cost me" is — and a number measured on one real request answers it better
 * than a paragraph of reassurance.
 */
const RATES = { input: 0.25, output: 1.5 };

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const key = arg('key', process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
const model = arg('model', DEFAULT_REMOTE_MODEL);
const word = arg('word', 'lodazal');
const language = arg('language', 'es');
const meaning = arg('meaning', undefined);

if (!key) {
  console.error(
    'No API key. Pass --key, or set GEMINI_API_KEY.\n' +
      'Get one free at https://aistudio.google.com/apikey',
  );
  process.exit(2);
}

// Captured off the wire rather than estimated: the token counts that decide the
// bill are the service's, and its idea of how many tokens a prompt is differs
// from any local guess.
let usage = null;
const fetchImpl = async (url, init) => {
  const response = await fetch(url, init);
  const body = await response.text();
  try {
    usage = JSON.parse(body).usageMetadata ?? usage;
  } catch {
    // A non-JSON body is an error body; the status code carries the message.
  }
  return new Response(body, { status: response.status, headers: response.headers });
};

console.log(`Asking ${model} for two ${language} sentences using "${word}"…`);

const started = Date.now();
const result = await generateExamples(
  { word, meaning, language, count: 2 },
  {
    infer: createRemoteInference({ apiKey: key, model, responseSchema: EXAMPLES_SCHEMA, fetchImpl }),
    family: REMOTE_FAMILY,
    budgetMs: 30000,
    maxTokens: 128,
  },
);

console.log('');
for (const example of result.examples) console.log(`  ${example}`);
console.log('');
console.log(`source     ${result.source}`);
console.log(`took       ${Date.now() - started} ms`);
if (result.error) console.log(`note       ${result.error}`);

if (usage) {
  const cost =
    (usage.promptTokenCount * RATES.input + usage.candidatesTokenCount * RATES.output) / 1e6;
  console.log(`tokens     ${usage.promptTokenCount} in, ${usage.candidatesTokenCount} out`);
  console.log(`cost       $${cost.toFixed(6)} for this card, ~$${(cost * 1000).toFixed(2)} per 1000`);
}

// `fallback` means the carrier sentences shipped: the service was not reached,
// or what it returned did not survive validation. Either way the app would show
// generic examples, so this must not exit 0 and look like a pass.
if (result.source !== 'model') {
  console.error('\nThe hosted model did not produce usable sentences.');
  process.exit(1);
}
console.log('\nWorking. Paste the same key into Settings → Cloud examples.');
