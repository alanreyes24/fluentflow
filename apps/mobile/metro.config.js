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
// `disableHierarchicalLookup` is deliberately NOT set.
//
// It was, to stop a hoisted second copy of React being resolved and breaking
// hooks. That is now handled properly by the `overrides` block in the root
// package.json, which pins react, react-dom and react-native to one version
// each, so there is no second copy to find.
//
// Turning the hierarchical walk off is worse than it looks, because the two
// roots above are then the *only* places Metro will search. A package's own
// nested dependencies become unresolvable: `@firebase/app` keeps its copy of
// `idb` in `node_modules/@firebase/app/node_modules/idb`, and the web bundle
// failed to build with "import idb" unresolved. It had been working by
// accident, because @react-native-async-storage/async-storage 3.x depended on
// idb and npm hoisted that copy to the root; aligning async-storage to the
// version the SDK expects removed it and the build broke immediately.

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
