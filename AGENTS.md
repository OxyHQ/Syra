# Syra

## AWS Deployment

The backend runs on **AWS ECS Fargate** (region `us-west-2`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `3000` | **Domain**: `api.syra.fm`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/syra`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/syra/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

## Domains

Production is cut over to **`syra.fm`**:
- Web: `https://syra.fm`
- API / WebSocket / stream keys: `https://api.syra.fm` / `wss://api.syra.fm`

Do not restore the retired Syra oxy.so hosts in runtime config, CORS, EAS env, universal links, or deployment scripts.

## Oxy Integration

- Current Oxy packages: `@oxyhq/core ^3.4.13`, `@oxyhq/services ^10.2.10`, `@oxyhq/bloom ^0.8.5`.
- Expo web root HTML (`packages/frontend/app/+html.tsx`) injects `getSsoCallbackBootstrapScript()` from `@oxyhq/core`; do not add a per-app `/__oxy/sso-callback` route or copy SSO helper logic locally.
- Private Syra API calls must wait for Oxy cold boot: gate library, playlists, artist profile, privacy, preferences, and recommendations with `useAuth().canUsePrivateApi` / `isPrivateApiPending`, not app-local token helpers.
- `packages/frontend/utils/api.ts` owns the linked authenticated Syra API client via `oxyServices.createLinkedClient(...)`; components/hooks should not hand-roll Authorization headers, refresh, or session invalidation.
- Backend auth middleware comes from `@oxyhq/core/server` (`createOxyAuthMiddleware`, `createOptionalOxyAuth`, `createOxyRateLimit`, `requireOxyAuth`, `getRequiredOxyUserId`, `authSocket`). Do not define local `AuthRequest`, `requireAuth`, `getUserId`, bearer parsers, or token-decoding middleware. Bearer-authenticated writes do not fetch app-local CSRF tokens; CSRF remains for ambient cookie credentials.

## Audius Catalog And Playback

- `AUDIUS_CATALOG_ENABLED=true` is a global production visibility flag, not a playback permission bypass.
- Audius provenance does not mean stream-only. Syra's target model is to copy/rehost every Audius track, artist, album, and playlist that can legally and technically be copied, then serve playback from Syra-owned storage/HLS.
- `directAudiusStreaming` is only the user's opt-in fallback for Audius tracks that are not copyable/rehostable and therefore depend only on the provider `streamUrl`.
- Tracks with Syra HLS (`status: ready`, `hlsMasterKey`, `hls[]`) must be visible and playable even when `directAudiusStreaming` is false.
- Direct-only Audius tracks must not appear in track lists, queues, library views, recommendations, or search for users who have not enabled `directAudiusStreaming`.
- Catalog filters must compose conditions with `$and`; do not spread filters in a way that overwrites `$or` clauses from playback visibility.
- The long-term ingest path is: classify Audius legal/technical copyability in the connector, ingest copyable tracks through Syra S3/HLS, and persist stream-only policy explicitly. Do not solve this by treating all Audius as direct streaming.
