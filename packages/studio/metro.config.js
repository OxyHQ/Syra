const path = require('node:path');
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@syra/shared-types',
  cssInput: './styles/global.css',
  extraBlockList: [
    // The listener app is a sibling workspace; Studio never bundles from it.
    path.resolve(__dirname, '../frontend'),
    // Build-output source maps next to sources would otherwise be resolvable. Only
    // `<ext>.map` files: a bare /\.map$/ also matches the `array.prototype.map`
    // package, which LiveKit's promise.allsettled requires.
    /\.(js|jsx|mjs|cjs|ts|tsx|css)\.map$/,
  ],
});
