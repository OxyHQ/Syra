#!/usr/bin/env bash
# Boot the built backend image the way ECS runs it, against a throwaway
# Postgres, and fail unless the production runtime (Bun under dumb-init, the
# image's own user, entrypoint and CMD) can:
#   1. refuse a misconfigured boot, and a boot against an unmigrated database,
#      with a NON-ZERO exit, not a hang and not a 0;
#   2. refuse a migrator run with no --target-database, then apply the journal
#      with the exact argv deploy-aws.yml's one-shots use (`all` for an empty
#      database, as the cutover does, then `pre` and `post` as every release does);
#   3. load and use its native and system dependencies (sharp's musl prebuild,
#      livekit-server-sdk, firebase-admin/gRPC, ffmpeg, fpcalc, Bento4) through
#      the real backend modules — .github/scripts/image-runtime-probe.cjs;
#   4. serve /health (the container HEALTHCHECK's target) with 200 and a connected
#      database, and / (the ALB target group's health path) with 200, from the
#      image's default CMD;
#   5. run as dumb-init (PID 1) -> bun packages/backend/dist/server.js, as `bun`;
#   6. pass its own HEALTHCHECK command;
#   7. turn SIGTERM (`docker stop`, as ECS does on a rollout) into server.ts's
#      graceful shutdown: exit 0. Its 10 s fallback exits 1.
# A unit suite cannot see any of these: they are properties of the image.
#
# DATABASE_URL must name an EMPTY throwaway database called `syra` (the
# migrator's --target-database is the deploy's), reachable from the host
# network.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (an empty throwaway database named syra)}"
: "${EXPECTED_BUN_VERSION:?EXPECTED_BUN_VERSION required (package.json packageManager)}"
PORT="${PORT:-3000}"
STREAM_KEY_BASE_URL="https://api.syra.fm"
NAME="syra-backend-smoke-$$"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATE=(bun packages/backend/dist/src/db/migrate.js)

cleanup() { docker rm -f "$NAME" "$NAME-run" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
  echo "::error::$*"
  exit 1
}

# Runs the image to completion with a deadline; prints the exit code. A boot
# that should fail and instead keeps serving is a hang, reported as 124.
run_to_exit() {
  local code=0
  timeout 90 docker run --rm --name "$NAME-run" --network host -e DATABASE_URL -e PORT="$PORT" "$@" \
    >"$RUNNER_LOG" 2>&1 || code=$?
  # `timeout` kills the client, not necessarily the container.
  docker rm -f "$NAME-run" >/dev/null 2>&1 || true
  echo "$code"
}
RUNNER_LOG="$(mktemp)"

expect_failure() {
  local what="$1" code="$2"
  if [ "$code" = 0 ] || [ "$code" = 124 ]; then
    cat "$RUNNER_LOG"
    fail "$what exited $code; it must exit non-zero on its own"
  fi
  echo "ok: $what exited $code"
}

# ── The runtime is the pinned Bun ─────────────────────────────────────────────
version=$(docker run --rm "$IMAGE" bun --version)
[ "$version" = "$EXPECTED_BUN_VERSION" ] || fail "image bun is $version, packageManager pins $EXPECTED_BUN_VERSION"
echo "ok: image bun $version"

# ── 1. Failed boots exit non-zero ─────────────────────────────────────────────
# NODE_ENV=production comes from the image; without STREAM_KEY_BASE_URL
# config/env.ts refuses the boot at import.
expect_failure "boot without STREAM_KEY_BASE_URL" "$(run_to_exit "$IMAGE")"
# A reachable but unmigrated database: the server starts listening, then
# assertModerationSchema() rejects inside bootServer(), an unhandled rejection.
expect_failure "boot against an unmigrated database" \
  "$(run_to_exit -e STREAM_KEY_BASE_URL="$STREAM_KEY_BASE_URL" "$IMAGE")"

# ── 2. The migrator, with the deploy's argv ───────────────────────────────────
expect_failure "migrator without --target-database" \
  "$(run_to_exit "$IMAGE" "${MIGRATE[@]}" --phase=pre)"
for phase in all pre post; do
  code=$(run_to_exit "$IMAGE" "${MIGRATE[@]}" "--phase=$phase" --target-database=syra)
  if [ "$code" != 0 ]; then
    cat "$RUNNER_LOG"
    fail "migrator --phase=$phase exited $code"
  fi
  echo "ok: migrator --phase=$phase"
done

# ── 3. Native and system dependencies ─────────────────────────────────────────
docker run --rm -e EXPECTED_BUN_VERSION -v "$SCRIPTS_DIR:/probe:ro" "$IMAGE" \
  bun /probe/image-runtime-probe.cjs

# ── 4. The default CMD serves ─────────────────────────────────────────────────
docker run -d --name "$NAME" --network host -e DATABASE_URL -e PORT="$PORT" \
  -e STREAM_KEY_BASE_URL="$STREAM_KEY_BASE_URL" "$IMAGE" >/dev/null

health=
for _ in $(seq 1 60); do
  if health=$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null); then
    break
  fi
  health=
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    break
  fi
  sleep 1
done
if [ -z "$health" ]; then
  docker logs "$NAME" || true
  fail "the backend image never answered /health with 200"
fi
[ "$(jq -r '.services.database.connected' <<<"$health")" = true ] ||
  fail "/health answered 200 without a connected database: $health"
echo "ok: /health 200 ($(jq -r '.status' <<<"$health"); redis is absent in CI, so degraded is expected)"
root=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$root" = 200 ] || fail "/ (the ALB health path) answered $root"
echo "ok: / 200"

# ── 5. The process tree ───────────────────────────────────────────────────────
pid1=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
[ "$pid1" = "dumb-init -- bun packages/backend/dist/server.js " ] ||
  fail "PID 1 is '$pid1', expected 'dumb-init -- bun packages/backend/dist/server.js'"
child=$(docker exec "$NAME" sh -c 'pid=$(pgrep -P 1) && tr "\0" " " </proc/$pid/cmdline && echo && readlink /proc/$pid/exe')
[ "$child" = "bun packages/backend/dist/server.js
/usr/local/bin/bun" ] || fail "dumb-init's child is '$child', expected bun packages/backend/dist/server.js running /usr/local/bin/bun"
user=$(docker exec "$NAME" id -un)
[ "$user" = bun ] || fail "the server runs as '$user', expected the image's unprivileged bun user"
echo "ok: dumb-init -> bun packages/backend/dist/server.js as $user"

# ── 6. The image's own HEALTHCHECK ────────────────────────────────────────────
healthcheck=$(docker inspect -f '{{json .Config.Healthcheck.Test}}' "$IMAGE")
[ "$(jq -r '.[0]' <<<"$healthcheck")" = CMD-SHELL ] || fail "unexpected HEALTHCHECK form: $healthcheck"
docker exec "$NAME" sh -c "$(jq -r '.[1]' <<<"$healthcheck")" ||
  fail "the image's HEALTHCHECK command failed against a healthy server"
echo "ok: HEALTHCHECK passes"

# ── 7. Graceful SIGTERM ───────────────────────────────────────────────────────
docker stop -t 30 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
if [ "$exit_code" != 0 ]; then
  docker logs "$NAME" 2>&1 | tail -50
  fail "SIGTERM did not end in a graceful exit 0 (exit code $exit_code)"
fi
echo "ok: SIGTERM -> exit 0"

echo "Backend image smoke passed: failed boots exit non-zero, migrations, native deps, /health, PID 1 = dumb-init -> bun, HEALTHCHECK, graceful SIGTERM"
