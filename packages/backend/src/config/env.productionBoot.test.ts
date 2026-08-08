import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * The variables production refuses to boot without, and why each one is checked
 * against `NODE_ENV` rather than on its own.
 *
 * Two rules live in `env.ts`'s refinement, and they are here together because
 * they are the same rule shape and the same failure mode: a value that is
 * legitimately unset on a developer's machine, silently useless in production,
 * and invisible when wrong. `STREAM_KEY_BASE_URL` is the one that already
 * happened; `DATABASE_URL` is the one the Postgres cutover made possible.
 *
 * ## STREAM_KEY_BASE_URL
 *
 * It is stamped into every URL a client is told to fetch —
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
 * ## DATABASE_URL
 *
 * Postgres is the only database this service opens since the 2026-08-08
 * cutover, and the variable naming it was read straight from `process.env` by
 * `db/postgres.ts` and `db/migrate.ts` while being declared in no schema at all
 * — so nothing checked it at boot. It degrades the same way: `bootServer`
 * catches a failed `connectPostgres()`, logs and continues (right for a database
 * that is momentarily unreachable, wrong for one that was never configured), so
 * an unset value yields a process that starts, listens, and answers 503 from
 * every route.
 *
 * The scheme is asserted, not merely the URL shape, because `z.string().url()`
 * accepts `mongodb+srv://…` — and a leftover Mongo connection string in this
 * slot is the specific wrong value the cutover could produce.
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

/**
 * Each describe below satisfies the OTHER rule so that a failure names the
 * variable under test. Without this a production boot fails for two reasons at
 * once, and "refuses to boot" stops distinguishing which refinement did it.
 */
const VALID_DATABASE_URL = 'postgres://syra:syra@127.0.0.1:5432/syra_ci';
const VALID_STREAM_KEY_BASE_URL = 'https://api.syra.fm';

describe('STREAM_KEY_BASE_URL', () => {
  it('refuses to boot in production when it is unset', async () => {
    const result = await boot({ NODE_ENV: 'production', DATABASE_URL: VALID_DATABASE_URL });

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
      const result = await boot({
        NODE_ENV: 'production',
        DATABASE_URL: VALID_DATABASE_URL,
        STREAM_KEY_BASE_URL: value,
      });
      expect(result.ok, `'${value}' must be refused in production`).toBe(false);
      expect(result.output).toContain('STREAM_KEY_BASE_URL');
    }
  });

  it('boots in production with an absolute origin', async () => {
    const result = await boot({
      NODE_ENV: 'production',
      DATABASE_URL: VALID_DATABASE_URL,
      STREAM_KEY_BASE_URL: VALID_STREAM_KEY_BASE_URL,
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
          DATABASE_URL: VALID_DATABASE_URL,
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

describe('DATABASE_URL', () => {
  it('refuses to boot in production when it is unset', async () => {
    const result = await boot({
      NODE_ENV: 'production',
      STREAM_KEY_BASE_URL: VALID_STREAM_KEY_BASE_URL,
    });

    expect(result.ok).toBe(false);
    // Naming the variable is the point, as above: the whole failure mode is a
    // service that starts and then 503s with nothing saying why.
    expect(result.output).toContain('DATABASE_URL');
  });

  it('refuses a value that is not a postgres connection string', async () => {
    /**
     * `mongodb+srv://` is first deliberately: it passes `z.string().url()`, it
     * is the value that sat in this slot's neighbourhood until the cutover, and
     * it is the one a copy-paste from the old task definition would produce.
     * The rest are the ordinary shapes of a half-filled variable.
     */
    for (const value of [
      'mongodb+srv://user:pass@cluster.mongodb.net/syra',
      'mongodb://127.0.0.1:27017/syra',
      'redis://127.0.0.1:6379',
      'syra_ci',
      'host.rds.amazonaws.com:5432/syra',
    ]) {
      const result = await boot({
        NODE_ENV: 'production',
        DATABASE_URL: value,
        STREAM_KEY_BASE_URL: VALID_STREAM_KEY_BASE_URL,
      });
      expect(result.ok, `'${value}' must be refused in production`).toBe(false);
      expect(result.output).toContain('DATABASE_URL');
    }
  });

  it('never prints the password of a value it rejects', async () => {
    // The refusal quotes the offending value so the operator can see what is
    // set, which is only safe because the credential is stripped first. A
    // production boot failure is logged, and log lines outlive the incident.
    const result = await boot({
      NODE_ENV: 'production',
      DATABASE_URL: 'mongodb+srv://syra:hunter2-do-not-log@cluster.mongodb.net/syra',
      STREAM_KEY_BASE_URL: VALID_STREAM_KEY_BASE_URL,
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain('hunter2-do-not-log');
    // And the redaction must not be achieved by printing nothing useful.
    expect(result.output).toContain('cluster.mongodb.net');
  });

  it('boots in production with a postgres connection string', async () => {
    for (const value of [
      VALID_DATABASE_URL,
      // The production shape: `postgresql://`, and the `?sslmode=require` the
      // RDS parameter group's `rds.force_ssl = 1` obliges.
      'postgresql://syra:pw@oxy-postgres.us-west-2.rds.amazonaws.com:5432/syra?sslmode=require',
    ]) {
      const result = await boot({
        NODE_ENV: 'production',
        DATABASE_URL: value,
        STREAM_KEY_BASE_URL: VALID_STREAM_KEY_BASE_URL,
      });
      expect(result.ok, `'${value}': ${result.output}`).toBe(true);
    }
  });

  /**
   * The floor, and it is not decoration: `env.ts` is parsed at import by fifteen
   * modules, and the test harness (`src/test/postgres.ts`) resolves
   * `TEST_DATABASE_URL` and assigns `process.env.DATABASE_URL` in `beforeAll` —
   * after that parse. A `DATABASE_URL` required unconditionally rather than
   * under `NODE_ENV === 'production'` therefore throws at import across the
   * suite and in every developer script. This is the test that fails if somebody
   * "simplifies" the refinement into a plain required field.
   */
  it('still boots with it unset outside production', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const result = await boot({ NODE_ENV });
      expect(result.ok, `${NODE_ENV}: ${result.output}`).toBe(true);
    }
  });
});
