import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import manifest from '../../assets/models/manifest';

/**
 * Locating the bundled model files.
 *
 * ONNX Runtime needs a filesystem path, not a bundler module, and the three
 * files behave differently:
 *
 *  - `model.onnx` is hundreds of megabytes. `expo-asset` copies it out of the
 *    bundle on first launch and hands back a local URI.
 *  - `tokenizer.json` and `config.json` are small enough to read into memory
 *    once and keep.
 *
 * They are reached through `assets/models/manifest.js` rather than required
 * directly, because Metro resolves `require` at bundle time: a
 * `require('./model.onnx')` wrapped in try/catch still breaks the build when
 * the weights are absent. The manifest is committed with null entries and
 * rewritten by `npm run prepare-model`.
 *
 * A missing model is an ordinary state, not an error — `loadModelAssets`
 * returns `null` and the example pipeline uses written sentences instead.
 */

export interface ModelAssets {
  modelPath: string;
  tokenizerJson: unknown;
  configJson: unknown;
}

interface ModelManifest {
  model: number | string | null;
  tokenizer: unknown;
  config: unknown;
}

let cached: ModelAssets | null | undefined;

export async function loadModelAssets(): Promise<ModelAssets | null> {
  if (cached !== undefined) return cached;
  cached = await resolveAssets();
  return cached;
}

async function resolveAssets(): Promise<ModelAssets | null> {
  const entries = manifest as ModelManifest;
  if (entries.model === null || !entries.tokenizer || !entries.config) return null;

  try {
    const asset = Asset.fromModule(entries.model);
    await asset.downloadAsync();

    const uri = asset.localUri ?? asset.uri;
    if (!uri) return null;

    return {
      modelPath: stripFileScheme(uri),
      tokenizerJson: unwrap(entries.tokenizer),
      configJson: unwrap(entries.config),
    };
  } catch {
    // The asset could not be unpacked — a truncated download, or no space.
    return null;
  }
}

/** ONNX Runtime wants a bare path; expo-asset hands back a `file://` URI. */
function stripFileScheme(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

function unwrap(module: unknown): unknown {
  return module && typeof module === 'object' && 'default' in module
    ? (module as { default: unknown }).default
    : module;
}

/** Byte size of the bundled weights, for the settings screen. */
export async function modelSizeBytes(): Promise<number | null> {
  const assets = await loadModelAssets();
  if (!assets) return null;
  try {
    const file = new File(`file://${assets.modelPath}`);
    return file.exists ? (file.size ?? null) : null;
  } catch {
    return null;
  }
}
