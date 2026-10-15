#!/usr/bin/env bash
# Fixture tests for deploy-scope.sh. `gh` is replaced by a stub on PATH that
# answers each endpoint from FAKE_* variables (already in the shape the real
# `--jq` filter would print), so every decision can be driven both ways — in
# particular the ones that must NOT release, which are the ones that can lose
# a commit if they go wrong.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repository_root/.github/scripts/deploy-scope.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

mkdir "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"/actions/workflows/"*"/runs"*"status=success"*)
    [[ "${FAKE_FAIL_CI:-}" == 1 ]] && exit 1
    printf '%s\n' "${FAKE_CI_COUNT:-0}" ;;
  *"/actions/workflows/"*"/runs"*)
    # Per-commit CI push runs, as the API returns them (the script filters).
    # FAKE_CI_RUNS_FOR: commits with a successful run. FAKE_CI_LIVE_FOR: with
    # one still in progress. FAKE_CI_DEAD_FOR: with only a failed and a
    # cancelled one.
    [[ "${FAKE_FAIL_RUNS:-}" == 1 ]] && exit 1
    sha="$(grep -oE 'head_sha=[0-9a-f]{40}' <<<"$args" | cut -d= -f2)"
    if [[ " ${FAKE_CI_RUNS_FOR:-} " == *" $sha "* ]]; then
      echo '{"total_count":1,"workflow_runs":[{"status":"completed","conclusion":"success"}]}'
    elif [[ " ${FAKE_CI_LIVE_FOR:-} " == *" $sha "* ]]; then
      echo '{"total_count":1,"workflow_runs":[{"status":"in_progress","conclusion":null}]}'
    elif [[ " ${FAKE_CI_DEAD_FOR:-} " == *" $sha "* ]]; then
      echo '{"total_count":2,"workflow_runs":[{"status":"completed","conclusion":"failure"},{"status":"completed","conclusion":"cancelled"}]}'
    else
      echo '{"total_count":0,"workflow_runs":[]}'
    fi ;;
  *"/compare/"*".commits[]"*)
    [[ "${FAKE_FAIL_GATE_COMPARE:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_GATE_COMPARE" ;;
  *"/git/ref/heads/main"*)
    [[ "${FAKE_FAIL_HEAD:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_HEAD" ;;
  *"/actions/caches"*)
    [[ "${FAKE_FAIL_MARKER:-}" == 1 ]] && exit 1
    printf '%s\n' "${FAKE_MARKER:-}" ;;
  *"/compare/"*)
    [[ "${FAKE_FAIL_COMPARE:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_COMPARE" ;;
  *) echo "unexpected gh call: $args" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/gh"

sha=1111111111111111111111111111111111111111
older=2222222222222222222222222222222222222222
newer=3333333333333333333333333333333333333333
prefix=syra-release-backend-
docs='(\.md$|^docs/)'
# The backend scope deploy-aws.yml really passes, read out of it rather than
# restated, so these cases test the paths production is scoped by.
backend="$(sed -n -E "s/^[[:space:]]*BACKEND_PATHS: '(.*)'[[:space:]]*$/\1/p" \
  "$repository_root/.github/workflows/deploy-aws.yml")"
if [[ -z "$backend" || "$(wc -l <<<"$backend")" != 1 ]]; then
  echo "FAIL: deploy-aws.yml must declare BACKEND_PATHS exactly once"
  exit 1
fi

failures=0
# run <expected exit> <expected output line or ''> <env...> -- <args...>
run() {
  local want_rc="$1" want_line="$2"
  shift 2
  local -a env=()
  while [[ "$1" != -- ]]; do
    env+=("$1")
    shift
  done
  shift
  local output="$work/output" rc=0
  : >"$output"
  env PATH="$work/bin:$PATH" RELEASE_SHA="$sha" GITHUB_REPOSITORY=OxyHQ/Syra \
    GITHUB_OUTPUT="$output" GH_TOKEN=x GITHUB_EVENT_NAME=workflow_run "${env[@]}" \
    bash "$script" "$@" >"$work/log" 2>&1 || rc=$?
  if [[ "$rc" != "$want_rc" ]] || { [[ -n "$want_line" ]] && ! grep -qxF "$want_line" "$output"; }; then
    echo "FAIL: $* (${env[*]}): exit $rc, output: $(tr '\n' ' ' <"$output")"
    sed 's/^/    /' "$work/log"
    failures=$((failures + 1))
  fi
}

# gate
run 0 current=true FAKE_HEAD=$sha -- gate
# main moved on to a commit whose CI runs: hold.
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n1\n%s' $newer)" \
  FAKE_CI_RUNS_FOR=$newer -- gate
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n2\n%s\n%s' $older $newer)" \
  FAKE_CI_RUNS_FOR=$older -- gate
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n1\n%s' $newer)" \
  FAKE_CI_LIVE_FOR=$newer -- gate
# main moved on only by pushes that start no CI (auto-merge): release.
run 0 current=true FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n2\n%s\n%s' $older $newer)" \
  -- gate
# ... or whose CI failed or was cancelled, which will release nothing: release.
run 0 current=true FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n2\n%s\n%s' $older $newer)" \
  "FAKE_CI_DEAD_FOR=$older $newer" -- gate
# Anything that cannot prove the newer commits are CI-less: hold or fail.
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'diverged\n1\n%s' $newer)" -- gate
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n250\n%s' $newer)" -- gate
run 1 '' FAKE_HEAD=$newer FAKE_FAIL_GATE_COMPARE=1 -- gate
run 1 '' FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n1\n%s' $newer)" FAKE_FAIL_RUNS=1 -- gate
run 1 '' FAKE_FAIL_HEAD=1 -- gate
run 1 '' GITHUB_EVENT_NAME=workflow_dispatch FAKE_CI_COUNT=0 FAKE_HEAD=$sha -- gate
run 1 '' GITHUB_EVENT_NAME=workflow_dispatch FAKE_FAIL_CI=1 FAKE_HEAD=$sha -- gate
run 0 current=true GITHUB_EVENT_NAME=workflow_dispatch FAKE_CI_COUNT=1 FAKE_HEAD=$sha -- gate
run 1 '' RELEASE_SHA=main FAKE_HEAD=$sha -- gate

# target: holds, each with its evidence
run 0 api=false FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n2\nREADME.md\ndocs/a.mdx')" \
  -- target api exclude "$docs" $prefix
run 0 api=false FAKE_MARKER=$prefix$sha "FAKE_COMPARE=$(printf 'identical\n0')" \
  -- target api exclude "$docs" $prefix
run 0 api=false FAKE_MARKER=$prefix$newer "FAKE_COMPARE=$(printf 'behind\n0')" \
  -- target api exclude "$docs" $prefix
# The backend image's inputs, and nothing else, release it.
for path in packages/frontend/app/index.tsx packages/studio/src/x.ts README.md \
  .github/workflows/deploy-frontends.yml functions/x.ts scripts/x.mjs; do
  run 0 backend=false FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n1\n%s' "$path")" \
    -- target backend include "$backend" $prefix
done

# target: releases
run 0 api=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n2\nREADME.md\npackages/api/src/x.ts')" \
  -- target api exclude "$docs" $prefix
for path in packages/backend/src/x.ts packages/shared-types/src/x.ts packages/sdk/src/x.ts \
  packages/frontend/package.json package.json bun.lock bunfig.toml tsconfig.json \
  packages/backend/Dockerfile.dockerignore .github/workflows/deploy-aws.yml \
  .github/scripts/deploy-ecs-image.sh; do
  run 0 backend=true FAKE_MARKER=$prefix$older \
    "FAKE_COMPARE=$(printf 'ahead\n2\npackages/frontend/app/index.tsx\n%s' "$path")" \
    -- target backend include "$backend" $prefix
done
# A rename out of scope still counts the path it left.
run 0 backend=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n1\npackages/frontend/x.ts\npackages/backend/x.ts')" \
  -- target backend include "$backend" $prefix

# target: unsure, so release
run 0 api=true FAKE_MARKER= -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=${prefix}garbage -- target api exclude "$docs" $prefix
run 0 api=true FAKE_FAIL_MARKER=1 -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=$prefix$older FAKE_FAIL_COMPARE=1 -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'diverged\n1\nREADME.md')" \
  -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n300\nREADME.md')" \
  -- target api exclude "$docs" $prefix
run 0 api=true GITHUB_EVENT_NAME=workflow_dispatch FAKE_FAIL_MARKER=1 \
  -- target api exclude "$docs" $prefix

# usage errors
run 1 '' -- target api sideways "$docs" $prefix
run 1 '' -- target api exclude "$docs"
run 1 '' -- nonsense

if ((failures > 0)); then
  echo "test-deploy-scope: $failures case(s) failed"
  exit 1
fi
echo "test-deploy-scope: OK"
