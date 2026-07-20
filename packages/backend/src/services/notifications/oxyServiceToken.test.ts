import { afterEach, describe, expect, it } from 'bun:test';
import {
  MissingOxyServiceCredentialsError,
  getOxyServiceToken,
  resetOxyServiceTokenCache,
} from './oxyServiceToken';

/**
 * The honest-failure contract: with no service credentials configured, Syra must refuse
 * loudly rather than degrade into a silent no-op. A notifier that quietly does nothing is
 * indistinguishable from one that works, which is how a broken notification pipeline
 * survives to production unnoticed.
 */
describe('getOxyServiceToken', () => {
  afterEach(resetOxyServiceTokenCache);

  it('throws a named error when credentials are absent', async () => {
    // env.OXY_SERVICE_API_KEY / _SECRET are unset in the test environment — the same
    // state as a developer machine or an unconfigured deploy.
    await expect(getOxyServiceToken()).rejects.toBeInstanceOf(MissingOxyServiceCredentialsError);
  });

  it('names both missing variables so the fix is obvious from the log line', async () => {
    await expect(getOxyServiceToken()).rejects.toThrow(/OXY_SERVICE_API_KEY/);
    await expect(getOxyServiceToken()).rejects.toThrow(/OXY_SERVICE_API_SECRET/);
  });
});
