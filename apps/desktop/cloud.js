'use strict';

/**
 * The hosted model: the user's own API key, and where it is kept.
 *
 * A hosted model is now the only thing that writes example sentences, and the
 * only thing asked about a word the dictionary does not have. It needs a key
 * and a network, writes better Spanish and far better Bosnian than the 1.2 GB
 * ONNX model it replaced, and answers in about a second instead of five to
 * seven. This file is what makes it available without shipping a credential.
 *
 * **The key belongs to the user, not to the build.** Nothing is compiled in.
 * The app is packaged with `asar: false`, so a key shipped inside it would be a
 * key published on disk to everyone who installs it. What is here instead is a
 * field in Settings and this file, which puts what the user pastes into the OS
 * keychain (`safeStorage`, which on macOS is Keychain-backed) and hands it to
 * the main process when a card needs sentences.
 *
 * **The renderer never sees it.** The preload bridge exposes whether a key is
 * configured and how to replace it; it has no getter. The key is read on this
 * side, used on this side, and the renderer receives finished sentences —
 * exactly as it already does for the local model.
 */

const { app, safeStorage } = require('electron');
const path = require('node:path');
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs');

/** Kept out of the deck database on purpose: a credential is not synced content. */
function settingsFile() {
  return path.join(app.getPath('userData'), 'cloud.json');
}

/**
 * The default, and the reason it is the default.
 *
 * `gemini-3.1-flash-lite` is the cheapest model measured to do this job well —
 * about $0.00005 a card, and a free tier a single learner will not exhaust.
 * Kept in step with `DEFAULT_REMOTE_MODEL` in packages/core, which carries the
 * measurements. The field is editable because model names age faster than
 * releases do: the model this was originally written against was retired for
 * new keys within weeks.
 */
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/** Where the user gets a key. Shown in Settings so nobody has to go hunting. */
const KEY_URL = 'https://aistudio.google.com/apikey';

let cached = null;

function read() {
  if (cached) return cached;
  const file = settingsFile();
  if (!existsSync(file)) {
    cached = {};
    return cached;
  }
  try {
    cached = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // A corrupt settings file must not stop the app launching; the user can
    // paste the key again, which is a smaller problem than a dead window.
    console.warn(`[fluentflow] cloud settings unreadable: ${error.message}`);
    cached = {};
  }
  return cached;
}

function write(settings) {
  cached = settings;
  // 0600: it holds a credential even when encrypted, and on a shared machine
  // the default 0644 would make it world-readable.
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/**
 * Store the key, encrypted where the OS offers it.
 *
 * `safeStorage` is unavailable on a Linux box with no keyring and inside some
 * CI containers. Refusing to work there would be worse than the alternative —
 * the file is already 0600 in the user's own data directory — so it degrades to
 * plaintext and records that it did, which is what {@link status} reports and
 * Settings shows.
 *
 * @param key the API key, or an empty string to remove it
 */
function setApiKey(key) {
  const trimmed = String(key ?? '').trim();
  const settings = { ...read() };

  if (!trimmed) {
    delete settings.key;
    delete settings.encrypted;
    write(settings);
    return status();
  }

  if (safeStorage.isEncryptionAvailable()) {
    settings.key = safeStorage.encryptString(trimmed).toString('base64');
    settings.encrypted = true;
  } else {
    settings.key = trimmed;
    settings.encrypted = false;
  }

  write(settings);
  return status();
}

/** The key itself. Main process only — this never crosses the preload bridge. */
function apiKey() {
  const settings = read();
  if (!settings.key) return null;
  if (!settings.encrypted) return settings.key;

  try {
    return safeStorage.decryptString(Buffer.from(settings.key, 'base64'));
  } catch (error) {
    // The keychain entry can be lost — a restored machine, a new login keychain
    // — and the ciphertext is then unrecoverable. Say so rather than failing
    // every generation with a decryption error.
    console.warn(`[fluentflow] stored key could not be decrypted: ${error.message}`);
    return null;
  }
}

/** Change which model is used, e.g. when a cheaper one appears. */
function setModel(model) {
  const settings = { ...read() };
  const trimmed = String(model ?? '').trim();
  if (trimmed) settings.model = trimmed;
  else delete settings.model;
  write(settings);
  return status();
}

function model() {
  return read().model || DEFAULT_MODEL;
}

/** Forget everything, including the file. */
function clear() {
  const file = settingsFile();
  cached = {};
  if (existsSync(file)) unlinkSync(file);
  return status();
}

/** What the renderer is allowed to know: everything except the key. */
function status() {
  const settings = read();
  const configured = Boolean(settings.key);
  return {
    available: configured,
    configured,
    model: model(),
    provider: 'gemini',
    encrypted: settings.encrypted !== false,
    keyUrl: KEY_URL,
    reason: configured ? undefined : `No API key. Get one at ${KEY_URL} and paste it here.`,
  };
}

/** Drop the in-memory copy, so an edit made outside the app is picked up. */
function reload() {
  cached = null;
}

module.exports = { apiKey, setApiKey, model, setModel, clear, status, reload, DEFAULT_MODEL, KEY_URL };
