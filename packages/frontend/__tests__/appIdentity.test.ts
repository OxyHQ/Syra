import fs from 'node:fs';
import path from 'node:path';

type IntentFilter = { autoVerify?: boolean; data?: { host?: string }[] };
type AppConfig = {
  expo: {
    name: string;
    ios?: { bundleIdentifier?: string };
    android?: { package?: string; intentFilters?: IntentFilter[] };
  };
};

function loadConfig(variant?: string): AppConfig['expo'] {
  const previous = process.env.APP_VARIANT;
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  try {
    let expo: AppConfig['expo'] | undefined;
    jest.isolateModules(() => {
      const build = jest.requireActual('../app.config.js') as (config: object) => AppConfig;
      expo = build({}).expo;
    });
    if (!expo) throw new Error('app.config.js returned no expo config');
    return expo;
  } finally {
    if (previous === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previous;
  }
}

const APP_ID = 'fm.syra.app';
const ECOSYSTEM_CERT =
  'B8:AB:37:46:46:6C:E4:56:9D:7A:6A:0F:FA:1E:ED:91:BC:37:51:74:D5:03:61:39:87:CA:09:CB:33:D6:A5:8D';

it('production is fm.syra.app on both platforms', () => {
  const expo = loadConfig();
  expect(expo.android?.package).toBe(APP_ID);
  expect(expo.ios?.bundleIdentifier).toBe(APP_ID);
});

it('APP_VARIANT=development is fm.syra.app.dev with its own name', () => {
  const prod = loadConfig();
  const dev = loadConfig('development');
  expect(dev.android?.package).toBe(`${APP_ID}.dev`);
  expect(dev.ios?.bundleIdentifier).toBe(`${APP_ID}.dev`);
  expect(dev.name).not.toBe(prod.name);
});

it('verifies App Links only for syra.fm, which serves assetlinks.json for the app', () => {
  const hosts = (loadConfig().android?.intentFilters ?? [])
    .filter((filter) => filter.autoVerify)
    .flatMap((filter) => (filter.data ?? []).map((entry) => entry.host));
  expect(hosts).toEqual(['syra.fm']);

  const assetLinks = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../public/.well-known/assetlinks.json'), 'utf8'),
  ) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
  expect(assetLinks.map((entry) => entry.target.package_name)).toEqual([APP_ID]);
  expect(assetLinks[0]?.target.sha256_cert_fingerprints).toEqual([ECOSYSTEM_CERT]);
});
