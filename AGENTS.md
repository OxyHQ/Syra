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

## Audius Catalog — Implementation Rules

High-level Audius policy (`AUDIUS_CATALOG_ENABLED`, `directAudiusStreaming`, ingest model) is in `~/Oxy/AGENTS.md`. Syra-specific implementation rules:

- Tracks with Syra HLS (`status: ready`, `hlsMasterKey`, `hls[]`) must be visible and playable even when `directAudiusStreaming` is false.
- Track-bearing containers (albums, artists, playlists, genre cards, search/browse) must be filtered by the same playable-track policy for the current user. Do not show a container as playable if opening it returns zero playable tracks under that policy.
- Catalog reads that vary by identity or playback preference must use the linked Oxy client (`packages/frontend/utils/api.ts`), not `publicApi`.
- Identity-sensitive catalog queries must wait until `useOxy().isPrivateApiPending` is false and must separate React Query cache keys for `guest` vs `auth`. Never let a guest cold-boot response populate the authenticated cache.
- The player must resolve HLS and direct-only Audius playback through `GET /stream/:trackId`; the backend is the authority for entitlement and `directAudiusStreaming`.
- Catalog filters must compose conditions with `$and`; do not spread filters in a way that overwrites `$or` clauses from playback visibility.
- Long-term ingest path: classify Audius legal/technical copyability in the connector, ingest copyable tracks through Syra S3/HLS, persist stream-only policy explicitly. Do not solve this by treating all Audius as direct streaming.
