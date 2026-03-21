# Deployment Architecture

Guide for the Syra monorepo deployment across DigitalOcean and Cloudflare.

## Architecture

| Component | Platform | Domain | Description |
|---|---|---|---|
| `syra` | DigitalOcean App Platform | `api.syra.oxy.so` | Node.js backend API |
| `syra-frontend` | Cloudflare Pages | `syra.oxy.so` | Expo web frontend |

## Routing

```
syra.oxy.so/*           → syra-frontend (Cloudflare Pages)
api.syra.oxy.so/*       → syra backend (DigitalOcean)
```

## Backend Deployment (DigitalOcean)

The `syra-production` DO app deploys the backend service only.

### Build Command

```
npm ci --include=dev && npm run build -w @syra/shared-types && npm run build -w @syra/backend && npm prune --omit=dev
```

- Instance: `apps-s-1vcpu-1gb-fixed`
- Run command: `node packages/backend/dist/server.js`

### App Spec

The DO app spec is at `.do/app.yaml`. To create or update the app:

```bash
# Create app from spec
curl -X POST "https://api.digitalocean.com/v2/apps" \
  -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "spec": $(cat .do/app.yaml | python3 -c "import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin)))")
}
EOF
```

Or via the DigitalOcean dashboard: Apps > Create App > Import from `.do/app.yaml`.

### Environment Variables

App-level (shared):

| Variable | Value | Scope |
|---|---|---|
| `FRONTEND_URL` | `https://syra.oxy.so` | `RUN_AND_BUILD_TIME` |
| `OXY_API_URL` | `https://api.oxy.so` | `RUN_AND_BUILD_TIME` |
| `NODE_ENV` | `production` | `RUN_AND_BUILD_TIME` |

Backend secrets (configured on the `syra` service component):

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (shared Oxy cluster) |
| `REDIS_URL` | Redis/Valkey connection string |
| `JWT_SECRET` | JWT signing secret |
| `SPACES_KEY` | DigitalOcean Spaces access key |
| `SPACES_SECRET` | DigitalOcean Spaces secret key |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Firebase service account (base64-encoded) |

Non-secret runtime vars:

| Variable | Value |
|---|---|
| `AWS_REGION` | `fra1` |
| `AWS_ENDPOINT_URL` | `https://fra1.digitaloceanspaces.com` |
| `AWS_S3_BUCKET` | `musico-bucket` |
| `S3_AUDIO_PREFIX` | `audio` |
| `FIREBASE_PROJECT_ID` | `musico-a7a53` |

### Deployment Trigger

Deployments trigger automatically on push to `main` (deploy-on-push enabled).

## Database

The app connects to a managed MongoDB cluster (`db-oxy`) on DigitalOcean. Per Oxy ecosystem conventions, the database name is `musico-production` (built from `APP_NAME + NODE_ENV`), passed via the `dbName` option in `mongoose.connect()`.

## DNS

DNS is managed by Cloudflare (zone `oxy.so`):

| Record | Type | Target |
|---|---|---|
| `api.syra.oxy.so` | CNAME | `<syra-production-hash>.ondigitalocean.app` (DNS-only, no proxy) |

The CNAME target will be provided by DO App Platform after the app is created. Update the Cloudflare DNS record accordingly.

## Troubleshooting

### Build Errors

Check build logs via the DO dashboard or API:

```bash
curl "https://api.digitalocean.com/v2/apps/{app-id}/deployments/{deploy-id}/components/syra/logs?type=BUILD" \
  -H "Authorization: Bearer $DIGITALOCEAN_TOKEN"
```

### Multiple Lock Files

The DO buildpack rejects builds if multiple package manager lock files exist. The `.gitignore` should exclude `bun.lock` to prevent this.
