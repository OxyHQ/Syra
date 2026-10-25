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
// Choose the shorter quote form for each string instead of preserving source
// quotes. Translations containing quoted speech otherwise ship needless escapes.
config.transformer.minifierConfig.output.quote_style = 0;

module.exports = config;
