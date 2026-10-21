# Runbook — Syra's images move into Oxy Files (OxyHQ/oxy ADR 0043, phase 4)

Every image Syra serves — catalogue artwork, a person's uploaded cover, a house
avatar, a show cover — is stored in **Oxy Files** from this release on. Audio
has its own procedure: `docs/runbooks/oxy-files-audio.md`.

> **Status: COMPLETE (2026-10-21).** Every image is an Oxy file, the bucket's
> image prefixes are deleted, and the legacy read path, its counter, the
> one-time scripts of steps 2, 3 and 6 and the `s3_key` / house and series URL
> columns are gone (step 7). Steps 0–6 are kept as the record of what ran; the
> scripts they name no longer exist.

The steps below were one-time and ordered. Nothing ran against production
except through `.github/workflows/run-backend-script.yml`, and every script
previewed unless given `--apply`.

---

## Who owns what

| Image | Stored as | Owner | Syra's reference (`entity_type`) |
|---|---|---|---|
| Catalogue artwork Syra mirrors (MusicBrainz/Commons, podcast RSS show and episode art) | ONE Oxy file per image; its six sizes are `image_assets` rows naming an Oxy rendition each | **Syra application** (unbilled, garbage-collected when unused) | `catalog_entity`, `album`, `track`, `podcast`, `episode` |
| A person's upload (`POST /api/images/upload`: playlist/show/track covers; embedded cover art from a locker upload; an artist photo suggestion from their file) | one Oxy file | **the uploader's account** | `playlist`, `podcast`, `track`, `user_upload`, `catalog_entity` (suggestions) |
| A house avatar/cover, a room's stream image, a series cover | one Oxy file | **the space's owner** (house creator, room host, series creator) | `house`, `room`, `series` |
| An Alia-generated show's cover | Alia's Oxy file — Syra never copies it | **Alia application** | `podcast` |
| An upload whose uploader no longer has an Oxy account (migration only) | one Oxy file | Syra application (reported `ownerFallback`) | as above |

Every use is registered with Oxy: database triggers (migration `0034`) queue
`add`/`remove` in `oxy_file_reference_ops` in the transaction of the write; every
API task drains the queue (`referenceOutbox.ts`); a nightly reconciliation per
entity type (`referenceReconcile.ts`, always applied) repairs the rest.
Oxy's file events (`POST /webhooks/oxy/files`) stop serving a deleted, trashed,
private or blocked file at once.

Reads: `/api/images/:id` redirects to the row's Oxy file on Oxy's CDN; DTO
variants carry `fileId`/`variant` for clients with Oxy's resolver. Every
`image_assets` row names its file (`oxy_file_id` is NOT NULL); there is no other
store. (While the images migrated, a row with no file was streamed from the
bucket and counted in `oxy_files_legacy_reads`; both went in step 7.)

---

## 0. Before deploying (Oxy side)

1. Oxy's API with ADR 0043 stages 1–4b is deployed (it is, in production), and
   `@oxy.so/core` 4.18.0 / `@oxy.so/contracts` 4.22.0 / `@oxy.so/services`
   11.9.0 are published (pinned in this PR). Stage 4c (private person media,
   audio, play sessions, recording targets) is NOT required: Syra calls no 4c
   endpoint, and audio stays on the bucket behind `audioStorage.ts`.
2. Staff grant the **Syra** application, **internal tier**: `files:app:write`,
   `files:app:delete`, `files:references:write`, `files:user-media:write`,
   `files:read`. (`metadataByIds` names a file's owner only to an internal-tier
   token; the cover hand-over and `imageFileId` depend on it.)
3. Set in SSM (`/oxy/syra/*`):
   - `SYRA_COVER_APPLICATION_IDS` = Alia's Oxy application id.
4. Register the file-events endpoint `https://api.syra.fm/webhooks/oxy/files`
   (console → Webhooks → File events, or `oxy.apps.setFilesWebhook`). The
   endpoint answers Oxy's challenge before it has a secret; store the secret the
   console shows ONCE as `OXY_FILES_WEBHOOK_SECRET`, then redeploy. Until then
   the route is absent (404) to everything but the challenge.

## 1. Deploy

Migrations `0033_oxy_files` and `0034_oxy_file_reference_triggers` are both
`pre` (additive). New images go to Oxy Files from the first request; nothing new
is written to the bucket's image prefixes.

## 2. `migrate-images-to-oxy` — preview, then `--apply`

Copies every REFERENCED legacy image into Oxy (a set's original once; a person's
upload into their account; space images into the space owner's), hash-verified
before and after, and repoints its rows — which queues Syra's references. Skips
and reports `unreferenced` (garbage, deleted at step 6) and `alia_handover`
(step 3). Marks `missing_object` rows so nothing serves them again.

A catalogue set is IMPORTED: Oxy fetches its original from
`STREAM_KEY_BASE_URL/api/images/:id`, which streams the bucket object while the
row names no file, 50 sets to one `importAppFiles` call. Oxy meters uploads and
imports together, 30 calls a minute per application, and Syra's live catalogue
imports draw on the same budget. The script therefore makes at most 20 calls a
minute (`writePacer.ts`), and when it gets a 429 it waits as long as Oxy says
and repeats the same call. About 83 000 sets take hours this way. Uploaded
one at a time, they would take days.

Run it with `--limit 200` first and spot-check the report lines (SHA-256, never
URLs); then in bounded passes (`--limit 20000`). The workflow stops waiting
after an hour, but the task keeps running. Its log stream
`/oxy/ecs` › `syra/syra/<task>` carries the final counts. Re-run until a run reports nothing but
`unreferenced`/`alia_handover`. Exit code 1 means a `failed` or `hash_mismatch`
unit — read its line; a re-run retries it.

## 3. Alia's covers go back to Alia

1. **Alia** runs its show-cover migration (`--apply`): it copies each cover's
   exact bytes from `GET /api/images/:id` into an Alia-owned Oxy file.
2. **Then** `migrate-alia-covers --apply` here: for every Alia show still on a
   legacy cover, Syra hashes its own copy, finds the file Oxy holds with that
   SHA-256, and repoints the show ONLY if Oxy says the file's owner is in
   `SYRA_COVER_APPLICATION_IDS`. `awaiting_alia` means step 3.1 has not reached
   that show yet: run again afterwards.

## 4. Reconciliation

The nightly run always applies (`oxy_file_reconcile_runs` holds the counts).
For the counts without changing anything, run `reconcile-oxy-file-references`
(a preview: every entity type's counts in the task's log, nothing recorded);
`removed` and `refused` should be ~0 after step 2. Not to wait for the night,
run `reconcile-oxy-file-references --apply`. It must have applied once before
Oxy's lifecycle sweep is switched to `enforce`: an application file Syra uses
but never referenced would be trashed 24 hours later. Production's first preview
(2026-10-20) found 167,421 references in place and nothing to add, remove or
refuse.

## 5. The soak — legacy reads to zero

Watch `Syra/OxyFiles · LegacyImageReads` (or `oxy_files_legacy_reads`). It
reaches zero once steps 2–3 are complete and caches have turned over.

## 6. `retire-legacy-image-storage` — preview, then `--apply`

Retires the bucket's image prefixes (`images/`, `agora/houses/`,
`agora/rooms/`, `agora/series/`). The script refuses unless ALL of:

- zero legacy reads on each of the last **14** whole days, with every kind
  counted every day (the counter writes zeros, so silence is told apart from a
  counter that was not running);
  (the owner shortened it to the three zero days 2026-10-18..20 for the run on
  2026-10-21 — `SOAK_WAIVER`, void outside 2026-10-21..24 — after the only reads
  since the move proved to be the migration's own imports on 2026-10-17);
- no referenced image still bucket-only;
- no house/room/series image still a bucket URL.

With `--apply` on a passing gate it clears `s3_key` on rows now in Oxy, deletes
the unreferenced bucket-only rows, and deletes the objects under the prefixes.
**Irreversible.** The bucket stays: it holds all audio.

## 7. Afterwards — DONE (2026-10-21)

Removed once production showed no row left to serve from the bucket (0 of
505,085 `image_assets` rows with an `s3_key` or without an `oxy_file_id`, none
`missing`; no house or series URL image):

- the legacy read path: `resolveImageAsset`'s bucket stream, `spaceImageUrl`'s
  URL branch, `utils/spaces.ts`, and the S3 layer's image-prefix read routing;
- the legacy-read counter (`legacyReads.ts`) and its table;
- the one-time scripts `migrate-images-to-oxy`, `migrate-alia-covers` and
  `retire-legacy-image-storage` (with its dated soak waiver), their helpers
  (`legacyObjects.ts`, `writePacer.ts`), and `restoreUploadedTracks.ts`, whose
  export named bucket image keys;
- in migration `0038_retire_legacy_image_storage` (`post`):
  `image_assets.s3_key` (and `oxy_file_id` made NOT NULL), the `missing`
  serving status, `houses.avatar`, `houses.cover_image`, `series.cover_image` and
  `oxy_files_legacy_reads`.

A house or series image is set only by its upload route now; a create or PATCH
that names a URL is refused, and `null` removes the image. `rooms.stream_image`
stays — it is a stream's own thumbnail link, never Syra's storage.
