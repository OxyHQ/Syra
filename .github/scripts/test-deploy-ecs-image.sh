#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

export DEPLOY_TEST_LOG=""
export DEPLOY_TEST_EXPECT_METRICS_ARN=false
# The SSM parameter path a case feeds to INTERNAL_METRICS_PARAMETER, and from
# which the mocked register-task-definition derives the ARN it demands. A case
# overrides it to cover a path shape the default does not.
export DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false
export DEPLOY_TEST_SERVICE_DESIRED_COUNT=1
export DEPLOY_TEST_ROLLOUT_SCENARIO=healthy

aws() {
  local service_json='{
    "failures": [],
    "services": [{
      "status": "ACTIVE",
      "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
      "desiredCount": 1,
      "networkConfiguration": {
        "awsvpcConfiguration": {
          "subnets": ["subnet-test"],
          "securityGroups": ["sg-test"]
        }
      },
      "launchType": "FARGATE",
      "deployments": [
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:2",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        },
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        }
      ]
    }]
  }'
  service_json="$(jq \
    --argjson desired "$DEPLOY_TEST_SERVICE_DESIRED_COUNT" \
    '.services[0].desiredCount = $desired' \
    <<<"$service_json")"
  # `absent-desired-count` DELETES the key rather than passing a sentinel. A
  # sentinel is a value the script can compare; the case under test is a field
  # ECS did not report at all, so a sentinel would pass for the wrong reason.
  if [[ "${DEPLOY_TEST_DELETE_DESIRED_COUNT:-false}" == "true" ]]; then
    service_json="$(jq 'del(.services[0].desiredCount)' <<<"$service_json")"
  fi

  case "$1 $2" in
    "ecs describe-services")
      local describe_count_file="${DEPLOY_TEST_LOG}.describe-count"
      local describe_count=0
      if [[ -f "$describe_count_file" ]]; then
        describe_count="$(<"$describe_count_file")"
      fi
      describe_count=$((describe_count + 1))
      printf '%s\n' "$describe_count" >"$describe_count_file"
      if [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "transient-zero-deployment" &&
            "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then
                .rolloutState = "IN_PROGRESS"
                | .desiredCount = 0
                | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "zero-service-during-deploy" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].desiredCount = 0
          | .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "completed-zero-deployment" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      fi
      printf '%s\n' "$service_json"
      ;;
    "ecs describe-task-definition")
      printf '%s\n' '{
        "family": "deploy-test",
        "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "cpu": "256",
        "memory": "512",
        "containerDefinitions": [{
          "name": "deploy-test",
          "image": "example.invalid/deploy-test:old",
          "essential": true,
          "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
              "awslogs-group": "/ecs/deploy-test",
              "awslogs-stream-prefix": "ecs"
            }
          }
        }]
      }'
      ;;
    "ecs register-task-definition")
      if [[ "$DEPLOY_TEST_EXPECT_METRICS_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # The verdict is written to the log rather than left to `set -e`. A
        # command that fails in the MIDDLE of this function does not abort the
        # run -- measured, and it holds whether the function is exported or
        # local -- because the caller consumes it as `v="$(aws ...)"` and only
        # the function's LAST command reaches that assignment's exit status. An
        # assertion whose only effect is its own exit status therefore cannot
        # fail, which is what this one did: pointing it at an ARN no case uses
        # left the suite green. Logging a distinct token instead puts the
        # mismatch in the expected.log diff, where it names itself.
        if jq -e \
          --arg expected \
          "arn:aws:ssm:test:123456789012:parameter${DEPLOY_TEST_METRICS_PARAMETER}" \
          '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "INTERNAL_METRICS_TOKEN" and
              .valueFrom == $expected
            )
        ' "$input_json" >/dev/null; then
          printf 'metrics:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'metrics:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_SECRET_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # Same reason as the metrics assertion above: log the verdict, do not
        # rely on this function's exit status.
        if jq -e '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "EXTRA_TASK_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"
            )
        ' "$input_json" >/dev/null; then
          printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-secret:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      printf '%s\n' "arn:aws:ecs:test:task-definition/deploy-test:2"
      ;;
    "ecs update-service")
      local previous_argument=""
      local task_definition=""
      local desired_count=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          task_definition="$argument"
        elif [[ "$previous_argument" == "--desired-count" ]]; then
          desired_count="$argument"
        fi
        previous_argument="$argument"
      done
      if [[ -z "$desired_count" ]]; then
        echo "Mocked update-service requires an explicit --desired-count." >&2
        return 1
      fi
      printf 'service:%s:desired=%s\n' \
        "$task_definition" \
        "$desired_count" \
        >>"$DEPLOY_TEST_LOG"
      printf '{}\n'
      ;;
    "ecs run-task")
      # Log the COMMAND, not a fixed token. The mock previously wrote
      # 'reconcile' for every run-task, which made the pre-deploy and
      # post-deploy tasks indistinguishable in the expected.log diff — so the
      # argv each one runs was asserted by nothing, and the hardcoded migration
      # command could point at a path this package does not emit (it did) with
      # every case still green.
      local previous_argument=""
      local overrides_json=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--overrides" ]]; then
          overrides_json="$argument"
          break
        fi
        previous_argument="$argument"
      done
      printf 'task:%s\n' \
        "$(jq -r '.containerOverrides[0].command | join(" ")' <<<"$overrides_json")" \
        >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "failures": [],
        "tasks": [{"taskArn": "arn:aws:ecs:test:task/deploy-test-reconcile"}]
      }'
      ;;
    "ecs describe-tasks")
      printf '{
        "failures": [],
        "tasks": [{
          "lastStatus": "STOPPED",
          "stoppedReason": "Essential container exited",
          "containers": [{
            "name": "deploy-test",
            "exitCode": %s
          }]
        }]
      }\n' "$DEPLOY_TEST_TASK_EXIT_CODE"
      ;;
    "logs get-log-events")
      printf 'tasklogs\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "events": [{
          "message": "[migration] fixture failure"
        }]
      }'
      ;;
    *)
      printf 'Unexpected mocked AWS call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f aws

# Vacuity floor. On success this suite prints ONE line, so a traversal that
# silently stopped after two cases is indistinguishable from a full green run --
# and every guarantee below would read as verified while never having executed.
# A `set -e` abort mid-file exits non-zero, but an early `return` from a helper,
# a case list truncated by a bad merge, or a rewrite that drops cases does not.
#
# Raise this with the case count; lower it ONLY alongside a deletion you can
# name. A floor quietly adjusted to match whatever ran is not a floor.
cases_run=0
MINIMUM_CASES=14

run_release() {
  cases_run=$((cases_run + 1))
  local case_name="$1"
  local expect_success="$2"
  # The pre-deploy one-shot command, as a JSON string array. Empty means the
  # release has no pre-deploy task at all, which is what every case that is not
  # about migrations wants.
  local pre_deploy_command_json="${3:-}"
  local inject_internal_metrics="${4:-false}"
  local task_exit_code="${5:-0}"
  local inject_task_secret="${6:-false}"
  local service_desired_count="${7:-1}"
  local rollout_scenario="${8:-healthy}"
  local smoke_exit_code="${9:-0}"
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  DEPLOY_TEST_SERVICE_DESIRED_COUNT="$service_desired_count"
  DEPLOY_TEST_ROLLOUT_SCENARIO="$rollout_scenario"
  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN
  export DEPLOY_TEST_SERVICE_DESIRED_COUNT
  export DEPLOY_TEST_ROLLOUT_SCENARIO

  # The generated smoke fixture expands DEPLOY_TEST_LOG when it runs; its exit
  # code is the entire interface deploy-ecs-image.sh reads, so each case picks
  # one. 75 is the "failed, but a rollback cannot repair it" code.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
    "exit $smoke_exit_code" \
    >"$smoke_script"

  local -a release_environment=(
    AWS_REGION=test
    AWS_ACCOUNT_ID=123456789012
    CLUSTER=deploy-test
    APP=deploy-test
    CONTAINER_NAME=deploy-test
    IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    MAX_WAIT_SECS=5
    POLL_INTERVAL=1
    PRE_DEPLOY_TASK_COMMAND_JSON="$pre_deploy_command_json"
    POST_DEPLOY_SMOKE_SCRIPT="$smoke_script"
    # `["reconcile"]` is a generic fixture: most cases care only that the post
    # slot runs in the right place in the sequence, not what it runs. A case
    # that IS about the command sets DEPLOY_TEST_POST_COMMAND.
    # `-` rather than `:-` on purpose: `:-` substitutes the default for an EMPTY
    # value as well as an unset one, so no case could express "this release has
    # no post-deploy task at all", which is a state the script branches on.
    POST_DEPLOY_TASK_COMMAND_JSON="${DEPLOY_TEST_POST_COMMAND-[\"reconcile\"]}"
  )
  if [[ "$inject_internal_metrics" == "true" ]]; then
    release_environment+=(
      INTERNAL_METRICS_PARAMETER="$DEPLOY_TEST_METRICS_PARAMETER"
    )
  fi
  if [[ "$inject_task_secret" == "true" ]]; then
    release_environment+=(
      TASK_SECRET_OVERRIDES_JSON='{"EXTRA_TASK_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"}'
    )
  fi

  if env "${release_environment[@]}" \
    bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
    >"$output_file" 2>&1; then
    if [[ "$expect_success" != "true" ]]; then
      echo "Expected $case_name to fail." >&2
      return 1
    fi
  elif [[ "$expect_success" == "true" ]]; then
    echo "Expected $case_name to succeed." >&2
    sed -n '1,240p' "$output_file" >&2
    return 1
  fi
}

run_release success true '' true
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'task:reconcile' \
  >"$test_directory/success/expected.log"
diff -u \
  "$test_directory/success/expected.log" \
  "$test_directory/success/aws.log"

# A hyphen in the parameter path is its own case because it is its own bug: the
# bracket expression validating this name once matched every character EXCEPT a
# hyphen, so an app whose path had none deployed and an app whose path had one
# did not -- and the only repo with a smoke fixture at the time was one of the
# former, which is why nothing here caught it.
#
# KEEP BOTH, and keep the plain one's app segment hyphen-FREE. That asymmetry is
# the entire test: rename them to two spellings that both contain a hyphen and
# this pair silently stops discriminating, while the suite still passes and still
# goes red under a mutation -- just for the wrong case.
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sample-app/INTERNAL_METRICS_TOKEN
run_release hyphenated-metrics-parameter true '' true
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'task:reconcile' \
  >"$test_directory/hyphenated-metrics-parameter/expected.log"
diff -u \
  "$test_directory/hyphenated-metrics-parameter/expected.log" \
  "$test_directory/hyphenated-metrics-parameter/aws.log"

run_release explicit-task-secret true '' false 0 true
printf '%s\n' \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'task:reconcile' \
  >"$test_directory/explicit-task-secret/expected.log"
diff -u \
  "$test_directory/explicit-task-secret/expected.log" \
  "$test_directory/explicit-task-secret/aws.log"

run_release reconciliation-failure false '' false 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'task:reconcile' \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/reconciliation-failure/expected.log"
diff -u \
  "$test_directory/reconciliation-failure/expected.log" \
  "$test_directory/reconciliation-failure/aws.log"

# The migration cases below run the commands PRODUCTION runs, read out of
# deploy-aws.yml rather than restated here. A second copy would let the two drift
# in exactly the way that left `dist/scripts/migrate.js` — a path this package
# has never emitted — wired into this script with every test green.
workflow_file="$repository_root/.github/workflows/deploy-aws.yml"
# Read one command out of deploy-aws.yml. The values are no longer step `env:`
# keys: since the workflow gained its `migration_phase` input they are written to
# $GITHUB_ENV by whichever of two mutually exclusive selector steps runs, so the
# same variable name legitimately appears more than once and the PHASE is what
# identifies which occurrence this is. Matching on the phase rather than on
# position keeps the "declared exactly once" check meaningful — reordering the
# selectors or adding a third cannot silently satisfy it.
read_workflow_command() {
  local variable_name="$1"
  local expected_phase="$2"
  local value

  value="$(sed -n -E \
    "s/^[[:space:]]*echo '${variable_name}=(\[.*\"--phase=${expected_phase}\".*\])'[[:space:]]*$/\1/p" \
    "$workflow_file")"
  if [[ -z "$value" ]]; then
    echo "deploy-aws.yml declares no $variable_name for --phase=$expected_phase." >&2
    return 1
  fi
  if [[ "$(wc -l <<<"$value")" != "1" ]]; then
    echo "deploy-aws.yml declares $variable_name for --phase=$expected_phase more than once." >&2
    return 1
  fi
  if ! jq -e '
    type == "array" and
    length > 0 and
    all(.[]; type == "string" and length > 0)
  ' <<<"$value" >/dev/null; then
    echo "deploy-aws.yml's $variable_name is not a non-empty JSON string array: $value" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

workflow_pre_command="$(read_workflow_command PRE_DEPLOY_TASK_COMMAND_JSON pre)"
workflow_post_command="$(read_workflow_command POST_DEPLOY_TASK_COMMAND_JSON post)"
# The cutover's own pre-deploy command. It runs against PRODUCTION exactly once —
# the genesis apply, where `pre` and `post` both block — so it is the argv least
# likely to be exercised before it matters and the one most worth holding to the
# same entry-point and target-database checks as the phased pair.
workflow_cutover_command="$(read_workflow_command PRE_DEPLOY_TASK_COMMAND_JSON all)"

# Every migration command must name a compiled entry point that EXISTS in
# source. The check maps the runtime path back through tsconfig's layout
# (rootDir "./", outDir "dist") — packages/backend/dist/src/db/migrate.js is
# emitted from packages/backend/src/db/migrate.ts — so moving or renaming the
# migrator fails here instead of in a production deploy. The build is not run,
# and does not need to be: what makes a stale path detectable is the SOURCE
# vanishing, not the artefact.
#
# Mutation-tested: pointing either command at dist/scripts/migrate.js (the value
# this file shipped before) fails this check by name.
assert_migration_command() {
  local label="$1"
  local command_json="$2"
  local expected_phase="$3"
  local runtime_path source_path

  runtime_path="$(jq -r '.[1] // ""' <<<"$command_json")"
  if [[ "$runtime_path" != packages/backend/dist/*.js ]]; then
    echo "$label does not run a compiled backend entry point: $runtime_path" >&2
    return 1
  fi
  source_path="${runtime_path/\/dist\//\/}"
  source_path="${source_path%.js}.ts"
  if [[ ! -f "$repository_root/$source_path" ]]; then
    echo "$label runs $runtime_path, which is emitted from $source_path — and that file does not exist." >&2
    return 1
  fi
  if ! jq -e --arg phase "--phase=$expected_phase" 'index($phase) != null' \
    <<<"$command_json" >/dev/null; then
    echo "$label does not pass --phase=$expected_phase." >&2
    return 1
  fi
  # Named explicitly so a migration aimed at the wrong database is refused on
  # the connection rather than reporting success over an untouched one; the
  # migrator requires it, and `syra` is the database provisioned on
  # oxy-postgres for this app.
  if ! jq -e 'index("--target-database=syra") != null' <<<"$command_json" >/dev/null; then
    echo "$label does not pass --target-database=syra." >&2
    return 1
  fi
}

assert_migration_command PRE_DEPLOY_TASK_COMMAND_JSON "$workflow_pre_command" pre
assert_migration_command POST_DEPLOY_TASK_COMMAND_JSON "$workflow_post_command" post
assert_migration_command 'PRE_DEPLOY_TASK_COMMAND_JSON (cutover)' "$workflow_cutover_command" all

# The cutover selector must leave the post-deploy command EMPTY, which is how
# this script is told to skip that task. It is checked here, and not only in the
# workflow's own test, because the meaning of an empty value is defined by THIS
# script: the `all` run has already applied the whole journal, so a post task
# could only find nothing pending and turn a green cutover red.
if ! grep -qE "^[[:space:]]*echo 'POST_DEPLOY_TASK_COMMAND_JSON='$" "$workflow_file"; then
  echo "deploy-aws.yml's cutover path does not clear POST_DEPLOY_TASK_COMMAND_JSON." >&2
  exit 1
fi

# A failing pre-deploy migration must abort the release BEFORE update-service,
# leaving the previously deployed image serving and nothing to roll back.
run_release migration-failure false "$workflow_pre_command" false 1
printf '%s\n' \
  "task:$(jq -r 'join(" ")' <<<"$workflow_pre_command")" \
  tasklogs \
  >"$test_directory/migration-failure/expected.log"
diff -u \
  "$test_directory/migration-failure/expected.log" \
  "$test_directory/migration-failure/aws.log"
grep -F \
  "[migration] fixture failure" \
  "$test_directory/migration-failure/output.log" \
  >/dev/null
if grep -q '^service:' "$test_directory/migration-failure/aws.log"; then
  echo "Failed migration reached update-service." >&2
  exit 1
fi

# The healthy release: pre-deploy migration, rollout, smoke, post-deploy
# migration — in that order, and each with the argv the workflow declares.
DEPLOY_TEST_POST_COMMAND="$workflow_post_command"
export DEPLOY_TEST_POST_COMMAND
run_release migration-success true "$workflow_pre_command"
unset DEPLOY_TEST_POST_COMMAND
printf '%s\n' \
  "task:$(jq -r 'join(" ")' <<<"$workflow_pre_command")" \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  "task:$(jq -r 'join(" ")' <<<"$workflow_post_command")" \
  >"$test_directory/migration-success/expected.log"
diff -u \
  "$test_directory/migration-success/expected.log" \
  "$test_directory/migration-success/aws.log"

# syra is not parked today, but the guard this replaces is the one that blocked
# every other repo's cutover: a service held at desiredCount 0 could not land the
# image that would make it bootable again.
#
# The exact log is the whole assertion, and what it does NOT contain matters more
# than what it does. Compare `migration-success` directly above -- the SAME
# release at desired=1 -- where `service:` is followed by `smoke` and the POST
# task. Here the log must STOP at `service:`, because neither is real when
# nothing is running: a smoke check measures the hold rather than the image, and
# the POST task is this repo's `post` migration, which drops and narrows with no
# healthy image to confirm it. `diff -u` fails if either appears.
DEPLOY_TEST_POST_COMMAND="$workflow_post_command"
export DEPLOY_TEST_POST_COMMAND
run_release zero-desired-count true "$workflow_pre_command" false 0 false 0
unset DEPLOY_TEST_POST_COMMAND
printf '%s\n' \
  "task:$(jq -r 'join(" ")' <<<"$workflow_pre_command")" \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=0' \
  >"$test_directory/zero-desired-count/expected.log"
diff -u \
  "$test_directory/zero-desired-count/expected.log" \
  "$test_directory/zero-desired-count/aws.log"
# `service:...deploy-test:2:...` is the REPOINT, and it is the half that is easy
# to drop: registering a revision does not point the service at it, so without
# this line a later scale-up would launch the OLD image and every subsequent
# deploy would render from the stale revision.
grep -F \
  "service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=0" \
  "$test_directory/zero-desired-count/aws.log" \
  >/dev/null
grep -F \
  "NO ROLLOUT PERFORMED: ECS service deploy-test is at desiredCount=0" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
grep -F \
  "NO ROLLOUT PERFORMED: the task definition WAS registered and the service now points at it: arn:aws:ecs:test:task-definition/deploy-test:2" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
# Syra-specific, and the reason this case differs from the other four repos'.
grep -F \
  "NO ROLLOUT PERFORMED: the post-deploy one-shot was NOT run" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
# The success line of an ordinary release. If it ever appears here, a reader of
# the workflow log six weeks from now cannot tell this run apart from one that
# actually shipped, which is the failure this whole case exists to prevent.
if grep -qF \
  "ECS rollout reached a healthy steady state" \
  "$test_directory/zero-desired-count/output.log"; then
  echo "A zero-capacity release claimed a healthy rollout it never performed." >&2
  exit 1
fi

# A release with NO post-deploy task must not claim one was skipped. Without
# this, the warning could be printed unconditionally and read as true.
DEPLOY_TEST_POST_COMMAND="" \
  run_release zero-desired-count-no-post true "$workflow_pre_command" false 0 false 0
if grep -qF \
  "the post-deploy one-shot was NOT run" \
  "$test_directory/zero-desired-count-no-post/output.log"; then
  echo "A release with no post-deploy task claimed one was skipped." >&2
  exit 1
fi

# ABSENCE IS NOT ZERO, and the ORDER of the two checks is what enforces it:
# `(( "" < 1 ))` is TRUE in bash, so an unreadable count reaching the zero branch
# would take the held-down-carry-on path and exit 0 on an API failure. Today the
# property holds only because the numeric test runs first -- which is exactly why
# it needs a test that holds it deliberately.
#
# The key is DELETED rather than set to a sentinel: a sentinel is a value the
# script can compare, and the case under test is a field that is not there.
DEPLOY_TEST_DELETE_DESIRED_COUNT=true \
  run_release absent-desired-count false '' false 0 false 0
grep -F \
  "reported a non-numeric desiredCount" \
  "$test_directory/absent-desired-count/output.log" \
  >/dev/null
if [[ -s "$test_directory/absent-desired-count/aws.log" ]]; then
  echo "A service with an unreadable desiredCount reached a mutating AWS call." >&2
  exit 1
fi

run_release transient-zero-deployment true '' false 0 false 1 transient-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'task:reconcile' \
  >"$test_directory/transient-zero-deployment/expected.log"
diff -u \
  "$test_directory/transient-zero-deployment/expected.log" \
  "$test_directory/transient-zero-deployment/aws.log"
grep -F \
  "has not assigned desired tasks" \
  "$test_directory/transient-zero-deployment/output.log" \
  >/dev/null

run_release zero-service-during-deploy false '' false 0 false 1 zero-service-during-deploy
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/zero-service-during-deploy/expected.log"
diff -u \
  "$test_directory/zero-service-during-deploy/expected.log" \
  "$test_directory/zero-service-during-deploy/aws.log"
grep -F \
  "service deploy-test reached desiredCount=0 during the deployment rollout" \
  "$test_directory/zero-service-during-deploy/output.log" \
  >/dev/null

run_release completed-zero-deployment false '' false 0 false 1 completed-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/completed-zero-deployment/expected.log"
diff -u \
  "$test_directory/completed-zero-deployment/expected.log" \
  "$test_directory/completed-zero-deployment/aws.log"
grep -F \
  "completed at desiredCount=0; refusing to accept a zero-task steady state" \
  "$test_directory/completed-zero-deployment/output.log" \
  >/dev/null

# A smoke failure the smoke script attributes to the new image rolls the service
# back, and stops the release before the reconciliation task runs.
run_release smoke-hermetic-failure false '' false 0 false 1 healthy 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/smoke-hermetic-failure/expected.log"
diff -u \
  "$test_directory/smoke-hermetic-failure/expected.log" \
  "$test_directory/smoke-hermetic-failure/aws.log"
grep -F \
  "Post-deploy smoke checks failed." \
  "$test_directory/smoke-hermetic-failure/output.log" \
  >/dev/null

# A smoke failure the smoke script attributes to something outside the new image
# (exit 75) must NOT roll back: the service stays on the new task definition, the
# release finishes its reconciliation task, and the job still fails so the
# failure is paged rather than swallowed.
run_release smoke-no-rollback-failure false '' false 0 false 1 healthy 75
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'task:reconcile' \
  >"$test_directory/smoke-no-rollback-failure/expected.log"
diff -u \
  "$test_directory/smoke-no-rollback-failure/expected.log" \
  "$test_directory/smoke-no-rollback-failure/aws.log"
if grep -qF \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:' \
  "$test_directory/smoke-no-rollback-failure/aws.log"; then
  echo "A smoke failure that cannot be repaired by a rollback rolled back anyway." >&2
  exit 1
fi
grep -F \
  "stays on arn:aws:ecs:test:task-definition/deploy-test:2" \
  "$test_directory/smoke-no-rollback-failure/output.log" \
  >/dev/null
grep -F \
  "Nothing was rolled back; this release needs a human." \
  "$test_directory/smoke-no-rollback-failure/output.log" \
  >/dev/null

if (( cases_run < MINIMUM_CASES )); then
  echo "ASSERTION FAILED: only $cases_run release cases ran, expected at least $MINIMUM_CASES." >&2
  echo "The suite exited green without executing everything it claims to check." >&2
  exit 1
fi

echo "Deployment script transaction tests passed ($cases_run release cases)."
