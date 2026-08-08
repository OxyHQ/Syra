-- oxy:deploy-phase=post
-- NARROWING: a NOT NULL column with NO server-side default, plus a UNIQUE over
-- it. An image that does not know about `position` fails every insert into
-- `podcast_categories` once this runs, so it is only safe with the new image
-- live — the inverse of 0020, which added NOT NULL columns WITH defaults and is
-- correctly marked `pre` for exactly that reason.
--
-- WHY NOT A DEFAULT, WHICH WOULD MAKE IT ADDITIVE. `DEFAULT 0` looks like the
-- cheap way to earn a `pre` marker and is wrong twice over. It would file every
-- pre-existing row as the show's PRIMARY category, which is a claim about the
-- feed rather than an absence of one — and it would immediately violate
-- `podcast_categories_podcast_id_position_key` for any show carrying two or
-- more categories, so the migration would fail on precisely the rows that
-- matter. The six sibling child tables in this vertical all declare `position`
-- NOT NULL with no default for the same reason.
--
-- This runs inside the genesis window (see `LAST_GENESIS_MIGRATION_TAG` in
-- `src/db/migrate.ts`), so the table is empty everywhere it is applied and the
-- absent default costs nothing today. The marker still states what the
-- statement WOULD do to a live predecessor, because that is what it is for.
--
-- WHAT IT IS FOR. `Podcast.categories` was an ORDERED `string[]`, and RSS
-- declares a show's primary category first — so index 0 carries meaning. The
-- junction shipped without `position` while all six of this vertical's other
-- array-turned-child tables carry one, which dropped that ordering at import
-- with no way to recover it from the table afterwards. Task 12 closes the gap.
ALTER TABLE "podcast_categories" ADD COLUMN "position" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "podcast_categories" ADD CONSTRAINT "podcast_categories_podcast_id_position_key" UNIQUE("podcast_id","position");--> statement-breakpoint
ALTER TABLE "podcast_categories" ADD CONSTRAINT "podcast_categories_position_check" CHECK ("podcast_categories"."position" >= 0);
