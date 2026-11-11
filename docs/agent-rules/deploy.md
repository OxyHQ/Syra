# AWS deployment facts

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

- **Runtime**: Bun (`oven/bun:1.4.3-alpine` runner, `bun packages/backend/dist/server.js`); every one-shot command names `bun` too (`deployWorkflow.test.ts`). Quality's `Backend Image Smoke` boots the real image (`.github/scripts/smoke-backend-image.sh`).
- **Port**: `3000` (deployed; ECS sets `PORT` explicitly — the local dev default is `4120`) | **Domain**: `api.syra.fm`
- **Deploy**: `.github/workflows/deploy-aws.yml` (runs after Quality passes on main, only when backend inputs changed; `.github/scripts/deploy-scope.sh`) → `linux/arm64` Docker → ECR `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/syra` → `ecs update-service --force-new-deployment`
- **Secrets**: SSM `/oxy/syra/*` (SecureString) is the ONLY source; set or rotate with `aws ssm put-parameter --overwrite` (oxy-infra runbook 46). GitHub holds only CI tokens, and no workflow writes SSM (`deployWorkflow.test.ts`).

Domains: 
Production: web `https://syra.fm`, API/WebSocket `https://api.syra.fm` / `wss://api.syra.fm`. Do not restore retired Syra oxy.so hosts in runtime config, CORS, EAS env, universal links, or deployment scripts.
