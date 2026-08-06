import { defineConfig } from 'drizzle-kit';
import { DATABASE_CASING } from '@oxyhq/db';

/**
 * drizzle-kit configuration.
 *
 * - `bun run db:generate` diffs `schema` against `drizzle/` and writes a new
 *   SQL migration. It never opens a database, and it only ever runs on a
 *   developer's machine.
 * - Migrations are APPLIED by `bun run db:migrate` (`src/db/migrate.ts`),
 *   which uses `@oxyhq/db/migrate`'s `runMigrations` — not `drizzle-kit
 *   migrate`. drizzle-kit is a devDependency and the shipped image installs
 *   production dependencies only, so the CLI could never apply a migration in
 *   production.
 *
 * `casing` decides what the DDL CREATES; the same value, read by
 * `createDatabase()` in `src/db/postgres.ts` via `@oxyhq/db`, decides what
 * queries REFERENCE. Both read `DATABASE_CASING` from the same place so they
 * cannot drift apart.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required by drizzle-kit. Start a local Postgres with:\n' +
    '  docker compose -f ../../docker-compose.postgres.yml up -d postgres\n' +
    'then set DATABASE_URL in packages/backend/.env.'
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  casing: DATABASE_CASING,
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
