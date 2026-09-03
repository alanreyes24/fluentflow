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
// ONNX model weights are assets, not source.
config.resolver.assetExts.push('onnx', 'bin', 'ort');

module.exports = config;
