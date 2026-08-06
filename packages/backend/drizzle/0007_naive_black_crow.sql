-- oxy:deploy-phase=pre
-- Purely additive: a new NOT NULL column carrying a DEFAULT ('music', so an
-- old-image insert that doesn't know about `kind` still succeeds), plus a
-- unique constraint that can never fail against existing data (`id` alone is
-- already unique, so `(id, kind)` trivially is too). Nothing dropped,
-- renamed or narrowed. Task 4 review, I7 (genres.ts's own doc comment has
-- the full reasoning) — this is stage 1 of 2; stage 2 (0008) adds the
-- composite FKs that actually enforce kind-matching, which IS narrowing.
ALTER TABLE "genres" ADD COLUMN "kind" text DEFAULT 'music' NOT NULL;--> statement-breakpoint
ALTER TABLE "genres" ADD CONSTRAINT "genres_id_kind_key" UNIQUE("id","kind");--> statement-breakpoint
ALTER TABLE "genres" ADD CONSTRAINT "genres_kind_check" CHECK ("genres"."kind" in ('music', 'podcast'));