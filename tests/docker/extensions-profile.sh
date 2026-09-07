#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/../.."

compose=(docker compose -f docker-compose.yml -f tests/docker/extensions-profile.override.yml)
project="moira-extension-profile-$$"

cleanup() {
  "${compose[@]}" -p "$project" --profile extensions down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

default_services=$("${compose[@]}" config --services)
if [[ "$default_services" != "moira" ]]; then
  printf 'Default Compose selection unexpectedly contains:\n%s\n' "$default_services" >&2
  exit 1
fi

profile_services=$("${compose[@]}" --profile extensions config --services | sort)
if [[ "$profile_services" != $'moira\nmoira-extension-runner' ]]; then
  printf 'Extensions profile resolved unexpected services:\n%s\n' "$profile_services" >&2
  exit 1
fi

"${compose[@]}" --profile extensions config --format json | node --input-type=module -e '
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const dependency = config.services.moira.depends_on["moira-extension-runner"];
  if (dependency.condition !== "service_healthy" || dependency.required !== false) process.exit(1);
'

"${compose[@]}" -p "$project" --profile extensions build moira-extension-runner
"${compose[@]}" -p "$project" --profile extensions up -d moira-extension-runner

container=$("${compose[@]}" -p "$project" --profile extensions ps -q moira-extension-runner)
for _ in {1..40}; do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == "healthy" ]]; then
    break
  fi
  sleep 1
done

if [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") != "healthy" ]]; then
  docker logs "$container" >&2
  exit 1
fi

docker exec "$container" node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:9110/health");
  const health = await response.json();
  if (health.apiVersion !== "moira.extension-runner/v2") process.exit(1);
  if (!health.ready || health.rejected.length !== 0) process.exit(1);
  if (health.extensions.length !== 1) process.exit(1);
  const extension = health.extensions[0];
  if (extension.name !== "webhook-notify") process.exit(1);
  if (!extension.nodeTypes.includes("webhook-notify.post-message")) process.exit(1);
  if (!extension.communicationChannelIds.includes("webhook-notify.notifications")) process.exit(1);
'

if docker exec "$container" touch /app/extensions/write-probe 2>/dev/null; then
  echo "Extension bundle mount is writable" >&2
  exit 1
fi

echo "Extension Compose profile is default-off and loads the reference bundle read-only."
