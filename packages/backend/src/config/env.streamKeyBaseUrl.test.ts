import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * Production must not boot on a local-dev media origin.
 *
 * `STREAM_KEY_BASE_URL` is stamped into every URL a client is told to fetch —
 * the HLS master playlist, the variant playlists, the key, the podcast RSS
 * link. Empty is the LOCAL-DEV value: on a dev machine the app and the API share
 * an origin, so a relative URL is correct there.
 *
 * The live task definition never set it. In production `syra.fm` serves the app
 * and `api.syra.fm` serves the API, so the relative URL resolved against the WEB
 * origin, `hls.loadSource()` was handed the SPA's HTML, and the player reported
 * `NotSupportedError: Failed to load because no supported source was found` —
 * with a 200 from the resolver, nothing failing server-side, and no error in any
 * log. One unset variable, degrading silently.
 *
 * ## Why this runs `env.ts` in a CHILD PROCESS
 *
 * The module parses `process.env` once at import and throws there. That is the
 * real boot path and it is exactly what has to be tested — mutating
 * `process.env` in this process and re-importing would either hit the module
 * cache or test a re-parse that production never performs. Spawning is what
 * makes the assertion "the service refuses to start", rather than "a schema
 * object rejects an input".
 */

// `__dirname`, not `import.meta.dir`: this package builds to CommonJS, where
// `import.meta` is a TS1470 error — the same reason `db/__tests__/gates.test.ts`
// gives for its own use of `__dirname`.
const ENV_MODULE = join(__dirname, 'env.ts');

/** Import `config/env.ts` under a given environment, and report how it went. */
async function boot(
  overrides: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(
    [process.execPath, '-e', `await import(${JSON.stringify(ENV_MODULE)});`],
    {
      // A pristine base: inheriting the developer's own environment would let a
      // locally-exported STREAM_KEY_BASE_URL decide the result of these tests.
      env: { PATH: process.env.PATH ?? '', ...overrides },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, output: `${stdout}${stderr}` };
}

describe('STREAM_KEY_BASE_URL', () => {
  it('refuses to boot in production when it is unset', async () => {
    const result = await boot({ NODE_ENV: 'production' });

    expect(result.ok).toBe(false);
    // Naming the variable is the whole point: the outage was invisible, and a
    // failure that does not say which value is wrong reproduces that.
    expect(result.output).toContain('STREAM_KEY_BASE_URL');
    expect(result.output).toContain('https://api.syra.fm');
  });

  it('refuses a relative value in production', async () => {
    // The shape that shipped: addressable-looking, and useless from another
    // origin.
    for (const value of ['/api', 'api.syra.fm', '//api.syra.fm', 'ftp://api.syra.fm']) {
      const result = await boot({ NODE_ENV: 'production', STREAM_KEY_BASE_URL: value });
      expect(result.ok, `'${value}' must be refused in production`).toBe(false);
      expect(result.output).toContain('STREAM_KEY_BASE_URL');
    }
  });

  it('boots in production with an absolute origin', async () => {
    const result = await boot({
      NODE_ENV: 'production',
      STREAM_KEY_BASE_URL: 'https://api.syra.fm',
    });

    expect(result.ok, result.output).toBe(true);
  });

  /**
   * The floor. Without it a refinement that rejected EVERYTHING would satisfy
   * both refusals above, and every developer machine would stop booting.
   */
  it('still boots with it unset outside production', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const result = await boot({ NODE_ENV });
      expect(result.ok, `${NODE_ENV}: ${result.output}`).toBe(true);
    }
  });

  /**
   * A trailing slash is normalised rather than refused: every consumer
   * concatenates `${base}/api/...`, so the alternative is `//api` — a different
   * URL nobody intended, and not worth refusing a deployment over.
   */
  it('normalises a trailing slash instead of emitting a double slash', async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { env } = await import(${JSON.stringify(ENV_MODULE)}); console.log(env.STREAM_KEY_BASE_URL);`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'production',
          STREAM_KEY_BASE_URL: 'https://api.syra.fm//',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('https://api.syra.fm');
  });
});
