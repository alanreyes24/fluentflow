// Metro must be told about the monorepo: @fluentflow/core lives outside this
// app's directory, and its dependencies are hoisted to the workspace root.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Without this, a hoisted copy of React can be resolved twice and hooks break.
config.resolver.disableHierarchicalLookup = true;

// Treat these as assets rather than source:
//  - onnx/bin/ort: the bundled model weights and their external data files.
//  - wasm: expo-sqlite's web backend imports wa-sqlite.wasm directly, and the
//    web bundle fails to resolve it unless Metro knows it is an asset.
config.resolver.assetExts.push('onnx', 'bin', 'ort', 'wasm');

/**
 * Make `onnxruntime-react-native` genuinely optional.
 *
 * It is a native module that needs a development build, so the app has to
 * build and run without it. Neither obvious approach works: a dynamic
 * `await import()` is a Hermes compile error, and a static `require` in a
 * try/catch still fails at bundle time when the module is missing, because
 * Metro resolves requires before any code runs.
 *
 * Resolving it here instead means application code writes a plain static
 * require and checks what it got back. See src/ai/onnx-stub.ts.
 */
const ONNX_MODULE = 'onnxruntime-react-native';
const ONNX_STUB = path.resolve(projectRoot, 'src/ai/onnx-stub.ts');

const onnxIsInstalled = (() => {
  try {
    require.resolve(ONNX_MODULE, { paths: config.resolver.nodeModulesPaths });
    return true;
  } catch {
    return false;
  }
})();

if (!onnxIsInstalled) {
  const upstreamResolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === ONNX_MODULE) {
      return { type: 'sourceFile', filePath: ONNX_STUB };
    }
    return upstreamResolveRequest
      ? upstreamResolveRequest(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
