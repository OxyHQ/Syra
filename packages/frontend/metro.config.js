const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

const config = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@syra/shared-types',
  cssInput: './styles/global.css',
  // Build-output source maps next to sources would otherwise be resolvable.
  extraBlockList: [/\.(js|jsx|mjs|cjs|ts|tsx|css)\.map$/],
});

// External JavaScript bundles are UTF-8; keep translated text instead of expanding
// every non-ASCII character into a six-byte Unicode escape.
config.transformer.minifierConfig.output.ascii_only = false;

module.exports = config;
