import fs from 'node:fs';
import path from 'node:path';

type BuildPropertiesConfig = { expo: { plugins?: unknown[] } };
const buildConfig = jest.requireActual('../app.config.js') as (
  config: object,
) => BuildPropertiesConfig;

/** R8 rules the installed WebRTC AAR ships to the app (its consumer rules). */
function installedWebrtcRules(): string {
  const androidRoot = path.join(
    path.dirname(require.resolve('@livekit/react-native-webrtc/package.json')),
    'android',
  );
  const walk = (directory: string): string[] =>
    fs.readdirSync(directory).flatMap((entry) => {
      const file = path.join(directory, entry);
      if (fs.statSync(file).isDirectory()) return entry === 'build' ? [] : walk(file);
      return file.endsWith('.pro') ? [fs.readFileSync(file, 'utf8')] : [];
    });
  return walk(androidRoot).join('\n');
}

function appProguardRules(): string {
  const plugins = buildConfig({}).expo.plugins ?? [];
  const entry = plugins.find(
    (plugin): plugin is [string, { android?: { extraProguardRules?: string } }] =>
      Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
  );
  return entry?.[1].android?.extraProguardRules ?? '';
}

/**
 * The PREFIXED WebRTC build loads `livekit.org.jni_zero.JniInit` by name from
 * `JNI_OnLoad`. If R8 strips it, the release app aborts at startup
 * (livekit/react-native-webrtc#107) — and no JS test, typecheck or web build
 * can see that. Someone must keep it. Same test as Allo's; `packages/studio`
 * carries a copy for its own config.
 */
it('keeps the prefixed WebRTC jni_zero classes in release builds', () => {
  const installed = installedWebrtcRules();
  expect(installed).toContain('livekit.org.webrtc');
  const upstreamKeeps = installed.includes('-keep class livekit.org.jni_zero.**');
  const appKeeps = appProguardRules().includes('-keep class livekit.org.jni_zero.** { *; }');
  expect(upstreamKeeps || appKeeps).toBe(true);
  // When upstream ships the rule (webrtc 150.1.0), delete ours from app.config.js.
  expect(upstreamKeeps && appKeeps).toBe(false);
});
