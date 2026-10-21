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
  // Three round trips: the owner's bearer once (then reused from core's 30 s
  // validation cache), the conflicting claim (a different bearer, refused and
  // never cached), and the revoked session once its cached entry is dropped.
  expect(receipt.validations).toBe(3);
  // Three admits: the first validation, and the cached reuse twice — once while
  // active, once after revocation but within the documented max staleness.
  expect(receipt.admitted).toBe(3);
  expect(receipt.nonLoopbackRequests).toBe(0);
});
