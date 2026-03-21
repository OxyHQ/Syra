#!/bin/bash
# Setup script for Syra backend on DigitalOcean App Platform
# Requires: DIGITALOCEAN_TOKEN environment variable
#
# Usage:
#   export DIGITALOCEAN_TOKEN=<your-token>
#   bash scripts/setup-do-app.sh

set -euo pipefail

if [ -z "${DIGITALOCEAN_TOKEN:-}" ]; then
  echo "Error: DIGITALOCEAN_TOKEN is not set"
  echo "Get a token from: https://cloud.digitalocean.com/account/api/tokens"
  exit 1
fi

API="https://api.digitalocean.com/v2"
AUTH="Authorization: Bearer $DIGITALOCEAN_TOKEN"

echo "Creating Syra app on DigitalOcean App Platform..."

# Create the app using the spec
RESPONSE=$(curl -s -X POST "$API/apps" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
  "spec": {
    "name": "syra-production",
    "region": "ams",
    "services": [{
      "name": "syra",
      "github": {
        "repo": "OxyHQ/Syra",
        "branch": "main",
        "deploy_on_push": true
      },
      "source_dir": "/",
      "environment_slug": "node-js",
      "instance_count": 1,
      "instance_size_slug": "apps-s-1vcpu-1gb-fixed",
      "http_port": 3000,
      "build_command": "npm ci --include=dev && npm run build -w @syra/shared-types && npm run build -w @syra/backend && npm prune --omit=dev",
      "run_command": "node packages/backend/dist/server.js",
      "health_check": {
        "http_path": "/health"
      },
      "envs": [
        {"key": "NODE_ENV", "value": "production", "scope": "RUN_AND_BUILD_TIME"},
        {"key": "FRONTEND_URL", "value": "https://syra.oxy.so", "scope": "RUN_AND_BUILD_TIME"},
        {"key": "OXY_API_URL", "value": "https://api.oxy.so", "scope": "RUN_AND_BUILD_TIME"},
        {"key": "AWS_REGION", "value": "fra1", "scope": "RUN_TIME"},
        {"key": "AWS_ENDPOINT_URL", "value": "https://fra1.digitaloceanspaces.com", "scope": "RUN_TIME"},
        {"key": "AWS_S3_BUCKET", "value": "musico-bucket", "scope": "RUN_TIME"},
        {"key": "S3_AUDIO_PREFIX", "value": "audio", "scope": "RUN_TIME"},
        {"key": "FIREBASE_PROJECT_ID", "value": "musico-a7a53", "scope": "RUN_TIME"},
        {"key": "MONGODB_URI", "type": "SECRET", "scope": "RUN_TIME"},
        {"key": "REDIS_URL", "type": "SECRET", "scope": "RUN_TIME"},
        {"key": "JWT_SECRET", "type": "SECRET", "scope": "RUN_TIME"},
        {"key": "SPACES_KEY", "type": "SECRET", "scope": "RUN_TIME"},
        {"key": "SPACES_SECRET", "type": "SECRET", "scope": "RUN_TIME"},
        {"key": "FIREBASE_SERVICE_ACCOUNT_BASE64", "type": "SECRET", "scope": "RUN_TIME"}
      ]
    }]
  }
}')

APP_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['app']['id'])" 2>/dev/null)

if [ -z "$APP_ID" ]; then
  echo "Failed to create app:"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
  exit 1
fi

echo "App created with ID: $APP_ID"

# Get the default hostname
DEFAULT_HOSTNAME=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['app']['default_ingress'])" 2>/dev/null || true)

echo ""
echo "App ID: $APP_ID"
echo "Default hostname: $DEFAULT_HOSTNAME"
echo ""
echo "Next steps:"
echo "1. Set secret env vars in DO dashboard: https://cloud.digitalocean.com/apps/$APP_ID/settings"
echo "   - MONGODB_URI"
echo "   - REDIS_URL"
echo "   - JWT_SECRET"
echo "   - SPACES_KEY"
echo "   - SPACES_SECRET"
echo "   - FIREBASE_SERVICE_ACCOUNT_BASE64"
echo ""
echo "2. Add custom domain 'api.syra.oxy.so' in DO dashboard"
echo ""
echo "3. Create Cloudflare CNAME record:"
echo "   api.syra.oxy.so -> $DEFAULT_HOSTNAME (DNS only, no proxy)"
