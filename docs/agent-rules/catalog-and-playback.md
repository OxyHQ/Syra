# Catalog and playback rules

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

Syra is an own-catalogue platform: every track is Syra-hosted, so a track is playable iff it is available and not copyright-removed — no provider dimension, no deployment flag, no per-user variation. The single predicate lives in `playableTrackFilter()` (`packages/backend/src/db/catalog/visibility.ts`); every catalog/playback read goes through it rather than reimplementing the check.

**Music enters through exactly one path: creator upload.** The upload endpoint in `tracks.controller` builds the `Track` directly and calls `enqueueIngest` to start HLS transcoding (`status: processing → ready | failed`). There is no external ingest — no connector layer, no import service, no provider reconciliation, and no dormant pipeline to revive. Adding an external source means building one from scratch; do not assume a hook exists. (Podcasts are a separate vertical and DO mirror external RSS — see the podcast import services.)

- Track-bearing containers (albums, artists, playlists, genre cards, search/browse) must be filtered by the same playable-track predicate. Do not show a container as playable if opening it returns zero playable tracks. An album also carries its own `isAvailable`, so a creator can unpublish the container while its tracks stay individually discoverable.
- The catalog authority and the playback authority must agree. `playableTrackFilter` gates listing; `isTrackPlayable` (`stream.controller`) gates playback. Any field that hides a track from one MUST hide it from the other, or takedowns stay listed and searchable and then fail at play. `isPlayableTrack` is the in-memory twin of the SQL predicate — change them together.
- Catalog reads that vary by identity must use the linked Oxy client (`packages/frontend/utils/api.ts`), not `publicApi`.
- Identity-sensitive catalog queries must wait until `useOxy().isPrivateApiPending` is false and must separate React Query cache keys for `guest` vs `auth`. Never let a guest cold-boot response populate the authenticated cache.
- The player resolves playback through `GET /stream/:trackId`; the backend is the sole entitlement authority.
- Catalog filters compose with drizzle's `and()` — `and(playableTrackFilter(), …)`. Never merge filters by spreading objects: `and()` takes conditions as arguments, so it cannot lose a term the way spreading two filter objects silently drops an earlier `or`. A pool or query that passes an `or(...)` keeps it (`services/radio/radioPools.ts`).
- Playlist readability DOES vary per viewer, unlike track playability: `canViewPlaylist()` (`db/catalog/visibility.ts`) is the single predicate — public to anyone, otherwise owner or collaborator only. Every surface that exposes a playlist asks it, so the rule cannot change in one place and miss another.
