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
          paths: ['sonner', 'sonner-native'].map((name) => ({
            name,
            message:
              "Import { toast } from '@oxyhq/bloom/toast' instead. Bloom ships the toast engine for both web and native, and OxyProvider already mounts the one outlet that renders it.",
          })),
        },
      ],
    },
  },
]);
