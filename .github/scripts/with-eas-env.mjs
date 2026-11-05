// Runs a command with an Expo app's production build environment: the env of an
// eas.json build profile (following `extends`) plus NODE_ENV=production, the same
// environment OxyHQ/oxy's android-release.yml gives the native build. The OTA
// export must see the values the binary was built with (EXPO_PUBLIC_* are inlined
// into the bundle), so both read them from the one place, eas.json.
//
//   bun .github/scripts/with-eas-env.mjs <app-dir> <profile> -- <command> [args…]
//
// The command runs in <app-dir>. Values are public build-time config, never secrets.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [appDir, profileName, separator, command, ...args] = process.argv.slice(2);
if (!appDir || !profileName || separator !== '--' || !command) {
  console.error('usage: with-eas-env.mjs <app-dir> <profile> -- <command> [args…]');
  process.exit(2);
}

const eas = JSON.parse(readFileSync(join(appDir, 'eas.json'), 'utf8'));
const profileEnv = (name, seen = new Set()) => {
  const profile = eas.build?.[name];
  if (!profile) throw new Error(`eas.json has no build profile "${name}"`);
  if (seen.has(name)) throw new Error(`eas.json profile "${name}" extends itself`);
  seen.add(name);
  const base = profile.extends ? profileEnv(profile.extends, seen) : {};
  return { ...base, ...profile.env };
};

const env = { ...process.env, ...profileEnv(profileName), NODE_ENV: 'production' };
const result = spawnSync(command, args, { cwd: resolve(appDir), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
