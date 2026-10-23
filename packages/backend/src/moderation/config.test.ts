import { afterEach, expect, test } from 'bun:test';
import { crowdSourceConfig, resetCrowdSourceConfig } from './config';
import { oxy } from '../oxyClient';

const keys = [
  'CROWDSOURCE_ENABLED',
  'CROWDSOURCE_SERVICE_KEY',
  'CROWDSOURCE_WEBHOOK_SECRET',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetCrowdSourceConfig();
});
test('own moderation needs its signed webhook, not a customer credential', () => {
  process.env.CROWDSOURCE_ENABLED = 'true';
  process.env.CROWDSOURCE_WEBHOOK_SECRET = 'delivery-signature';
  process.env.CROWDSOURCE_SERVICE_KEY = 'legacy-key-must-not-select-authority';
  resetCrowdSourceConfig();
  const config = crowdSourceConfig();
  expect(config.enabled).toBe(true);
  expect(config.auth).toBe('oxy-service');
  expect(config.oxy).toBe(oxy);
  expect(config).not.toHaveProperty('serviceKey');
  expect(config.webhookSecret).toBe('delivery-signature');
});
test('own identity does not make an unconfigured webhook usable', () => {
  process.env.CROWDSOURCE_ENABLED = 'true';
  delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
  resetCrowdSourceConfig();
  expect(crowdSourceConfig().enabled).toBe(false);
});
