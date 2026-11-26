// The shared Oxy Metro config, as the listener app uses. With no `nativewind`
// in package.json it applies no NativeWind wrapper (`@oxy.so/app-preset` README).
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@syra/shared-types',
  // A React Native Text that names no family keeps the platform face (react-native-web's
  // system stack, Roboto, San Francisco), as Syra drew it on app-preset 6.7. app-preset 6.9's
  // base face (Inter) would change every raw text; adopting it is a design decision of its own.
  baseFont: false,
  // Build-output source maps next to sources would otherwise be resolvable.
  extraBlockList: [/\.(js|jsx|mjs|cjs|ts|tsx|css)\.map$/],
});
