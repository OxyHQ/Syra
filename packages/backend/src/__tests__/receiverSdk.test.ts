import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('validates receiver identity and revocation in an isolated loopback process', () => {
  const result = spawnSync(
    'bun',
    ['--no-env-file', resolve('src/__tests__/fixtures/receiver-sdk-probe.ts')],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      },
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  if (result.status !== 0)
    throw new Error(`Receiver probe failed: ${result.error?.message ?? result.stderr}`);
  expect(result.error).toBeUndefined();
  const lines = result.stdout.trim().split('\n');
  const receipt: {
    controls: number;
    validations: number;
    admitted: number;
    nonLoopbackRequests: number;
  } = JSON.parse(lines[lines.length - 1] ?? '{}');
  expect(receipt.controls).toBe(3);
  // Five round trips, because with no live revocation feed (no service token
  // here) core >= 6.9 validates every request and caches nothing: the owner's
  // bearer, the conflicting claim (refused), the owner twice more, and the
  // revoked session — refused on the very next request.
  expect(receipt.validations).toBe(5);
  // Three admits: the owner's first call and the two calls before revocation;
  // nothing is admitted after the session ends.
  expect(receipt.admitted).toBe(3);
  expect(receipt.nonLoopbackRequests).toBe(0);
});
