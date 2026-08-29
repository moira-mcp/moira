#!/bin/sh
set -eu

IMAGE=${MOIRA_TEST_IMAGE:-mcp-moira:latest}
ROOT=$(mktemp -d)
PROJECT="moira-reconcile-$$"
COMPOSE="$ROOT/docker-compose.yml"
DATA="$ROOT/data"
FLOW="$ROOT/catalog/flows/reconciliation-test.json"
CONTAINER="$PROJECT-moira-1"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  docker compose -p "$PROJECT" -f "$COMPOSE" down --remove-orphans >/dev/null 2>&1 || true
  docker run --rm -v "$DATA:/app/data" --entrypoint chown "$IMAGE" \
    -R "$(id -u):$(id -g)" /app/data >/dev/null 2>&1 || true
  if ! rm -rf -- "$ROOT"; then
    printf '%s\n' "Failed to remove reconciliation test directory: $ROOT" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$DATA" "$(dirname "$FLOW")"

write_flow() {
  version=$1
  directive=$2
  description=$3
  {
    printf '%s\n' '{'
    printf '%s\n' '  "id": "f2f77571-1c0e-4f31-915f-31092382994f",'
    printf '%s\n' '  "owner": "system-moira",'
    printf '%s\n' '  "slug": "reconciliation-docker-test",'
    printf '%s\n' '  "visibility": "public",'
    printf '  "metadata": {"name":"Reconciliation Docker Test","version":"%s","description":"%s"},\n' "$version" "$description"
    printf '%s\n' '  "nodes": ['
    printf '%s\n' '    {"id":"start","type":"start","connections":{"default":"work"}},'
    printf '    {"id":"work","type":"agent-directive","directive":"%s","completionCondition":"done","connections":{"success":"end"}},\n' "$directive"
    printf '%s\n' '    {"id":"end","type":"end"}'
    printf '%s\n' '  ]'
    printf '%s\n' '}'
  } >"$FLOW"
}

{
  printf '%s\n' 'services:'
  printf '%s\n' '  moira:'
  printf '    image: %s\n' "$IMAGE"
  printf '%s\n' '    restart: "on-failure:3"'
  printf '%s\n' '    environment:'
  printf '%s\n' '      DEPLOYMENT_MODE: self-host'
  printf '%s\n' '      WORKFLOWS_DIR: /test-catalog'
  printf '%s\n' '      DB_PATH: /app/data/moira.db'
  printf '%s\n' '      MOIRA_HOST: localhost'
  printf '%s\n' '      BETTER_AUTH_SECRET: reconciliation-test-secret-32-characters'
  printf '%s\n' '      TELEGRAM_ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  printf '%s\n' '      ENCRYPTION_KEY: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  printf '%s\n' '      ADMIN_EMAIL: admin@moira.local'
  printf '%s\n' '      ADMIN_PASSWORD: ReconciliationTest123'
  printf '%s\n' '      EMAIL_PROVIDER: test'
  printf '%s\n' '    volumes:'
  printf '      - %s:/app/data\n' "$DATA"
  printf '      - %s:/test-catalog:ro\n' "$(dirname "$(dirname "$FLOW")")"
} >"$COMPOSE"

wait_for_file() {
  container=$1
  file=$2
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    docker exec "$container" test -f "$file" 2>/dev/null && return 0
    running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || printf false)
    [ "$running" = true ] || return 1
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

wait_for_stopped() {
  container=$1
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || printf false)
    [ "$running" = true ] || return 0
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

fail() {
  printf '%s\n' "Self-host reconciliation lifecycle failed: $*" >&2
  docker logs "$CONTAINER" >&2 2>&1 || true
  exit 1
}

data_command() {
  entrypoint=$1
  shift
  docker run --rm -v "$DATA:/app/data" --entrypoint "$entrypoint" "$IMAGE" "$@"
}

write_flow "1.0.0" "baseline" "Baseline catalog"
docker compose -p "$PROJECT" -f "$COMPOSE" up -d moira
wait_for_file "$CONTAINER" /tmp/init-success
docker exec "$CONTAINER" /app/scripts/health-check.sh
docker compose -p "$PROJECT" -f "$COMPOSE" stop moira

docker run --rm -v "$DATA:/app/data" --entrypoint sqlite3 "$IMAGE" /app/data/moira.db \
  "UPDATE workflow SET graph=json_set(graph,'$.nodes[1].directive','local-customization') WHERE slug='reconciliation-docker-test';"
BEFORE=$(docker run --rm -v "$DATA:/app/data" --entrypoint sqlite3 "$IMAGE" /app/data/moira.db .dump | sha256sum)

write_flow "2.0.0" "incoming-change" "Incoming catalog"
docker compose -p "$PROJECT" -f "$COMPOSE" up -d moira
wait_for_stopped "$CONTAINER" || fail "conflicting startup did not stop"
STOP_STATE=$(docker inspect --format '{{.State.ExitCode}} {{.RestartCount}}' "$CONTAINER")
[ "$STOP_STATE" = "0 0" ] || fail "conflicting startup state was $STOP_STATE, expected 0 0"
data_command test -f /app/data/.moira-reconciliation/pending/manifest.json || fail "pending manifest was not created"
AFTER=$(docker run --rm -v "$DATA:/app/data" --entrypoint sqlite3 "$IMAGE" /app/data/moira.db .dump | sha256sum)
[ "$BEFORE" = "$AFTER" ] || fail "conflicting startup changed the database"

LOG=$(docker logs "$CONTAINER" 2>&1)
printf '%s' "$LOG" | grep -q '=== AGENT INSTRUCTIONS ===' || fail "agent instructions were not emitted"
printf '%s' "$LOG" | grep -q 'docker compose run --rm moira npm run reconcile -- status' || fail "status recovery command was not emitted"
! printf '%s' "$LOG" | grep -q 'self-host remains operable but degraded' || fail "obsolete degraded-mode guidance was emitted"
! printf '%s' "$LOG" | grep -q 'Workflow Management Flow (WMF)' || fail "obsolete WMF guidance was emitted"

REVISION=$(data_command sed -n 's/.*"revision": "\([a-f0-9]*\)".*/\1/p' /app/data/.moira-reconciliation/pending/manifest.json | head -1)
[ -n "$REVISION" ]
docker compose -p "$PROJECT" -f "$COMPOSE" run --rm moira npm run reconcile -- choose \
  --reference system-moira/reconciliation-docker-test --selection incoming \
  --revision "$REVISION" --rationale "Docker lifecycle regression"
docker compose -p "$PROJECT" -f "$COMPOSE" run --rm moira npm run reconcile -- apply
data_command test ! -e /app/data/.moira-reconciliation/pending
RETIRED=/app/data/.moira-reconciliation/.applied-00000000-0000-4000-8000-000000000001
data_command sh -c 'mkdir -p "$1"; printf "%s\n" sensitive-candidate >"$1/candidate.json"' sh "$RETIRED"

docker compose -p "$PROJECT" -f "$COMPOSE" up -d moira
wait_for_file "$CONTAINER" /tmp/init-success
docker exec "$CONTAINER" /app/scripts/health-check.sh
[ "$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$CONTAINER")" = "true 0" ]
[ "$(docker exec "$CONTAINER" sqlite3 /app/data/moira.db "SELECT json_extract(graph,'$.nodes[1].directive') FROM workflow WHERE slug='reconciliation-docker-test';")" = "incoming-change" ]
data_command test ! -e "$RETIRED"

docker compose -p "$PROJECT" -f "$COMPOSE" stop moira
docker run --rm -v "$DATA:/app/data" --entrypoint sqlite3 "$IMAGE" /app/data/moira.db \
  "UPDATE workflow SET graph=json_set(graph,'$.nodes[1].directive','retained-local') WHERE slug='reconciliation-docker-test';"
write_flow "3.0.0" "following-incoming" "Following catalog"
docker compose -p "$PROJECT" -f "$COMPOSE" up -d moira
wait_for_stopped "$CONTAINER"
data_command test -f /app/data/.moira-reconciliation/pending/manifest.json
OLD_BUNDLE=$(data_command sha256sum /app/data/.moira-reconciliation/pending/manifest.json | cut -d ' ' -f1)
HARD_BEFORE=$(docker run --rm -v "$DATA:/app/data" --entrypoint sqlite3 "$IMAGE" /app/data/moira.db .dump | sha256sum)

write_flow "not-semver" "invalid-incoming" "Invalid catalog"
docker compose -p "$PROJECT" -f "$COMPOSE" up -d moira
wait_for_stopped "$CONTAINER"
HARD_AFTER=$(docker run --rm -v "$DATA:/app/data" --entrypoint sqlite3 "$IMAGE" /app/data/moira.db .dump | sha256sum)
[ "$HARD_BEFORE" = "$HARD_AFTER" ]
[ "$OLD_BUNDLE" = "$(data_command sha256sum /app/data/.moira-reconciliation/pending/manifest.json | cut -d ' ' -f1)" ]
HARD_LOG=$(docker logs "$CONTAINER" 2>&1 | awk '
  /=== AGENT INSTRUCTIONS ===/ { block=$0 ORS; inside=1; next }
  inside { block=block $0 ORS }
  /=== END AGENT INSTRUCTIONS ===/ { last=block; inside=0 }
  END { printf "%s", last }
')
printf '%s' "$HARD_LOG" | grep -q 'not a recoverable workflow reconciliation conflict'
! printf '%s' "$HARD_LOG" | grep -q 'choose --reference'
! printf '%s' "$HARD_LOG" | grep -q 'npm run reconcile -- apply'

printf '%s\n' 'Self-host reconciliation Docker lifecycle passed'
