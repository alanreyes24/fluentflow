import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';

/**
 * Locating the bundled model files.
 *
 * ONNX Runtime needs a filesystem path, not a bundler module, and the three
 * files behave differently:
 *
 *  - `model.onnx` is hundreds of megabytes. `expo-asset` copies it into the
 *    app's cache directory on first launch and hands back a local URI.
 *  - `tokenizer.json` and `config.json` are small JSON that gets read into
 *    memory once.
 *
 * The weights are not in version control (see `.gitignore`) — `npm run
 * prepare-model` fetches and converts them. Everything here therefore treats a
 * missing model as an ordinary state, not an error: `loadModelAssets` returns
 * `null` and the example pipeline uses written sentences instead.
 */

export interface ModelAssets {
  modelPath: string;
  tokenizerJson: unknown;
  configJson: unknown;
}

let cached: ModelAssets | null | undefined;

export async function loadModelAssets(): Promise<ModelAssets | null> {
  if (cached !== undefined) return cached;
  cached = await resolveAssets();
  return cached;
}

async function resolveAssets(): Promise<ModelAssets | null> {
  try {
    // `require` rather than `import`: these paths do not exist until
    // prepare-model has run, and a static import would break the bundle.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const modelModule = require('../../assets/models/model.onnx');
    const tokenizerModule = require('../../assets/models/tokenizer.json');
    const configModule = require('../../assets/models/config.json');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const asset = Asset.fromModule(modelModule);
    await asset.downloadAsync();

    const modelPath = asset.localUri ?? asset.uri;
    if (!modelPath) return null;

    return {
      modelPath: stripFileScheme(modelPath),
      tokenizerJson: unwrap(tokenizerModule),
      configJson: unwrap(configModule),
    };
  } catch {
    // Missing weights, or a bundler that could not resolve them.
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
    const info = await FileSystem.getInfoAsync(`file://${assets.modelPath}`);
    return info.exists && 'size' in info ? (info.size ?? null) : null;
  } catch {
    return null;
  }
}
