// The shared Oxy Metro config, as the listener app uses. Composing
// `withNativeWind` by hand left out the preset's complete `react-native` shim
// (React Native 0.88's `AssetRegistry`), so `useFonts` failed and an Android
// release stayed on a blank screen (`@oxy.so/app-preset` README, Metro).
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@syra/shared-types',
  cssInput: './styles/global.css',
  // Build-output source maps next to sources would otherwise be resolvable.
  extraBlockList: [/\.(js|jsx|mjs|cjs|ts|tsx|css)\.map$/],
});
