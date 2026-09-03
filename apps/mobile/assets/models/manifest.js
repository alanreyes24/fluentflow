/**
 * Model asset manifest.
 *
 * Metro resolves `require` at bundle time, so a `require('./model.onnx')`
 * guarded by try/catch does not help when the weights are absent — the build
 * fails before any code runs. This file is the indirection that fixes that: it
 * is committed with null entries, and `npm run prepare-model` rewrites it to
 * require the real files once they exist.
 *
 * Do not add the requires by hand. Run `npm run prepare-model`.
 */
module.exports = {
  model: null,
  tokenizer: null,
  config: null,
};
