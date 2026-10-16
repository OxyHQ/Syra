# Runbook — Syra's images move into Oxy Files (OxyHQ/oxy ADR 0043, phase 4)

Every image Syra serves — catalogue artwork, a person's uploaded cover, a house
avatar, a show cover — is stored in **Oxy Files** from this release on. Audio is
not (yet): `packages/backend/src/services/oxyFiles/audioStorage.ts` says exactly
why and what Oxy must add (`TODO(oxy-4c)`).

The steps below are one-time, ordered, and each is safe to re-run. Nothing runs
against production except through `.github/workflows/run-backend-script.yml`,
and every script previews unless given `--apply`.

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
entity type (`referenceReconcile.ts`, `OXY_FILES_RECONCILE`) repairs the rest.
Oxy's file events (`POST /webhooks/oxy/files`) stop serving a deleted, trashed,
private or blocked file at once.

Reads are dual: the Oxy file first (`/api/images/:id` redirects to Oxy's CDN; DTO
variants carry `fileId`/`variant` for clients with Oxy's resolver), the legacy
bucket object only when a row has none — and every such read is counted
(`oxy_files_legacy_reads`, EMF metric `Syra/OxyFiles` · `LegacyImageReads`).

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
   - `OXY_FILES_RECONCILE` = `dry-run` (the default; see step 4).
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

Run it with `--limit 200` first and spot-check the report lines (SHA-256, never
URLs); then without a limit. Re-run until a run reports nothing but
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

## 4. Reconciliation: dry run, then apply

The nightly run starts as a dry run (`oxy_file_reconcile_runs` holds the
counts). When `removed` and `refused` are understood (they should be ~0 after
step 2), set `OXY_FILES_RECONCILE=apply`. This must be `apply` before Oxy's
lifecycle sweep is switched to `enforce`: an application file Syra uses but never
referenced would be trashed 24 hours later.

## 5. The soak — legacy reads to zero

Watch `Syra/OxyFiles · LegacyImageReads` (or `oxy_files_legacy_reads`). It
reaches zero once steps 2–3 are complete and caches have turned over.

## 6. `retire-legacy-image-storage` — preview, then `--apply`

Retires the bucket's image prefixes (`images/`, `agora/houses/`,
`agora/rooms/`, `agora/series/`). The script refuses unless ALL of:

- zero legacy reads on each of the last **14** whole days, with every kind
  counted every day (the counter writes zeros, so silence is told apart from a
  counter that was not running);
- no referenced image still bucket-only;
- no house/room/series image still a bucket URL.

With `--apply` on a passing gate it clears `s3_key` on rows now in Oxy, deletes
the unreferenced bucket-only rows, and deletes the objects under the prefixes.
**Irreversible.** The bucket stays: it holds all audio.

## 7. Afterwards (a follow-up change)

Remove the legacy read path (`resolveImageAsset`'s bucket fallback,
`spaceImageUrl`'s URL branch, `utils/spaces.ts`), the legacy-read counter, and
— in a `post` migration — `image_assets.s3_key` and the houses/rooms/series URL
columns.
