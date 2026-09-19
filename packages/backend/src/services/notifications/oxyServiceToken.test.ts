import { afterEach, describe, expect, it } from 'bun:test';
import { canAuthenticateAsOxyService } from '../../oxyClient';
import {
  MissingOxyServiceCredentialsError,
  getOxyServiceToken,
  resetOxyServiceTokenCache,
} from './oxyServiceToken';

/**
 * Two contracts, and the second is the one oxy ADR 0026 added.
 *
 * The honest-failure contract: with no Oxy identity at all, Syra must refuse
 * loudly rather than degrade into a silent no-op. A notifier that quietly does
 * nothing is indistinguishable from one that works, which is how a broken
 * notification pipeline survives to production unnoticed.
 *
 * The capability contract: "has a key pair" and "can act as Syra" stopped being
 * the same question the day the task role could answer it. Asking the old one on
 * a deployment that attests refuses every notification for a variable nobody is
 * going to put back — so the attesting case is asserted here, where changing the
 * check back to a key read fails rather than ships.
 */
describe('getOxyServiceToken', () => {
  afterEach(resetOxyServiceTokenCache);

  it('throws a named error when this process has no Oxy identity', async () => {
    // Neither variable is set in the test environment and no container
    // credentials endpoint exists — the same state as a developer machine.
    await expect(getOxyServiceToken()).rejects.toBeInstanceOf(MissingOxyServiceCredentialsError);
  });

  it('names both variables so the fix is obvious from the log line', async () => {
    await expect(getOxyServiceToken()).rejects.toThrow(/OXY_SERVICE_API_KEY/);
    await expect(getOxyServiceToken()).rejects.toThrow(/OXY_SERVICE_API_SECRET/);
  });
});

describe('canAuthenticateAsOxyService', () => {
  const saved = {
    relativeUri: process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
    apiKey: process.env.OXY_SERVICE_API_KEY,
    apiSecret: process.env.OXY_SERVICE_API_SECRET,
  };

  afterEach(() => {
    restore('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', saved.relativeUri);
    restore('OXY_SERVICE_API_KEY', saved.apiKey);
    restore('OXY_SERVICE_API_SECRET', saved.apiSecret);
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it('is false with neither an attestable task role nor a pair', () => {
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.OXY_SERVICE_API_KEY;
    delete process.env.OXY_SERVICE_API_SECRET;
    expect(canAuthenticateAsOxyService()).toBe(false);
  });

  it('is true on a task role alone — the deployment that carries no key pair', () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/deploy-test';
    delete process.env.OXY_SERVICE_API_KEY;
    delete process.env.OXY_SERVICE_API_SECRET;
    expect(canAuthenticateAsOxyService()).toBe(true);
  });

  it('is true on a pair alone — the local checkout that borrows Syra’s identity', () => {
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    process.env.OXY_SERVICE_API_KEY = 'oxy_dk_test';
    process.env.OXY_SERVICE_API_SECRET = 'test-secret';
    expect(canAuthenticateAsOxyService()).toBe(true);
  });

  /**
   * Half a pair authenticates nothing, and a blank half is the shape this
   * actually arrives in: a task definition that declares the variable and leaves
   * it empty. Treated as present it would REPLACE the attestation path with a
   * credential that cannot mint — a working deployment turned into a 401.
   */
  it('ignores a blank or half pair rather than preferring it to attestation', () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/deploy-test';
    process.env.OXY_SERVICE_API_KEY = 'oxy_dk_test';
    process.env.OXY_SERVICE_API_SECRET = '   ';
    expect(canAuthenticateAsOxyService()).toBe(true);

    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    expect(canAuthenticateAsOxyService()).toBe(false);
  });
});
