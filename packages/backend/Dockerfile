# syntax=docker/dockerfile:1.7
#
# Production image for the @syra/backend service.
#
# Multi-stage, multi-arch (amd64 + arm64). `node:22-alpine` is a multi-arch
# manifest, so this image builds natively on AWS Graviton (linux/arm64) as well
# as x86_64 — Docker selects the right base layer per target platform. All native
# dependencies used by the backend ship prebuilt musl binaries for arm64 (sharp)
# or are pure JS (bcryptjs, firebase-admin), so no source compilation is required.
#
# Build context is the monorepo ROOT (npm workspaces):
#   docker build -f packages/backend/Dockerfile -t syra-backend:test .
#
# Mirrors the DigitalOcean buildpack pipeline:
#   build: npm ci --include=dev
#          && npm run build -w @syra/shared-types
#          && npm run build -w @syra/backend
#          && npm prune --omit=dev
#   run:   node packages/backend/dist/server.js

# ---------------------------------------------------------------------------
# Stage 1: builder — install full dependency graph and compile TypeScript.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

# Toolchain for any dependency that needs a node-gyp fallback (e.g. if a prebuilt
# binary is unavailable for the target arch). Confined to the builder stage so it
# never reaches the runtime image.
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Install dependencies first for better layer caching. Copy only the manifests
# and the lockfile so this layer is reused unless dependencies change.
# The frontend workspace's package.json is included (the rest of its source is
# excluded via Dockerfile.dockerignore) so the npm workspace graph stays valid.
COPY package.json package-lock.json .npmrc ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json

# Deterministic install from the lockfile, including devDependencies (TypeScript,
# ts build tooling) which are required to compile the project.
# The root postinstall runs `npm run build -w @syra/shared-types`; sources are
# not present yet at install time, so skip lifecycle scripts here and build
# explicitly below once sources are copied.
RUN npm ci --include=dev --ignore-scripts

# Copy the source needed to build the backend and its shared-types dependency.
COPY tsconfig.json ./tsconfig.json
COPY packages/shared-types ./packages/shared-types
COPY packages/backend ./packages/backend

# Build shared-types first (backend imports its compiled output at runtime via
# the `@syra/shared-types` -> file:../shared-types workspace link), then the
# backend. Produces packages/backend/dist/server.js.
RUN npm run build -w @syra/shared-types \
 && npm run build -w @syra/backend

# Fail fast if the expected entry point was not emitted (the backend build script
# ends with `|| true`, so a silent compile failure must not slip through).
RUN test -f packages/backend/dist/server.js \
 || (echo "ERROR: packages/backend/dist/server.js was not produced by the build" && exit 1)

# Strip devDependencies so only production modules are carried into the runtime
# image. Scripts are skipped to avoid re-running the shared-types postinstall.
RUN npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2: runner — minimal runtime with production deps and compiled output.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000

# libc6-compat: glibc shim some prebuilt native binaries expect on Alpine/musl.
# dumb-init: proper PID 1 so SIGTERM/SIGINT reach Node for graceful shutdown.
RUN apk add --no-cache libc6-compat dumb-init

WORKDIR /app

# Run as the unprivileged `node` user provided by the base image. Ownership is
# set inline via COPY --chown (a recursive `chown -R` over node_modules would add
# a large, slow extra layer).
USER node

# Bring over the pruned (production-only) dependency tree and the workspace
# manifests so Node's workspace symlinks (e.g. @syra/shared-types) resolve.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=builder --chown=node:node /app/packages/shared-types/package.json ./packages/shared-types/package.json

# Compiled JavaScript for the backend and its shared-types dependency.
COPY --from=builder --chown=node:node /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder --chown=node:node /app/packages/shared-types/dist ./packages/shared-types/dist

# i18n locale files and other runtime assets shipped with the backend source.
COPY --from=builder --chown=node:node /app/packages/backend/assets ./packages/backend/assets

EXPOSE 3000

# Container-level health check hitting the app's /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/health',timeout:4000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/backend/dist/server.js"]
