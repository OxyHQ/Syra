/**
 * MINIMAL ESLint config. Biome (`biome.json` at the repository root) formats and
 * lints everything; this file holds only the rules Biome has no equivalent for,
 * and `expo lint` (`bun run lint`) runs it.
 *
 *  - `expo/no-env-var-destructuring` and `expo/no-dynamic-env-var`: Metro inlines
 *    `process.env.EXPO_PUBLIC_*` only when it is read as a literal member
 *    expression. A destructured or computed read is silently `undefined` in the
 *    bundle, and nothing else catches it. `expo/use-dom-exports` keeps a
 *    `'use dom'` file exporting the one default component Expo can mount.
 *  - The React Compiler rules of `eslint-plugin-react-hooks` 7 (`immutability`,
 *    `refs`, `purity`, ...). `app.config.js` turns the compiler on, and a
 *    component that breaks one of these is silently left uncompiled.
 *    `rules-of-hooks` and `exhaustive-deps` are NOT here: Biome's
 *    `useHookAtTopLevel` and `useExhaustiveDependencies` run them.
 *
 * Every other rule eslint-config-expo enforced either has a Biome equivalent
 * (configured in `biome.json`) or is covered by `tsc`.
 */
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expo = require('eslint-plugin-expo');
const reactHooks = require('eslint-plugin-react-hooks');

const reactCompilerRules = Object.fromEntries(
  Object.entries(reactHooks.configs.flat.recommended.rules).filter(
    ([name]) => name !== 'react-hooks/rules-of-hooks' && name !== 'react-hooks/exhaustive-deps',
  ),
);

module.exports = defineConfig([
  { ignores: ['dist/*', '.expo/*'] },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo, 'react-hooks': reactHooks },
    rules: {
      'expo/use-dom-exports': 'error',
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
      ...reactCompilerRules,
    },
  },
]);
