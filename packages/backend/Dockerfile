# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
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
#   prod-deps: bun install --frozen-lockfile --production (runtime node_modules)
#   build:  bun install --frozen-lockfile
#           && bun run build:shared-types
#           && bun run build:sdk
#           && bun run build:backend
#   run:    bun packages/backend/dist/server.js  (oven/bun:1.4.3-alpine)
#
# The runtime is Bun. The backend ran on Node 22 until 2026-10; Bun runs the
# same CommonJS build unchanged. The runner stage is the musl (alpine) oven/bun
# image on the SAME Alpine release as node:22.23-alpine (3.24), so sharp's musl
# prebuild, the apk ffmpeg/chromaprint and the Bento4 binaries are the ones the
# Node image shipped. Rolling back to Node is reverting the change that made
# this switch: it restores the node runner stage AND the `node` one-shot
# commands in .github/workflows/deploy-aws.yml and run-backend-script.yml, which
# must always name the runtime this image ships.
#
# Every base image, and the `syntax` frontend on line 1, is pinned by its
# multi-arch index digest after the tag (`tag@sha256:...`). A tag is mutable:
# a re-pushed `node:22.23-alpine` would change what this file builds without
# changing one byte of it, and this file's bytes, with its
# Dockerfile.dockerignore, are what .github/scripts/reviewed-images.json pins
# (reviewed-image.py). The tag stays for readers and for
# scripts/check-bun-pin.mjs; the digest is what the build uses. Bumping a base
# image means a new tag AND its index digest
# (`docker buildx imagetools inspect <image>:<tag>`), and a re-review.

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
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS bento4

RUN apk add --no-cache git cmake make g++

# A git tag is mutable, so the clone is checked against the commit
# v1.6.0-641 peels to (`git ls-remote ... 'refs/tags/v1.6.0-641^{}'`); a
# moved tag fails the build instead of compiling someone else's source.
# A literal, not an ARG, so no --build-arg can move it.
RUN git clone --depth 1 --branch v1.6.0-641 \
      https://github.com/axiomatic-systems/Bento4.git /src \
 && test "$(git -C /src rev-parse HEAD)" = dc264854d1f76c370b65b18d9f303a95f7f21ab1 \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /src/build --target mp42hls mp4fragment mp4encrypt -j "$(nproc)"

# ---------------------------------------------------------------------------
# Stage 1: base — toolchain, bun and every workspace manifest: what an install
# reads. `prod-deps` and `builder` below both start from it.
# ---------------------------------------------------------------------------
# The build toolchain (tsc, react-native-builder-bob) stays on Node 22.23 on
# Alpine 3.24, the same libc and Alpine release as the Bun runner stage, so the
# musl prebuilds `prod-deps` installs are the ones the runner loads.
FROM node:22.23-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base

# Toolchain for any dependency that needs a node-gyp fallback (e.g. if a prebuilt
# binary is unavailable for the target arch). Confined to the builder stage so it
# never reaches the runtime image.
RUN apk add --no-cache python3 make g++ libc6-compat

# Bun is the package manager here and the runtime in the runner stage. The musl
# build from the matching alpine image works on both amd64 and arm64.
COPY --from=oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Install dependencies first for better layer caching. Copy only the manifests,
# the lockfile and the bun config (hoisted linker) so this layer is reused
# unless dependencies change. EVERY workspace member's package.json must be
# present — `bun install --frozen-lockfile` validates the full workspace graph
# against the lockfile and aborts if any member is missing, so a new workspace
# needs a COPY line here even when the backend never imports it. The five below
# are exactly the members `bun.lock` records. The rest of the non-backend
# workspaces' source is excluded via Dockerfile.dockerignore.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/studio/package.json ./packages/studio/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json

# ---------------------------------------------------------------------------
# Stage 1b: prod-deps — the production dependency tree the runner ships.
#
# This install used to be the builder's LAST step (`rm -rf node_modules && bun
# install --production`), after `COPY packages/backend`, so every source change
# re-ran it: 46.9s, plus 12.1s copying the fresh tree into the runner, on every
# deploy (Deploy to AWS run 36506244300, steps #36/#37). Off the manifests and
# lockfile alone it is cached until a dependency changes.
#
# Same tree, measured with bun on 2026-09-29: this stage's shape and the old
# sequence (full install, sources copied, node_modules removed, production
# install) produce identical node_modules — 1334 entries, every package.json
# version and every workspace symlink target equal.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 1c: builder — install the full dependency graph and compile TypeScript.
# ---------------------------------------------------------------------------
FROM base AS builder

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
COPY packages/contracts ./packages/contracts
COPY packages/backend ./packages/backend

# Build order is load-bearing: shared-types, then the sdk, then the backend.
# - shared-types: backend imports its compiled output at runtime via the
#   `@syra/shared-types` -> file:../shared-types workspace link.
# - sdk: the backend's tsc (Node16 module resolution) resolves `@syra.fm/sdk`
#   from its built `lib/typescript/**/*.d.ts` (react-native-builder-bob output);
#   without lib the backend build fails with TS2307, and the runtime would fail
#   to load the sdk.
# Produces packages/backend/dist/server.js.
RUN bun run build:shared-types \
 && bun run build:sdk \
 && bun run build:backend

# Fail fast if the expected entry point was not emitted (the backend build script
# ends with `|| true`, so a silent compile failure must not slip through).
RUN test -f packages/backend/dist/server.js \
 || (echo "ERROR: packages/backend/dist/server.js was not produced by the build" && exit 1)

# devDependencies never reach the runtime image: the runner takes node_modules
# from `prod-deps` (bun has no `prune`; a clean production install from the same
# lockfile is the deterministic equivalent), not from this stage.

# ---------------------------------------------------------------------------
# Stage 2: runner — minimal runtime with production deps and compiled output.
# ---------------------------------------------------------------------------
# Bun 1.4.3 on Alpine 3.24 (musl), the same tag and digest the base stage copies
# bun from, so the runtime is exactly the bun that installed the dependency tree
# and that CI runs. The backend is compiled to CommonJS and require()s the
# ESM-only `livekit-server-sdk`; Bun supports require(<ESM>) natively.
#
# The image puts a `node` on PATH (/usr/local/bun-node-fallback-bin/node), but
# it is a symlink to bun: there is no Node in this image, so every command that
# runs it names `bun` rather than relying on that.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runner

ENV NODE_ENV=production \
    PORT=3000

# libc6-compat: glibc shim some prebuilt native binaries expect on Alpine/musl.
# dumb-init: proper PID 1 so SIGTERM/SIGINT reach Bun for graceful shutdown, and
#            the reaper for the ffmpeg/fpcalc/Bento4 children ingest spawns.
# ffmpeg: provides ffmpeg + ffprobe for EBU R128 measurement, AAC transcoding and
#         the source probe that is the sole authority for a track's duration.
# chromaprint: provides /usr/bin/fpcalc, the Chromaprint fingerprinter used to
#              match an upload against the existing catalogue. On Alpine the
#              package is named `chromaprint`; `libchromaprint-tools` is the
#              Debian name and does not exist here.
# libstdc++: C++ runtime required by the Bento4 binaries (ffmpeg pulls it too,
#            but listed explicitly so the dependency is obvious and auditable).
RUN apk add --no-cache libc6-compat dumb-init ffmpeg chromaprint libstdc++

# Copy Bento4 binaries from the build stage. Placed here (as root, before
# USER bun) so the binaries land in /usr/local/bin with correct ownership and
# execute bits — apk add and COPY both need root.
COPY --from=bento4 /src/build/mp42hls /src/build/mp4fragment /src/build/mp4encrypt /usr/local/bin/

WORKDIR /app

# Run as the unprivileged `bun` user provided by the base image (uid/gid 1000,
# as the Node image's `node` was). Ownership is set inline via COPY --chown (a
# recursive `chown -R` over node_modules would add a large, slow extra layer).
USER bun

# Bring over the pruned (production-only) dependency tree and the workspace
# manifests so the workspace symlinks (e.g. @syra/shared-types) resolve.
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=builder --chown=bun:bun /app/packages/shared-types/package.json ./packages/shared-types/package.json
# sdk manifest: the workspace symlink node_modules/@syra.fm/sdk -> ../../packages/sdk
# (carried over inside node_modules) resolves here, and package.json main/exports
# point require() at lib/commonjs so the CommonJS backend can load it.
COPY --from=builder --chown=bun:bun /app/packages/sdk/package.json ./packages/sdk/package.json

# Compiled JavaScript for the backend and its workspace dependencies.
COPY --from=builder --chown=bun:bun /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder --chown=bun:bun /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder --chown=bun:bun /app/packages/sdk/lib ./packages/sdk/lib
COPY --from=builder --chown=bun:bun /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder --chown=bun:bun /app/packages/contracts/dist ./packages/contracts/dist

# i18n locale files and other runtime assets shipped with the backend source.
COPY --from=builder --chown=bun:bun /app/packages/backend/assets ./packages/backend/assets

# The SQL migrations and their journal. NOT optional and NOT dev-only: the deploy
# runs `bun packages/backend/dist/src/db/migrate.js` as a one-shot ECS task from
# THIS image (see .github/scripts/deploy-ecs-image.sh), and `findMigrationsFolder`
# in src/db/migrate.ts locates `drizzle/` by walking UP from the compiled module —
# /app/packages/backend/dist/src/db -> ... -> /app/packages/backend/drizzle. Four
# levels, inside its search depth of six.
#
# Measured against a faithful reconstruction of this stage's COPY set: without
# this line the migration task dies with "Cannot locate the drizzle/ migrations
# directory", naming all six directories it searched; with it, the same command
# proceeds to open a connection. It fails loudly rather than silently reporting a
# clean run that migrated nothing — that is `readJournal`'s doing, not this
# Dockerfile's — but it fails, and it fails inside a production deploy.
COPY --from=builder --chown=bun:bun /app/packages/backend/drizzle ./packages/backend/drizzle

# `data/` holds the podcast feed list the re-import script reads, and the script
# itself DOES reach the image — `tsconfig.build.json` excludes only tests, so
# `src/scripts/**` compiles into `dist/`. Shipping the code without its input is
# the failure this line prevents: `reimportPodcastFeeds` resolves the list as
# `dist/scripts/../../data/podcast-feeds.txt`, so without this COPY the task
# starts, connects, and dies on ENOENT after the deploy has already succeeded.
COPY --from=builder --chown=bun:bun /app/packages/backend/data ./packages/backend/data

EXPOSE 3000

# Container-level health check hitting the app's /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"

# dumb-init is PID 1 and forwards SIGTERM to Bun, which runs server.ts's
# graceful shutdown and exits 0. Every one-shot that overrides this command
# (the migrator in deploy-aws.yml, run-backend-script.yml) names `bun` too.
# .github/scripts/smoke-backend-image.sh boots this image in CI and holds all of
# it: the migrator, /health, the process tree, the native and system
# dependencies, a failed boot exiting non-zero and SIGTERM exiting 0.
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "packages/backend/dist/server.js"]
