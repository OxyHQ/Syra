-- oxy:deploy-phase=pre
--
-- Every AUDIO file Syra uses reaches Oxy as a reference, durably (OxyHQ/oxy
-- ADR 0043 stage 4c) — the triggers of `0034` over the four columns `0035`
-- added. One trigger per table, named `oxy_audio_file_references` beside the
-- image trigger `oxy_file_references` the first three tables already have,
-- with an entity type of its own so the nightly reconciliation of a row's
-- audio never mixes with its images.
--
-- The tables, columns and entity types are `REFERENCE_SOURCES` in
-- `services/oxyFiles/referenceRegistry.ts`; `referenceRegistry.test.ts`
-- compares the two against `pg_trigger`. Additive: triggers only, reusing
-- `oxy_entity_file_references()` from `0034` (the columns hold Oxy file ids,
-- `via = 'file'`).
CREATE TRIGGER oxy_audio_file_references
AFTER INSERT OR DELETE OR UPDATE OF audio_file_id ON tracks
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('track_audio', 'file', 'audio_file_id');
--> statement-breakpoint
CREATE TRIGGER oxy_audio_file_references
AFTER INSERT OR DELETE OR UPDATE OF audio_file_id ON user_uploads
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('user_upload_audio', 'file', 'audio_file_id');
--> statement-breakpoint
CREATE TRIGGER oxy_audio_file_references
AFTER INSERT OR DELETE OR UPDATE OF audio_file_id ON episodes
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('episode_audio', 'file', 'audio_file_id');
--> statement-breakpoint
CREATE TRIGGER oxy_audio_file_references
AFTER INSERT OR DELETE OR UPDATE OF oxy_file_id ON recordings
FOR EACH ROW EXECUTE FUNCTION oxy_entity_file_references('recording', 'file', 'oxy_file_id');
