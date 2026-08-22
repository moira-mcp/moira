#!/bin/sh
# Safe self-host image preflight/upgrade/rollback orchestration.
set -eu

COMMAND=${1:-}
IMAGE=${2:-${MOIRA_IMAGE:-}}
DATA_DIR=${MOIRA_DATA_DIR:-./data}
STATE_DIR=${MOIRA_UPGRADE_DIR:-./.moira-upgrade}
BACKUP="$STATE_DIR/moira.db.upgrade-backup"
PREFLIGHT_DIR="$STATE_DIR/preflight"

fail() { echo "ERROR: $*" >&2; exit 1; }
require_pin() {
  [ -n "$IMAGE" ] || fail "immutable image reference is required"
  case "$IMAGE" in *:latest|*:edge|*:master|*:main) fail "mutable image tags are forbidden: $IMAGE" ;; esac
  case "$IMAGE" in *@sha256:*|*:[0-9]*.[0-9]*.[0-9]*) ;; *) fail "use a version tag or sha256 digest: $IMAGE" ;; esac
}
backup() {
  require_pin
  mkdir -p "$DATA_DIR" "$STATE_DIR"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
  docker run --rm \
    -v "$(cd "$DATA_DIR" && pwd):/source:ro" \
    -v "$(cd "$STATE_DIR" && pwd):/backup" \
    --entrypoint /app/scripts/sqlite-online-backup.sh "$IMAGE" \
    /source/moira.db /backup/moira.db.upgrade-backup
}
preflight() {
  require_pin
  backup
  rm -rf "$PREFLIGHT_DIR"
  mkdir -p "$PREFLIGHT_DIR"
  cp "$BACKUP" "$PREFLIGHT_DIR/moira.db"
  [ ! -f "$DATA_DIR/prompt-manifest.json" ] || cp "$DATA_DIR/prompt-manifest.json" "$PREFLIGHT_DIR/prompt-manifest.json"
  docker run --rm \
    -v "$(cd "$PREFLIGHT_DIR" && pwd):/app/data" \
    -e DEPLOYMENT_MODE=self-host \
    -e PROMPT_CONFLICT_FATAL=0 \
    "$IMAGE" /app/scripts/init-database.sh
  sqlite3 "$PREFLIGHT_DIR/moira.db" "PRAGMA integrity_check;" | grep -qx ok || fail "preflight database is corrupt"
  echo "PREFLIGHT_OK $PREFLIGHT_DIR"
}
upgrade() {
  require_pin
  preflight
  cp .env .env.before-upgrade
  if grep -q '^MOIRA_IMAGE=' .env; then
    sed "s|^MOIRA_IMAGE=.*|MOIRA_IMAGE=$IMAGE|" .env > .env.upgrade
  else
    cp .env .env.upgrade
    printf '\nMOIRA_IMAGE=%s\n' "$IMAGE" >> .env.upgrade
  fi
  mv .env.upgrade .env
  docker compose up -d --no-deps --wait --wait-timeout 120 moira
  docker compose exec -T moira /app/scripts/health-check.sh || fail "new container health check failed; run rollback"
  echo "UPGRADE_OK $IMAGE"
}
rollback() {
  [ -f "$BACKUP" ] || fail "verified upgrade backup not found"
  [ -f .env.before-upgrade ] || fail "previous image pin not found"
  sqlite3 "$BACKUP" "PRAGMA integrity_check;" | grep -qx ok || fail "rollback backup is corrupt"
  docker compose stop moira
  rm -f "$DATA_DIR/moira.db-wal" "$DATA_DIR/moira.db-shm"
  cp "$BACKUP" "$DATA_DIR/moira.db"
  mv .env.before-upgrade .env
  docker compose up -d --no-deps --wait --wait-timeout 120 moira
  docker compose exec -T moira /app/scripts/health-check.sh
  echo "ROLLBACK_OK"
}

case "$COMMAND" in
  backup) backup ;;
  preflight) preflight ;;
  upgrade) upgrade ;;
  rollback) rollback ;;
  *) echo "Usage: $0 backup | preflight <immutable-image> | upgrade <immutable-image> | rollback" >&2; exit 2 ;;
esac
