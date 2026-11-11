# Images and audio in Oxy Files

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

- Every image is an Oxy file (ADR 0043): catalogue art is Syra-owned, a person's upload theirs, new shared space artwork Syra's. `image_assets` rows name the file (`oxy_file_id`, NOT NULL); the bucket holds no images. Uses reach Oxy through DB triggers + outbox, never by hand. `docs/runbooks/oxy-files-images.md`.
- Audio (stage 4c) goes ONLY through `services/oxyFiles/audioStorage.ts` (`audioStorage.boundary.test.ts`): private Oxy files, played via per-listener play sessions whose key our file-events endpoint authorizes (`audioKeyAuthorization.ts`). `OXY_AUDIO` legacy|dual|oxy; every Oxy refusal falls back to the bucket. `docs/runbooks/oxy-files-audio.md`.
- No audio body goes to `api.syra.fm` (proxy limit 100 MB): clients get a presigned PUT (`POST /api/audio-uploads`), then complete by `uploadId` — `services/uploads/directAudioUpload.ts`.
