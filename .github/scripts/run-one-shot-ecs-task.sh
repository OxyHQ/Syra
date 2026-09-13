#!/usr/bin/env bash
#
# Run ONE ad hoc command against the CURRENTLY DEPLOYED image, as a one-off ECS
# task — for a backfill or other maintenance script, not a deploy.
#
# Deliberately does NOT register a new task definition. `deploy-ecs-image.sh`'s
# one-shot migration tasks do, because that script exists to roll a NEW image
# and secrets out; this one runs against whatever is already live, which
# already carries the correct image and the DATABASE_URL secret the regular
# deploy synced. Re-registering here would be a second, redundant path to the
# exact same task definition the service already points at, with more ways to
# drift from it.
#
# Network configuration, launch type and capacity provider strategy are read
# LIVE off the service, same as deploy-ecs-image.sh's one-shot tasks, rather
# than hardcoded — this repo's subnets/security groups are infra state, not
# something a script should know a second copy of.
#
# Requires the same IAM actions the migration one-shot tasks already exercise
# (ecs:DescribeServices, ecs:DescribeTaskDefinition, ecs:RunTask,
# ecs:DescribeTasks, logs:GetLogEvents) — no new permissions.

set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${APP:?APP is required}"
: "${COMMAND_JSON:?COMMAND_JSON is required}"

CONTAINER_NAME="${CONTAINER_NAME:-$APP}"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-3600}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"

if ! [[ "$MAX_WAIT_SECS" =~ ^[0-9]+$ ]] || (( MAX_WAIT_SECS < 1 )); then
  echo "::error::MAX_WAIT_SECS must be a positive integer."
  exit 1
fi
if ! [[ "$POLL_INTERVAL" =~ ^[0-9]+$ ]] || (( POLL_INTERVAL < 1 )); then
  echo "::error::POLL_INTERVAL must be a positive integer."
  exit 1
fi
if ! jq -e '
  type == "array" and
  length > 0 and
  all(.[]; type == "string" and length > 0)
' <<<"$COMMAND_JSON" >/dev/null; then
  echo "::error::COMMAND_JSON must be a non-empty JSON string array."
  exit 1
fi

service_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$APP")"
if [[ "$(jq '.failures | length' <<<"$service_json")" != "0" ||
      "$(jq '.services | length' <<<"$service_json")" != "1" ]]; then
  echo "::error::ECS did not return exactly one service named $APP."
  jq '.failures' <<<"$service_json"
  exit 1
fi
service_status="$(jq -r '.services[0].status // "NONE"' <<<"$service_json")"
if [[ "$service_status" != "ACTIVE" ]]; then
  echo "::error::ECS service $APP is not ACTIVE (status: $service_status)."
  exit 1
fi

task_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")"
if [[ -z "$task_definition" ]]; then
  echo "::error::ECS service $APP has no task definition."
  exit 1
fi

network_configuration="$(jq -c '.services[0].networkConfiguration' <<<"$service_json")"
if [[ -z "$network_configuration" || "$network_configuration" == "null" ]]; then
  echo "::error::ECS service $APP has no network configuration."
  exit 1
fi

run_task_args=(
  ecs run-task
  --cluster "$CLUSTER"
  --task-definition "$task_definition"
  --count 1
  --network-configuration "$network_configuration"
)

capacity_provider_strategy="$(jq -c '.services[0].capacityProviderStrategy // []' <<<"$service_json")"
if [[ "$capacity_provider_strategy" != "[]" ]]; then
  run_task_args+=(--capacity-provider-strategy "$capacity_provider_strategy")
else
  launch_type="$(jq -r '.services[0].launchType // "FARGATE"' <<<"$service_json")"
  run_task_args+=(--launch-type "$launch_type")
  platform_version="$(jq -r '.services[0].platformVersion // empty' <<<"$service_json")"
  if [[ -n "$platform_version" ]]; then
    run_task_args+=(--platform-version "$platform_version")
  fi
fi

task_definition_json="$(aws ecs describe-task-definition --task-definition "$task_definition" --query taskDefinition)"
container_matches="$(jq --arg name "$CONTAINER_NAME" '[.containerDefinitions[] | select(.name == $name)] | length' <<<"$task_definition_json")"
if [[ "$container_matches" != "1" ]]; then
  available_containers="$(jq -r '[.containerDefinitions[].name] | join(", ")' <<<"$task_definition_json")"
  echo "::error::Expected exactly one container named $CONTAINER_NAME; found $container_matches. Available: $available_containers"
  exit 1
fi
log_group="$(jq -r --arg name "$CONTAINER_NAME" '
  .containerDefinitions[] | select(.name == $name) | .logConfiguration.options["awslogs-group"] // empty
' <<<"$task_definition_json")"
log_stream_prefix="$(jq -r --arg name "$CONTAINER_NAME" '
  .containerDefinitions[] | select(.name == $name) | .logConfiguration.options["awslogs-stream-prefix"] // empty
' <<<"$task_definition_json")"

overrides="$(jq -cn \
  --arg name "$CONTAINER_NAME" \
  --argjson command "$COMMAND_JSON" \
  '{containerOverrides: [{name: $name, command: $command}]}')"

echo "Running against the LIVE task definition $task_definition (no new revision registered): $COMMAND_JSON"
if ! run_json="$(aws "${run_task_args[@]}" --overrides "$overrides")"; then
  echo "::error::ECS failed to start the task."
  exit 1
fi
if [[ "$(jq '.failures | length' <<<"$run_json")" != "0" ]]; then
  echo "::error::ECS refused to start the task."
  jq '.failures' <<<"$run_json"
  exit 1
fi

task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_json")"
if [[ -z "$task_arn" ]]; then
  echo "::error::ECS returned no task ARN."
  exit 1
fi
echo "Started task $task_arn"

elapsed=0
last_status="RUNNING"
while (( elapsed < MAX_WAIT_SECS )); do
  task_json="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn")"
  if [[ "$(jq '.failures | length' <<<"$task_json")" != "0" ]]; then
    echo "::error::ECS could not describe the task."
    jq '.failures' <<<"$task_json"
    exit 1
  fi
  last_status="$(jq -r '.tasks[0].lastStatus // "MISSING"' <<<"$task_json")"
  echo "($elapsed s) task status=$last_status"
  if [[ "$last_status" == "STOPPED" ]]; then
    break
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

if [[ "$last_status" != "STOPPED" ]]; then
  echo "::error::Task did not stop within ${MAX_WAIT_SECS}s. This role cannot call ecs:StopTask; task $task_arn may still be running."
  exit 1
fi

exit_code="$(jq -r --arg name "$CONTAINER_NAME" '
  .tasks[0].containers[] | select(.name == $name) | .exitCode // -1
' <<<"$task_json")"

# Logged regardless of outcome: this is an on-demand run somebody is watching
# for its output (backfill stats), not a deploy step that only needs the logs
# when something goes wrong.
task_id="${task_arn##*/}"
if [[ -n "$log_group" && -n "$log_stream_prefix" ]]; then
  log_stream="$log_stream_prefix/$CONTAINER_NAME/$task_id"
  echo "::group::Task logs"
  if ! aws logs get-log-events \
    --log-group-name "$log_group" \
    --log-stream-name "$log_stream" \
    --limit 1000 \
    --start-from-head \
    | jq -r '.events[]?.message'; then
    echo "::warning::Unable to read CloudWatch logs for task $task_arn."
  fi
  echo "::endgroup::"
else
  echo "::warning::Unable to derive the CloudWatch log stream for task $task_arn."
fi

if [[ "$exit_code" != "0" ]]; then
  stopped_reason="$(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$task_json")"
  container_reason="$(jq -r --arg name "$CONTAINER_NAME" '
    .tasks[0].containers[] | select(.name == $name) | .reason // "unknown"
  ' <<<"$task_json")"
  echo "::error::Task failed (exit=$exit_code, stopped=$stopped_reason, container=$container_reason)."
  exit 1
fi

echo "Task completed successfully"
