# Runbook — Syra's audio moves into Oxy Files (OxyHQ/oxy ADR 0043, stage 4c)

> Internal scopes and service-key setup below are historical. The current source
> migration and deployment prerequisites are in [first-party platform](../architecture/first-party-platform.md).

Syra plays a listener's audio from **Oxy Files**: every track, locker upload,
hosted episode, cached enclosure and room recording becomes a PRIVATE Oxy file,
Oxy renders its audio-only HLS ladder (AAC 64/128/256 kbps), waveform and
30-second preview, and a play is a per-listener, revocable **play session**
(AES-128) whose key Oxy releases only after Syra's file-events endpoint says
the listener is entitled. Everything goes through ONE seam,
`packages/backend/src/services/oxyFiles/audioStorage.ts`.

The bucket keeps each original: it is the input of every process Syra runs on
raw bytes (ingest and re-ingest, fingerprinting, promoting a locker file, a
preview at a listener-chosen offset, a track played into a LiveKit room). The
legacy HLS ladders are retired once Oxy confirms its own.

Nothing runs against production except through
`.github/workflows/run-backend-script.yml`; both scripts preview unless given
`--apply`, and both are safe to re-run.

---

## Who owns what

| Audio | Stored as | Owner | Reference `entity_type` |
|---|---|---|---|
| A catalogue track | private Oxy file, uploaded at ingest | **Syra application** | `track_audio` |
| A locker upload | private Oxy file, stored for the person | **the uploader's account** | `user_upload_audio` |
| A hosted show's episode | private Oxy file | **the show owner's account** (Syra's for an ownerless show) | `episode_audio` |
| A mirrored RSS enclosure (the cache) | imported by Oxy from its URL (≤ 8 GiB) | **Syra application** | `episode_audio` |
| A room recording | written by LiveKit egress into an Oxy recording target | **Syra application** | `recording` |

Each row names its file (`tracks.audio_file_id`, `user_uploads.audio_file_id`,
`episodes.audio_file_id`, `recordings.oxy_file_id`); migration `0036`'s triggers
queue the reference in the same transaction, the outbox and the nightly
reconciliation do the rest (as for images). `oxy_audio_files` holds what Syra
knows of each file: owner, verified SHA-256, whether Oxy's ladder is ready, and
its status from Oxy's file events — a trashed, deleted or taken-down file plays
from NOWHERE, the legacy ladder included.

## How a play works

- `GET /api/stream/:trackId`, `/api/podcasts/episodes/:id/stream` and
  `/api/uploads/:id/stream` open an Oxy play session (`endUserId` = the
  listener, `encryption: 'aes-128'`, `keyAuthorization: 'webhook'`, at least an
  hour and 1.5× the media's length) and answer `{ url, type: 'hls', expiresAt,
  previewUrl, waveformUrl }`. Under a bitrate cap below 256 kbps, `url` is
  Syra's capped master (`/api/stream/oxy/master.m3u8?m=<signed rung list>`).
- Oxy asks `POST /webhooks/oxy/files` (`stream.key_authorization`) before it
  serves the key; `audioKeyAuthorization.ts` answers `{ allow }` with the legacy
  key endpoints' rules — a playable track for a signed-in listener, a locker file
  for its owner, a private show's episode for its owner.
- `/api/podcasts/episodes/:id/audio` (the RSS enclosure) and
  `/api/recordings/:id` redirect to a short-lived URL to the original.
- `/api/preview/:trackId.mp3` (offset 0) redirects to Oxy's preview clip,
  through a session opened for nobody, so its key — and the full track — is
  refused.
- A takedown or a locker purge revokes the file's sessions at once.
- Anything Oxy cannot serve (no 4c, a ladder not rendered yet, an outage) plays
  from the legacy ladder; with no legacy ladder, `409 processing`.

## `OXY_AUDIO`

| Value | New audio | Plays from |
|---|---|---|
| `legacy` (default) | bucket only | bucket only — nothing calls Oxy for audio |
| `dual` | bucket + Oxy, legacy ladder still built | Oxy when its ladder is ready, else legacy |
| `oxy` | Oxy; legacy ladder only if Oxy refused the file | Oxy, else legacy where a ladder remains |

## 0. Before deploying (Oxy side)

1. Oxy's API with ADR 0043 **stage 4c** (OxyHQ/oxy#1774) is deployed, and
   `@oxy.so/core` 4.21.0 / `@oxy.so/services` 11.12.0 / `@oxy.so/contracts`
   4.24.0 are published (pinned in this release).
2. Staff grant the **Syra** application, internal tier, on top of the image
   scopes (`files:app:write`, `files:app:delete`, `files:references:write`,
   `files:user-media:write`, `files:read`): **`files:linked:read`** (play
   sessions on a person's file, the original's download URL). Oxy's seed adds
   it.
3. The file-events endpoint `https://api.syra.fm/webhooks/oxy/files` is
   registered and `OXY_FILES_WEBHOOK_SECRET` set (the image runbook's step 4) —
   play sessions use `keyAuthorization: 'webhook'` and Oxy refuses them
   (`FILES_WEBHOOK_REQUIRED`) without a verified endpoint.

## 1. Deploy

Migrations `0035_oxy_audio` and `0036_oxy_audio_reference_triggers` are both
`pre` (additive). With `OXY_AUDIO` unset the release behaves exactly as before:
safe to deploy before stage 4c is live.

## 2. Turn it on

Set `OXY_AUDIO=dual` in SSM (`/oxy/syra/OXY_AUDIO`) and redeploy. New audio is
stored in Oxy as well; plays move to Oxy as each ladder is ready.

## 3. Backfill (`migrate-audio-to-oxy`)

    bun run migrate:audio-to-oxy                         # preview
    bun run migrate:audio-to-oxy -- --apply --limit 200  # a bounded pass
    bun run migrate:audio-to-oxy -- --apply              # the rest

Every unit reports `copied`, `collected` (a recording target), `missing_object`,
`owner_unknown` (an uploader Oxy no longer knows — the file stays on the legacy
path, it is not Syra's to own) or `failed` (Oxy's status and code). Every copy is
verified against the SHA-256 Oxy answers. Re-run until only `missing_object` and
`owner_unknown` remain.

## 4. Oxy only

Set `OXY_AUDIO=oxy` and redeploy: new audio gets no ladder of Syra's own.

## 5. Retire the legacy ladders (`retire-legacy-audio-ladders`)

    bun run retire:legacy-audio-ladders                  # preview
    bun run retire:legacy-audio-ladders -- --apply       # OXY_AUDIO=oxy only

A ladder is deleted (its playlists and segments, its `track_keys` row, a track's
default preview clip, the row's `hls_master_key` and rendition rows) only once
Oxy confirms its own (`hlsReadyAt`, file `active`); anything else reports
`oxy_not_ready` and stays. `--apply` refuses unless `OXY_AUDIO=oxy`. Originals
stay in the bucket.

## Rolling back

`OXY_AUDIO=legacy` stops every Oxy call at once. Rows whose legacy ladder was
NOT retired play as before; retire ladders only once you will not roll back.
