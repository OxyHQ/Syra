# syntax=docker/dockerfile:1.7
#
# Production image for the @syra/backend service.
#
# Multi-stage, multi-arch (amd64 + arm64). `node:22.23-alpine` and `oven/bun`
# are multi-arch manifests, so this image builds natively on AWS Graviton
# (linux/arm64) as well as x86_64 — Docker selects the right base layer per
# target platform. Most native dependencies ship prebuilt musl binaries for
# arm64 (sharp) or are pure JS; the exception is Bento4 (mp42hls/mp4fragment)
# which has no arm64/musl prebuilts and is compiled from source in a dedicated
# stage (see Stage 0).
#
# Build context is the monorepo ROOT (bun workspaces):
#   docker build -f packages/backend/Dockerfile -t syra-backend:test .
#
# Pipeline:
#   bento4: cmake build of mp42hls, mp4fragment, mp4encrypt from source
#   build:  bun install --frozen-lockfile
#           && bun run build:shared-types
#           && bun run build:sdk
#           && bun run build:backend
#           && reinstall production-only deps
#   run:    node packages/backend/dist/server.js

# ---------------------------------------------------------------------------
# Stage 0: bento4 — compile Bento4 media tools from source.
#
# Bento4 ships no prebuilt musl/arm64 binaries, so we build from source for
# the target platform. A dedicated stage keeps the C++ toolchain out of both
# the builder and runner stages. The three binaries we need are:
#   mp42hls      — packages AAC MP4 into AES-128 encrypted HLS
#   mp4fragment  — fragments an MP4 file (required input for mp42hls)
#   mp4encrypt   — low-level AES encryption helper (used in testing)
# ---------------------------------------------------------------------------
FROM alpine:3.20 AS bento4

RUN apk add --no-cache git cmake make g++

RUN git clone --depth 1 --branch v1.6.0-641 \
      https://github.com/axiomatic-systems/Bento4.git /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /src/build --target mp42hls mp4fragment mp4encrypt -j "$(nproc)"

# ---------------------------------------------------------------------------
# Stage 1: builder — install full dependency graph and compile TypeScript.
# ---------------------------------------------------------------------------
# Pinned to 22.23 (>= 22.12): see the runner stage for why the whole image is
# held at a Node line that supports `require(<ESM>)` — the backend runtime
# require()s the ESM-only `livekit-server-sdk`. Kept identical here so the
# build and runtime toolchains never drift.
FROM node:22.23-alpine AS builder

# Toolchain for any dependency that needs a node-gyp fallback (e.g. if a prebuilt
# binary is unavailable for the target arch). Confined to the builder stage so it
# never reaches the runtime image.
RUN apk add --no-cache python3 make g++ libc6-compat

# Bun is only used as the package manager / script runner at build time; the
# runtime stays Node. The musl build from the matching alpine image works on
# both amd64 and arm64.
COPY --from=oven/bun:1.3.14-alpine /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Install dependencies first for better layer caching. Copy only the manifests,
# the lockfile and the bun config (hoisted linker) so this layer is reused
# unless dependencies change. EVERY workspace member's package.json must be
# present — `bun install --frozen-lockfile` validates the full workspace graph
# against the lockfile and aborts if any member is missing (frontend/studio
# depend on @syra/live, so its manifest is required even though the backend does
# not use it). The rest of the non-backend workspaces' source is excluded via
# Dockerfile.dockerignore.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/studio/package.json ./packages/studio/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/live/package.json ./packages/live/package.json

# Deterministic install from the lockfile, including devDependencies (TypeScript,
# ts build tooling) which are required to compile the project.
# The root postinstall builds @syra/shared-types; sources are not present yet at
# install time, so skip lifecycle scripts here and build explicitly below once
# sources are copied.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy the source needed to build the backend and its workspace dependencies.
# The sdk (@syra.fm/sdk) is a workspace dependency the backend imports (utils/
# syraPodcast.ts) AND require()s at runtime, so its source must be present to
# compile it before the backend.
COPY tsconfig.json ./tsconfig.json
COPY packages/shared-types ./packages/shared-types
COPY packages/sdk ./packages/sdk
COPY packages/backend ./packages/backend

# Build order is load-bearing: shared-types, then the sdk, then the backend.
# - shared-types: backend imports its compiled output at runtime via the
#   `@syra/shared-types` -> file:../shared-types workspace link.
# - sdk: the backend's tsc (Node16 module resolution) resolves `@syra.fm/sdk`
#   from its built `dist/types/*.d.ts`; without the dist the backend build fails
#   with TS2307, and `node` would fail to load the sdk at runtime.
# Produces packages/backend/dist/server.js.
RUN bun run build:shared-types \
 && bun run build:sdk \
 && bun run build:backend

# Fail fast if the expected entry point was not emitted (the backend build script
# ends with `|| true`, so a silent compile failure must not slip through).
RUN test -f packages/backend/dist/server.js \
 || (echo "ERROR: packages/backend/dist/server.js was not produced by the build" && exit 1)

# Strip devDependencies so only production modules are carried into the runtime
# image (bun has no `prune`; a clean production install from the same lockfile
# is the deterministic equivalent). Scripts are skipped to avoid re-running the
# shared-types postinstall.
RUN rm -rf node_modules \
 && bun install --frozen-lockfile --production --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2: runner — minimal runtime with production deps and compiled output.
# ---------------------------------------------------------------------------
# Pinned to 22.23 (>= 22.12) on purpose. The backend is compiled to CommonJS and
# started with `node packages/backend/dist/server.js`, but it require()s
# `livekit-server-sdk`, which is ESM-only (`"type":"module"`). `require()` of an
# ESM package throws ERR_REQUIRE_ESM on Node < 22.12; support for require(<ESM>)
# is enabled by default from 22.12.0 onward. The floating `node:22-alpine` tag
# would satisfy this today, but pin the minor so a future base-image roll can
# never drop below the require(ESM) threshold.
FROM node:22.23-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000

# libc6-compat: glibc shim some prebuilt native binaries expect on Alpine/musl.
# dumb-init: proper PID 1 so SIGTERM/SIGINT reach Node for graceful shutdown.
# ffmpeg: provides ffmpeg + ffprobe for EBU R128 measurement and AAC transcoding.
# libstdc++: C++ runtime required by the Bento4 binaries (ffmpeg pulls it too,
#            but listed explicitly so the dependency is obvious and auditable).
RUN apk add --no-cache libc6-compat dumb-init ffmpeg libstdc++

# Copy Bento4 binaries from the build stage. Placed here (as root, before
# USER node) so the binaries land in /usr/local/bin with correct ownership and
# execute bits — apk add and COPY both need root.
COPY --from=bento4 /src/build/mp42hls /src/build/mp4fragment /src/build/mp4encrypt /usr/local/bin/

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
# sdk manifest: the workspace symlink node_modules/@syra.fm/sdk -> ../../packages/sdk
# (carried over inside node_modules) resolves here, and package.json main/exports
# point require() at dist/cjs so the CommonJS backend can load it.
COPY --from=builder --chown=node:node /app/packages/sdk/package.json ./packages/sdk/package.json

# Compiled JavaScript for the backend and its workspace dependencies.
COPY --from=builder --chown=node:node /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder --chown=node:node /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder --chown=node:node /app/packages/sdk/dist ./packages/sdk/dist

# i18n locale files and other runtime assets shipped with the backend source.
COPY --from=builder --chown=node:node /app/packages/backend/assets ./packages/backend/assets

EXPOSE 3000

# Container-level health check hitting the app's /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/health',timeout:4000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/backend/dist/server.js"]
