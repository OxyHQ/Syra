// The shared Oxy Metro config, as the listener app uses. With no `nativewind`
// in package.json it applies no NativeWind wrapper (`@oxy.so/app-preset` README).
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@syra/shared-types',
  // Build-output source maps next to sources would otherwise be resolvable.
  extraBlockList: [/\.(js|jsx|mjs|cjs|ts|tsx|css)\.map$/],
});
