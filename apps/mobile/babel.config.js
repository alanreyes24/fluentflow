// Metro reads `babel-preset-expo` by default, so this file exists for Jest,
// which has no such default and cannot otherwise parse JSX or TypeScript.
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
