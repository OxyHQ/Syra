# Lint and format details

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

Biome 2.5.15 (root `biome.json`) formats and lints every package; CI runs `bunx biome ci .`. `bun run lint` also runs `expo lint` in frontend and studio, whose `eslint.config.js` keeps ONLY what Biome lacks (eslint-plugin-expo's `EXPO_PUBLIC_*` rules, the React Compiler rules). The frontend's `sonner`/`sonner-native` ban is Biome's `noRestrictedImports`. `bun run lint:fix` / `bun run format` write.
