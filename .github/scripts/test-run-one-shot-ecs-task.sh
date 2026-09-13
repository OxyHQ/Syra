#!/usr/bin/env bash
#
# Offline coverage for run-one-shot-ecs-task.sh: a mocked `aws` CLI, no network,
# no real ECS. Lighter than test-deploy-ecs-image.sh's harness on purpose — this
# script never registers a task definition, never updates the service and never
# rolls back, so the scenario matrix that harness exists for (rollout races,
# zero-capacity deploys, rollback-after-rollback) has no counterpart here. What
# it DOES need covering: it must refuse an inactive service, it must poll a
# running task to completion, it must report a non-zero container exit as a
# failure, and it must time out loudly rather than hang forever.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script_under_test="$repository_root/.github/scripts/run-one-shot-ecs-task.sh"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* &&
        -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

export TEST_STATE_DIR=""
export TEST_SERVICE_STATUS=ACTIVE
export TEST_RUN_TASK_FAILS=false
export TEST_TASK_EXIT_CODE=0
# How many `describe-tasks` calls before the mock reports STOPPED — 2 exercises
# the poll loop actually polling (RUNNING once, then STOPPED), not just the
# degenerate one-call case.
export TEST_STOPS_AFTER=2

aws() {
  case "$1 $2" in
    "ecs describe-services")
      if [[ "$TEST_SERVICE_STATUS" != "ACTIVE" ]]; then
        printf '%s\n' "{\"failures\":[],\"services\":[{\"status\":\"$TEST_SERVICE_STATUS\"}]}"
      else
        printf '%s\n' '{
          "failures": [],
          "services": [{
            "status": "ACTIVE",
            "taskDefinition": "arn:aws:ecs:test:task-definition/one-shot-test:1",
            "networkConfiguration": {
              "awsvpcConfiguration": {"subnets": ["subnet-test"], "securityGroups": ["sg-test"]}
            },
            "launchType": "FARGATE",
            "capacityProviderStrategy": []
          }]
        }'
      fi
      ;;
    "ecs describe-task-definition")
      printf '%s\n' '{
        "containerDefinitions": [{
          "name": "syra",
          "logConfiguration": {
            "options": {"awslogs-group": "/ecs/syra", "awslogs-stream-prefix": "syra"}
          }
        }]
      }'
      ;;
    "ecs run-task")
      if [[ "$TEST_RUN_TASK_FAILS" == "true" ]]; then
        printf '%s\n' '{"failures":[{"reason":"simulated capacity failure"}],"tasks":[]}'
      else
        printf '%s\n' '{"failures":[],"tasks":[{"taskArn":"arn:aws:ecs:test:task/oxy-cluster/abc123"}]}'
      fi
      ;;
    "ecs describe-tasks")
      local count_file="$TEST_STATE_DIR/describe-count"
      local count=0
      [[ -f "$count_file" ]] && count="$(<"$count_file")"
      count=$((count + 1))
      printf '%s\n' "$count" >"$count_file"
      if (( count >= TEST_STOPS_AFTER )); then
        printf '%s\n' "{
          \"failures\": [],
          \"tasks\": [{
            \"lastStatus\": \"STOPPED\",
            \"stoppedReason\": \"Essential container exited\",
            \"containers\": [{\"name\": \"syra\", \"exitCode\": $TEST_TASK_EXIT_CODE, \"reason\": \"exited\"}]
          }]
        }"
      else
        printf '%s\n' '{"failures":[],"tasks":[{"lastStatus":"RUNNING"}]}'
      fi
      ;;
    "logs get-log-events")
      printf '%s\n' '{"events":[{"message":"line one"},{"message":"line two"}]}'
      ;;
    *)
      echo "UNEXPECTED aws call: $*" >&2
      return 1
      ;;
  esac
}
export -f aws

run_case() {
  local name="$1"
  local expected_exit="$2"
  shift 2
  local case_dir="$test_directory/$name"
  mkdir -p "$case_dir"
  export TEST_STATE_DIR="$case_dir"

  local actual_exit=0
  AWS_REGION=test CLUSTER=oxy-cluster APP=syra \
    "$@" \
    bash "$script_under_test" >"$case_dir/output.log" 2>&1 || actual_exit=$?

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    echo "FAIL [$name]: expected exit $expected_exit, got $actual_exit" >&2
    cat "$case_dir/output.log" >&2
    exit 1
  fi
  echo "ok [$name]"
}

assert_output_contains() {
  local name="$1"
  local needle="$2"
  if ! grep -qF -- "$needle" "$test_directory/$name/output.log"; then
    echo "FAIL [$name]: output does not contain: $needle" >&2
    cat "$test_directory/$name/output.log" >&2
    exit 1
  fi
}

# ── Happy path: the poll loop actually polls, then reports success ─────────
TEST_SERVICE_STATUS=ACTIVE TEST_TASK_EXIT_CODE=0 TEST_STOPS_AFTER=2 \
  run_case success 0 \
    env COMMAND_JSON='["node","packages/backend/dist/src/scripts/backfillEpisodeImages.js","--dry-run"]' \
    MAX_WAIT_SECS=30 POLL_INTERVAL=1
assert_output_contains success "task status=RUNNING"
assert_output_contains success "task status=STOPPED"
assert_output_contains success "line one"
assert_output_contains success "Task completed successfully"

# ── Refuses an inactive service, before ever calling run-task ──────────────
TEST_SERVICE_STATUS=DRAINING \
  run_case inactive-service 1 \
    env COMMAND_JSON='["node","x.js"]' MAX_WAIT_SECS=30 POLL_INTERVAL=1
assert_output_contains inactive-service "not ACTIVE"

# ── A non-zero container exit is a failure, and the logs still print ───────
TEST_SERVICE_STATUS=ACTIVE TEST_TASK_EXIT_CODE=1 TEST_STOPS_AFTER=1 \
  run_case task-failed 1 \
    env COMMAND_JSON='["node","x.js"]' MAX_WAIT_SECS=30 POLL_INTERVAL=1
assert_output_contains task-failed "exit=1"
assert_output_contains task-failed "line one"

# ── ECS itself refuses to start the task (e.g. no capacity) ────────────────
TEST_SERVICE_STATUS=ACTIVE TEST_RUN_TASK_FAILS=true \
  run_case run-task-refused 1 \
    env COMMAND_JSON='["node","x.js"]' MAX_WAIT_SECS=30 POLL_INTERVAL=1
assert_output_contains run-task-refused "refused to start"

# ── A malformed command is refused before any aws call is made ─────────────
TEST_SERVICE_STATUS=ACTIVE \
  run_case bad-command 1 \
    env COMMAND_JSON='"not-an-array"' MAX_WAIT_SECS=30 POLL_INTERVAL=1
assert_output_contains bad-command "must be a non-empty JSON string array"

# ── Never reaches STOPPED: times out loudly instead of hanging ─────────────
TEST_SERVICE_STATUS=ACTIVE TEST_STOPS_AFTER=999999 \
  run_case timeout 1 \
    env COMMAND_JSON='["node","x.js"]' MAX_WAIT_SECS=2 POLL_INTERVAL=1
assert_output_contains timeout "did not stop within"

echo "All run-one-shot-ecs-task.sh cases passed."
