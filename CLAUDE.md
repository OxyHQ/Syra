# Syra

## AWS Deployment

The backend runs on **AWS ECS Fargate** (region `eu-west-1`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `3000` | **Domain**: `api.syra.oxy.so`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.eu-west-1.amazonaws.com/oxy/syra`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/syra/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.
