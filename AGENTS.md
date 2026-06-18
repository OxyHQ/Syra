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

- Current Oxy packages: `@oxyhq/core ^3.4.5`, `@oxyhq/services ^10.2.2`, `@oxyhq/bloom ^0.8.5`.
- Expo web root HTML (`packages/frontend/app/+html.tsx`) injects `getSsoCallbackBootstrapScript()` from `@oxyhq/core`; do not add a per-app `/__oxy/sso-callback` route or copy SSO helper logic locally.
- Private Syra API calls must wait for Oxy cold boot: gate library, playlists, artist profile, privacy, preferences, and recommendations on `isAuthResolved && isAuthenticated` plus an available access token.
- `packages/frontend/utils/api.ts` owns the authenticated API token provider; components/hooks should not hand-roll Authorization header refresh.
