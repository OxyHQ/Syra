// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'sonner',
              message:
                "Import { toast, Toaster } from '@/lib/sonner' instead. The bare package is web-only; the platform fork picks sonner-native on iOS/Android.",
            },
            {
              name: 'sonner-native',
              message:
                "Import { toast, Toaster } from '@/lib/sonner' instead. The bare package is native-only; the platform fork picks sonner on web.",
            },
          ],
        },
      ],
    },
  },
  {
    // The platform fork itself: these two files are the only legitimate place to
    // import the real packages, and are what every other call site resolves to.
    files: ['lib/sonner.ts', 'lib/sonner.web.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]);
