/**
 * Postgres extensions this schema requires.
 *
 * The registry is DATA, with a reason per entry — the same shape as
 * `schema/deferredForeignKeys.ts` and `schema/protectedColumns.ts`, for the
 * same reason: a rule a reader can enumerate beats a rule spread across the
 * files that happen to need it. The registry stays here because it would name
 * THIS schema's own tables; the mechanism that ensures it (`ensureExtensions`,
 * `RequiredExtension`) lives in `@oxyhq/db/migrate` — see that module's doc
 * comment for why an extension has to exist before the first migration that
 * names a type it provides, and why `IF NOT EXISTS` is the right spelling on
 * a managed database.
 *
 * ## Deliberately empty — and why that is not "not yet decided"
 *
 * Syra has no `2dsphere` index and no geospatial query to replace, so it has
 * no PostGIS dependency the way Mention's `posts.geo`/`content_geo` do. An
 * empty list is not a placeholder pending a future task: it means the
 * migrator (`@oxyhq/db/migrate`'s `ensureExtensions`) opens NO connection at
 * all before applying migrations, which matters on a first run against a
 * database that may not exist yet. Adding an extension here that nothing in
 * the schema needs would buy nothing and cost an install-ordering dependency
 * in every environment — dev, CI, RDS — for free.
 *
 * Use `postgres:17` everywhere for local and CI Postgres, never the PostGIS
 * image: pinning a heavier image would imply an extension dependency this
 * schema does not have.
 */

import type { RequiredExtension } from '@oxyhq/db/migrate';

/**
 * Every extension the schema depends on. An entry here is a claim that some
 * column, index or constraint does not exist without it — not a convenience.
 */
export const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [];
