-- oxy:deploy-phase=pre
--
-- Every use Syra makes of an Oxy file reaches Oxy, durably (OxyHQ/oxy ADR 0043).
--
-- Oxy keeps an application-owned file only while the application says it uses
-- it: one nobody references is trashed after 24 hours. So a use is queued in
-- `oxy_file_reference_ops` BY THE DATABASE, in the transaction of the row that
-- starts or stops using a file — no write path can forget it, no crash can lose
-- it. `services/oxyFiles/referenceOutbox.ts` sends the queue to Oxy; the
-- nightly reconciliation (`referenceReconcile.ts`) repairs anything else.
--
-- The tables, columns and entity types below are
-- `services/oxyFiles/referenceRegistry.ts`'s REFERENCE_SOURCES, which also
-- builds the reconciliation inventory; `referenceRegistry.realdb.test.ts`
-- compares the two against `pg_trigger` and the function bodies.
--
-- Additive: functions and triggers only. The previous image writes legacy rows
-- (no `oxy_file_id`), which resolve to no file and queue nothing.

-- Queue the difference between the files an entity used and the files it uses
-- now. One pending row per (file, entity type, entity): the LATEST intent wins
-- and `version` moves, so a drainer holding an older intent never deletes the
-- newer one.
CREATE FUNCTION oxy_queue_file_references(
  p_entity_type text,
  p_entity_id text,
  p_old text[],
  p_new text[]
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text[] := array_remove(coalesce(p_old, '{}'), NULL);
  v_new text[] := array_remove(coalesce(p_new, '{}'), NULL);
BEGIN
  INSERT INTO oxy_file_reference_ops AS o (file_id, entity_type, entity_id, op)
  SELECT f, p_entity_type, p_entity_id, 'add'
  FROM (SELECT DISTINCT unnest(v_new) AS f) added
  WHERE NOT (f = ANY (v_old))
  UNION ALL
  SELECT f, p_entity_type, p_entity_id, 'remove'
  FROM (SELECT DISTINCT unnest(v_old) AS f) removed
  WHERE NOT (f = ANY (v_new))
  ON CONFLICT (file_id, entity_type, entity_id) DO UPDATE
    SET op = excluded.op,
        version = o.version + 1,
        attempts = 0,
        next_attempt_at = now(),
        claimed_until = NULL,
        last_error = NULL,
        dead_at = NULL,
        updated_at = date_trunc('milliseconds', now());
END;
$$;
--> statement-breakpoint

-- The Oxy files a set of `image_assets` ids is stored as.
CREATE FUNCTION oxy_image_asset_file_ids(p_asset_ids text[]) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT oxy_file_id), '{}')
  FROM image_assets
  WHERE id = ANY (p_asset_ids) AND oxy_file_id IS NOT NULL
$$;
--> statement-breakpoint

-- The ids a row names in `p_columns`: each column's text value, and for a JSON
-- array column (artist photo suggestions) every element's `image.url`.
CREATE FUNCTION oxy_row_image_ids(p_row jsonb, p_columns text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(v), '{}')
  FROM (
    SELECT p_row ->> c AS v
    FROM unnest(p_columns) AS c
    WHERE jsonb_typeof(p_row -> c) = 'string'
    UNION ALL
    SELECT e -> 'image' ->> 'url'
    FROM unnest(p_columns) AS c,
      jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_row -> c) = 'array' THEN p_row -> c ELSE '[]'::jsonb END
      ) AS e
  ) ids
  WHERE v IS NOT NULL
$$;
--> statement-breakpoint

-- Row trigger on every table that points at an image.
--   TG_ARGV[0]  the reference's entity type
--   TG_ARGV[1]  'image_assets' (the columns hold image_assets ids) or 'file'
--   TG_ARGV[2…] the columns
CREATE FUNCTION oxy_entity_file_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_columns text[] := TG_ARGV[2:TG_NARGS - 1];
  v_old text[] := '{}';
  v_new text[] := '{}';
  v_entity_id text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old := oxy_row_image_ids(to_jsonb(OLD), v_columns);
    v_entity_id := OLD.id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new := oxy_row_image_ids(to_jsonb(NEW), v_columns);
    v_entity_id := NEW.id;
  END IF;
  IF TG_ARGV[1] = 'image_assets' THEN
    v_old := oxy_image_asset_file_ids(v_old);
    v_new := oxy_image_asset_file_ids(v_new);
  END IF;
  IF cardinality(v_old) > 0 OR cardinality(v_new) > 0 THEN
    PERFORM oxy_queue_file_references(TG_ARGV[0], v_entity_id, v_old, v_new);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Every entity whose image columns name one of `p_asset_ids`, with all the
-- image_assets ids it names — for the repoint trigger below.
CREATE FUNCTION oxy_image_asset_users(p_asset_ids text[])
RETURNS TABLE (entity_type text, entity_id text, asset_ids text[])
LANGUAGE sql STABLE AS $$
  SELECT 'catalog_entity'::text, e.id, ARRAY[e.image_id, e.image_sizes_small_id, e.image_sizes_medium_id, e.image_sizes_large_id, e.image_sizes_xlarge_id, e.image_sizes_xxlarge_id, e.image_sizes_original_id] || ARRAY(SELECT s -> 'image' ->> 'url' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.image_suggestions) = 'array' THEN e.image_suggestions ELSE '[]'::jsonb END) AS s)
  FROM catalog_entities e
  WHERE e.image_id = ANY (p_asset_ids) OR e.image_sizes_small_id = ANY (p_asset_ids) OR e.image_sizes_medium_id = ANY (p_asset_ids) OR e.image_sizes_large_id = ANY (p_asset_ids) OR e.image_sizes_xlarge_id = ANY (p_asset_ids) OR e.image_sizes_xxlarge_id = ANY (p_asset_ids) OR e.image_sizes_original_id = ANY (p_asset_ids) OR EXISTS (SELECT 1 FROM unnest(p_asset_ids) AS a WHERE e.image_suggestions @> jsonb_build_array(jsonb_build_object('image', jsonb_build_object('url', a))))
  UNION ALL
  SELECT 'album'::text, e.id, ARRAY[e.cover_art_id, e.cover_art_sizes_small_id, e.cover_art_sizes_medium_id, e.cover_art_sizes_large_id, e.cover_art_sizes_xlarge_id, e.cover_art_sizes_xxlarge_id, e.cover_art_sizes_original_id]
  FROM albums e
  WHERE e.cover_art_id = ANY (p_asset_ids) OR e.cover_art_sizes_small_id = ANY (p_asset_ids) OR e.cover_art_sizes_medium_id = ANY (p_asset_ids) OR e.cover_art_sizes_large_id = ANY (p_asset_ids) OR e.cover_art_sizes_xlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_xxlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_original_id = ANY (p_asset_ids)
  UNION ALL
  SELECT 'track'::text, e.id, ARRAY[e.cover_art_id, e.cover_art_sizes_small_id, e.cover_art_sizes_medium_id, e.cover_art_sizes_large_id, e.cover_art_sizes_xlarge_id, e.cover_art_sizes_xxlarge_id, e.cover_art_sizes_original_id]
  FROM tracks e
  WHERE e.cover_art_id = ANY (p_asset_ids) OR e.cover_art_sizes_small_id = ANY (p_asset_ids) OR e.cover_art_sizes_medium_id = ANY (p_asset_ids) OR e.cover_art_sizes_large_id = ANY (p_asset_ids) OR e.cover_art_sizes_xlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_xxlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_original_id = ANY (p_asset_ids)
  UNION ALL
  SELECT 'user_upload'::text, e.id, ARRAY[e.cover_art_id, e.cover_art_sizes_small_id, e.cover_art_sizes_medium_id, e.cover_art_sizes_large_id, e.cover_art_sizes_xlarge_id, e.cover_art_sizes_xxlarge_id, e.cover_art_sizes_original_id]
  FROM user_uploads e
  WHERE e.cover_art_id = ANY (p_asset_ids) OR e.cover_art_sizes_small_id = ANY (p_asset_ids) OR e.cover_art_sizes_medium_id = ANY (p_asset_ids) OR e.cover_art_sizes_large_id = ANY (p_asset_ids) OR e.cover_art_sizes_xlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_xxlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_original_id = ANY (p_asset_ids)
  UNION ALL
  SELECT 'playlist'::text, e.id, ARRAY[e.cover_art_id, e.cover_art_sizes_small_id, e.cover_art_sizes_medium_id, e.cover_art_sizes_large_id, e.cover_art_sizes_xlarge_id, e.cover_art_sizes_xxlarge_id, e.cover_art_sizes_original_id]
  FROM playlists e
  WHERE e.cover_art_id = ANY (p_asset_ids) OR e.cover_art_sizes_small_id = ANY (p_asset_ids) OR e.cover_art_sizes_medium_id = ANY (p_asset_ids) OR e.cover_art_sizes_large_id = ANY (p_asset_ids) OR e.cover_art_sizes_xlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_xxlarge_id = ANY (p_asset_ids) OR e.cover_art_sizes_original_id = ANY (p_asset_ids)
  UNION ALL
  SELECT 'podcast'::text, e.id, ARRAY[e.image_id, e.image_sizes_small_id, e.image_sizes_medium_id, e.image_sizes_large_id, e.image_sizes_xlarge_id, e.image_sizes_xxlarge_id, e.image_sizes_original_id]
  FROM podcasts e
  WHERE e.image_id = ANY (p_asset_ids) OR e.image_sizes_small_id = ANY (p_asset_ids) OR e.image_sizes_medium_id = ANY (p_asset_ids) OR e.image_sizes_large_id = ANY (p_asset_ids) OR e.image_sizes_xlarge_id = ANY (p_asset_ids) OR e.image_sizes_xxlarge_id = ANY (p_asset_ids) OR e.image_sizes_original_id = ANY (p_asset_ids)
  UNION ALL
  SELECT 'episode'::text, e.id, ARRAY[e.image_id, e.image_sizes_small_id, e.image_sizes_medium_id, e.image_sizes_large_id, e.image_sizes_xlarge_id, e.image_sizes_xxlarge_id, e.image_sizes_original_id]
  FROM episodes e
  WHERE e.image_id = ANY (p_asset_ids) OR e.image_sizes_small_id = ANY (p_asset_ids) OR e.image_sizes_medium_id = ANY (p_asset_ids) OR e.image_sizes_large_id = ANY (p_asset_ids) OR e.image_sizes_xlarge_id = ANY (p_asset_ids) OR e.image_sizes_xxlarge_id = ANY (p_asset_ids) OR e.image_sizes_original_id = ANY (p_asset_ids)
$$;
--> statement-breakpoint

-- An image_assets row now stored as a different Oxy file (the migration copying
-- a legacy image into Oxy, or a repair): every entity naming it starts using the
-- new file, and stops using the old one unless another of its images is still
-- stored as it. Statement-level, so a whole migration batch is one pass.
CREATE FUNCTION oxy_image_asset_repointed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_changed_ids text[];
  v_now text[];
BEGIN
  SELECT array_agg(n.id) INTO v_changed_ids
  FROM oxy_new_rows n
  JOIN oxy_old_rows o ON o.id = n.id
  WHERE o.oxy_file_id IS DISTINCT FROM n.oxy_file_id;

  IF v_changed_ids IS NULL THEN
    RETURN NULL;
  END IF;

  FOR r IN SELECT * FROM oxy_image_asset_users(v_changed_ids) LOOP
    v_now := oxy_image_asset_file_ids(r.asset_ids);
    PERFORM oxy_queue_file_references(
      r.entity_type,
      r.entity_id,
      ARRAY(
        SELECT DISTINCT o.oxy_file_id
        FROM oxy_old_rows o
        WHERE o.id = ANY (r.asset_ids) AND o.id = ANY (v_changed_ids)
          AND o.oxy_file_id IS NOT NULL AND NOT (o.oxy_file_id = ANY (v_now))
      ),
      ARRAY(
        SELECT DISTINCT n.oxy_file_id
        FROM oxy_new_rows n
        WHERE n.id = ANY (r.asset_ids) AND n.id = ANY (v_changed_ids)
          AND n.oxy_file_id IS NOT NULL
      )
    );
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oxy_image_asset_repointed
AFTER UPDATE ON image_assets
REFERENCING OLD TABLE AS oxy_old_rows NEW TABLE AS oxy_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION oxy_image_asset_repointed();
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF image_id, image_sizes_small_id, image_sizes_medium_id, image_sizes_large_id, image_sizes_xlarge_id, image_sizes_xxlarge_id, image_sizes_original_id, image_suggestions ON catalog_entities
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('catalog_entity', 'image_assets', 'image_id', 'image_sizes_small_id', 'image_sizes_medium_id', 'image_sizes_large_id', 'image_sizes_xlarge_id', 'image_sizes_xxlarge_id', 'image_sizes_original_id', 'image_suggestions');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF cover_art_id, cover_art_sizes_small_id, cover_art_sizes_medium_id, cover_art_sizes_large_id, cover_art_sizes_xlarge_id, cover_art_sizes_xxlarge_id, cover_art_sizes_original_id ON albums
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('album', 'image_assets', 'cover_art_id', 'cover_art_sizes_small_id', 'cover_art_sizes_medium_id', 'cover_art_sizes_large_id', 'cover_art_sizes_xlarge_id', 'cover_art_sizes_xxlarge_id', 'cover_art_sizes_original_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF cover_art_id, cover_art_sizes_small_id, cover_art_sizes_medium_id, cover_art_sizes_large_id, cover_art_sizes_xlarge_id, cover_art_sizes_xxlarge_id, cover_art_sizes_original_id ON tracks
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('track', 'image_assets', 'cover_art_id', 'cover_art_sizes_small_id', 'cover_art_sizes_medium_id', 'cover_art_sizes_large_id', 'cover_art_sizes_xlarge_id', 'cover_art_sizes_xxlarge_id', 'cover_art_sizes_original_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF cover_art_id, cover_art_sizes_small_id, cover_art_sizes_medium_id, cover_art_sizes_large_id, cover_art_sizes_xlarge_id, cover_art_sizes_xxlarge_id, cover_art_sizes_original_id ON user_uploads
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('user_upload', 'image_assets', 'cover_art_id', 'cover_art_sizes_small_id', 'cover_art_sizes_medium_id', 'cover_art_sizes_large_id', 'cover_art_sizes_xlarge_id', 'cover_art_sizes_xxlarge_id', 'cover_art_sizes_original_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF cover_art_id, cover_art_sizes_small_id, cover_art_sizes_medium_id, cover_art_sizes_large_id, cover_art_sizes_xlarge_id, cover_art_sizes_xxlarge_id, cover_art_sizes_original_id ON playlists
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('playlist', 'image_assets', 'cover_art_id', 'cover_art_sizes_small_id', 'cover_art_sizes_medium_id', 'cover_art_sizes_large_id', 'cover_art_sizes_xlarge_id', 'cover_art_sizes_xxlarge_id', 'cover_art_sizes_original_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF image_id, image_sizes_small_id, image_sizes_medium_id, image_sizes_large_id, image_sizes_xlarge_id, image_sizes_xxlarge_id, image_sizes_original_id ON podcasts
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('podcast', 'image_assets', 'image_id', 'image_sizes_small_id', 'image_sizes_medium_id', 'image_sizes_large_id', 'image_sizes_xlarge_id', 'image_sizes_xxlarge_id', 'image_sizes_original_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF image_id, image_sizes_small_id, image_sizes_medium_id, image_sizes_large_id, image_sizes_xlarge_id, image_sizes_xxlarge_id, image_sizes_original_id ON episodes
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('episode', 'image_assets', 'image_id', 'image_sizes_small_id', 'image_sizes_medium_id', 'image_sizes_large_id', 'image_sizes_xlarge_id', 'image_sizes_xxlarge_id', 'image_sizes_original_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF avatar_file_id, cover_image_file_id ON houses
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('house', 'file', 'avatar_file_id', 'cover_image_file_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF stream_image_file_id ON rooms
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('room', 'file', 'stream_image_file_id');
--> statement-breakpoint
CREATE TRIGGER oxy_file_references
AFTER INSERT OR DELETE OR UPDATE OF cover_image_file_id ON series
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('series', 'file', 'cover_image_file_id');
