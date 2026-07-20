# Syra

## Monorepo Structure

| Package | Path | Role |
|---------|------|------|
| `@syra/frontend` | `packages/frontend/` | Expo app — syra.fm |
| `@syra/backend` | `packages/backend/` | Express API |
| `@syra/studio` | `packages/studio/` | Creator studio portal |
| `@syra.fm/sdk` | `packages/sdk/` | Public SDK |
| `@syra/shared-types` | `packages/shared-types/` | Shared TypeScript DTOs |

## AWS Deployment

- **Port**: `3000` | **Domain**: `api.syra.fm`
- **Deploy**: `.github/workflows/deploy-aws.yml` → `linux/arm64` Docker → ECR `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/syra` → `ecs update-service --force-new-deployment`
- **Secrets**: GitHub Actions secrets → SSM `/oxy/syra/*`.

## Domains

Production: web `https://syra.fm`, API/WebSocket `https://api.syra.fm` / `wss://api.syra.fm`. Do not restore retired Syra oxy.so hosts in runtime config, CORS, EAS env, universal links, or deployment scripts.

## Oxy Integration

- Gate private API calls (library, playlists, artist profile, privacy, preferences, recommendations) with `useAuth().canUsePrivateApi` / `isPrivateApiPending` — not app-local token helpers.
- `packages/frontend/utils/api.ts` owns the linked authenticated Syra API client via `oxyServices.createLinkedClient(...)`. Components/hooks must not hand-roll auth headers, refresh, CSRF probing, or session invalidation.

## Frontend State Architecture

- **TanStack Query** for server state: catalog reads, library, playlists, artist profile, preferences, recommendations, privacy.
- **Zod** at API boundaries: parse once in the service layer, return typed data, fail loudly through the existing error path.
- **Zustand** only for local-only state: player state, queue UI state, session-independent UI preferences, transient interaction state. Do NOT mirror liked tracks, playlists, or profile data in Zustand when TanStack Query already owns that remote state.
- Mutations must invalidate relevant TanStack Query keys immediately — like/unlike must update the button, library lists, album/track screens, and player state without reload.
- Queue/playback Zustand state may optimistically update but must persist through `queueService` and repair backend drift by replacing the queue, not hiding 400 errors with local-only state.

## Catalog — Implementation Rules

Syra is an own-catalogue platform: every track is Syra-hosted, so a track is playable iff it is available and not copyright-removed — no provider dimension, no deployment flag, no per-user variation. The single predicate lives in `playableTrackFilter()` (`packages/backend/src/utils/catalogVisibility.ts`); every catalog/playback read goes through it rather than reimplementing the check.

**Music enters through exactly one path: creator upload.** The upload endpoint in `tracks.controller` builds the `Track` directly and calls `enqueueIngest` to start HLS transcoding (`status: processing → ready | failed`). There is no external ingest — no connector layer, no import service, no provider reconciliation, and no dormant pipeline to revive. Adding an external source means building one from scratch; do not assume a hook exists. (Podcasts are a separate vertical and DO mirror external RSS — see the podcast import services.)

- Track-bearing containers (albums, artists, playlists, genre cards, search/browse) must be filtered by the same playable-track predicate. Do not show a container as playable if opening it returns zero playable tracks. An album also carries its own `isAvailable`, so a creator can unpublish the container while its tracks stay individually discoverable.
- The catalog authority and the playback authority must agree. `playableTrackFilter` gates listing; `isTrackPlayable` (`stream.controller`) gates playback. Any field that hides a track from one MUST hide it from the other, or takedowns stay listed and searchable and then fail at play. `isPlayableTrack` is the in-memory twin of the Mongo filter — change them together.
- Catalog reads that vary by identity must use the linked Oxy client (`packages/frontend/utils/api.ts`), not `publicApi`.
- Identity-sensitive catalog queries must wait until `useOxy().isPrivateApiPending` is false and must separate React Query cache keys for `guest` vs `auth`. Never let a guest cold-boot response populate the authenticated cache.
- The player resolves playback through `GET /stream/:trackId`; the backend is the sole entitlement authority.
- Catalog filters must compose conditions with `$and` (`andMongoFilters` in `recommendationService.ts`, or the equivalent helper in `catalogVisibility.ts`), not by spreading filter objects in a way that clobbers an existing `$or`.

### `$lookup` correlation — convert on the LOCAL side

When a `$lookup` sub-pipeline correlates fields of different BSON types (typically a string id on one side, an `ObjectId` on the other), convert the LOCAL value in `let` and leave the foreign field a bare path:

```js
// CORRECT — stays an indexable _id point lookup
let: { trackId: { $convert: { input: '$trackId', to: 'objectId', onError: null, onNull: null } } },
pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$trackId'] } } }]

// WRONG — no index can serve a computed foreign field; every lookup degrades to a collection scan
let: { trackId: '$trackId' },
pipeline: [{ $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$trackId'] } } }]
```

`let` is evaluated once per outer document, so the converted value is a constant the planner can use; a conversion applied to the foreign field cannot be indexed. Use `$convert` with `onError`/`onNull` rather than `$toObjectId`, so a malformed id yields `null` and matches nothing instead of throwing.

This matters most in `utils/playableContainers.ts`, whose pipelines run the `$lookup` BEFORE `$sort`/`$limit` — every container in the collection is evaluated on every request, so per-lookup cost must stay O(1). Prefer bare indexed fields in the leading `$match` over any computed comparison.
