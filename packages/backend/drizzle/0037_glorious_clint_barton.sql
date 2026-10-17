-- oxy:deploy-phase=pre
--
-- The bucket key a track's original was written to, recorded at upload
-- (`tracks.audio_source_key`). Additive and nullable: a row from before it
-- existed keeps deriving its key until scripts/backfillTrackAudioKeys.ts fills it.
ALTER TABLE "tracks" ADD COLUMN "audio_source_key" text;
