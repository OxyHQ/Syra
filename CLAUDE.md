# Syra

## AWS Deployment

The backend runs on **AWS ECS Fargate** (region `us-west-2`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `3000` | **Domain**: `api.syra.oxy.so`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/syra`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/syra/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

## Domain Migration (in progress — NOT yet cut over)

Target: web `syra.oxy.so` → **`syra.fm`**, API `api.syra.oxy.so` → **`api.syra.fm`**.

Done so far (additive, deploy-safe — both old and new work simultaneously):
- Backend CORS / Socket.IO allow-list accepts `https://syra.fm` and `https://www.syra.fm` alongside the existing `https://syra.oxy.so`.
- App universal-link hosts (`packages/frontend/app.config.js`) include `syra.fm` / `www.syra.fm` alongside `syra.oxy.so`.

**Pending — FINAL cutover step (do NOT do until `api.syra.fm` infra — DNS, ACM cert, ALB target — is live):**
- Flip the frontend prod `API_URL` / websocket host in `packages/frontend/config.ts` (and `eas.json`) from `api.syra.oxy.so` → `api.syra.fm`.
- Point the backend `FRONTEND_URL` default at `syra.fm`.
- Set `STREAM_KEY_BASE_URL=https://api.syra.fm` for newly packaged HLS tracks (existing playlists keep their baked-in key URI).
- Retire the old `syra.oxy.so` / `api.syra.oxy.so` origins once traffic has fully moved.
