#!/bin/sh
# Protect self-host persistent startup state before database initialization.
set -u

SENTINEL_DIR=${MOIRA_INIT_SENTINEL_DIR:-/tmp}
INIT_FAILED="$SENTINEL_DIR/init-failed"
INIT_SUCCESS="$SENTINEL_DIR/init-success"
RECONCILIATION_REQUIRED="$SENTINEL_DIR/workflow-reconciliation-required"
NEXT=""
SUCCESS_NEXT=""
DB_RESTORE_TEMP=""
MANIFEST_RESTORE_TEMP=""
CHILD_PID=""

present() {
  [ -e "$1" ] || [ -L "$1" ]
}

remove_file() {
  path=$1
  rm -f -- "$path" || return 1
  ! present "$path"
}

publish_failure() {
  touch "$INIT_FAILED" || {
    echo "ERROR: cannot publish initialization failure sentinel: $INIT_FAILED" >&2
    return 1
  }
}

fail() {
  echo "ERROR: $*" >&2
  publish_failure || true
  exit 1
}

[ -d "$SENTINEL_DIR" ] && [ ! -L "$SENTINEL_DIR" ] \
  || {
    echo "ERROR: initialization sentinel directory is unavailable or unsafe: $SENTINEL_DIR" >&2
    exit 1
  }
remove_file "$INIT_SUCCESS" && remove_file "$INIT_FAILED" \
  && remove_file "$RECONCILIATION_REQUIRED" \
  || {
    echo "ERROR: cannot clear stale initialization sentinels" >&2
    exit 1
  }

[ "$#" -gt 0 ] || fail "startup command is required"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
MODE=$(printf '%s' "${DEPLOYMENT_MODE:-self-host}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
if [ "$MODE" != "self-host" ]; then
  exec "$@"
fi

DB=${DB_PATH:-./data/moira.db}
DB_DIR=$(dirname "$DB")
DB_NAME=$(basename "$DB")
MANIFEST="$DB_DIR/prompt-manifest.json"
STATE_DIR="$DB_DIR/.moira-startup-backups"
CURRENT="$STATE_DIR/current"
PREVIOUS_1="$STATE_DIR/previous-1"
PREVIOUS_2="$STATE_DIR/previous-2"
FIRST_START="$STATE_DIR/first-start"
HAD_DB=0

[ ! -L "$DB" ] || fail "database path may not be a symlink: $DB"
[ ! -L "$MANIFEST" ] || fail "prompt manifest may not be a symlink: $MANIFEST"
[ ! -L "$STATE_DIR" ] || fail "startup backup path may not be a symlink: $STATE_DIR"

validate_regular_or_absent() {
  path=$1
  ! present "$path" || { [ -f "$path" ] && [ ! -L "$path" ]; }
}

validate_slot() {
  slot=$1
  ! present "$slot" || { [ -d "$slot" ] && [ ! -L "$slot" ]; } || return 1
  [ ! -d "$slot" ] || {
    validate_regular_or_absent "$slot/$DB_NAME" \
      && validate_regular_or_absent "$slot/$DB_NAME-wal" \
      && validate_regular_or_absent "$slot/$DB_NAME-shm" \
      && validate_regular_or_absent "$slot/prompt-manifest.json" \
      && validate_regular_or_absent "$slot/prompt-manifest.absent" \
      && validate_regular_or_absent "$slot/initialization.pending" \
      && validate_regular_or_absent "$slot/initialization.committed" \
      && validate_regular_or_absent "$slot/first-start.pending" \
      && validate_regular_or_absent "$slot/first-start.committed"
  }
}

remove_slot() {
  slot=$1
  validate_slot "$slot" || return 1
  remove_file "$slot/$DB_NAME" \
    && remove_file "$slot/$DB_NAME-wal" \
    && remove_file "$slot/$DB_NAME-shm" \
    && remove_file "$slot/prompt-manifest.json" \
    && remove_file "$slot/prompt-manifest.absent" \
    && remove_file "$slot/initialization.pending" \
    && remove_file "$slot/initialization.committed" \
    && remove_file "$slot/first-start.pending" \
    && remove_file "$slot/first-start.committed" \
    || return 1
  [ ! -d "$slot" ] || rmdir "$slot"
}

remove_staging_dir() {
  staging=$1
  [ -d "$staging" ] && [ ! -L "$staging" ] || return 1
  case "$staging" in "$STATE_DIR"/.next.*) ;; *) return 1 ;; esac
  rm -rf -- "$staging" || return 1
  ! present "$staging"
}

cleanup_staging() {
  [ -z "$NEXT" ] || ! present "$NEXT" || remove_staging_dir "$NEXT" || true
  [ -z "$SUCCESS_NEXT" ] || remove_file "$SUCCESS_NEXT" || true
  [ -z "$DB_RESTORE_TEMP" ] || remove_file "$DB_RESTORE_TEMP" || true
  [ -z "$MANIFEST_RESTORE_TEMP" ] || remove_file "$MANIFEST_RESTORE_TEMP" || true
}
abort_before_mutation() {
  trap - HUP INT TERM
  cleanup_staging
  publish_failure || true
  trap - EXIT
  exit 1
}
trap cleanup_staging EXIT
trap abort_before_mutation HUP INT TERM

mkdir -p "$STATE_DIR" || fail "cannot create startup backup directory: $STATE_DIR"
[ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] \
  || fail "startup backup directory is unavailable or unsafe: $STATE_DIR"

for stale in "$STATE_DIR"/.next.*; do
  present "$stale" || continue
  remove_staging_dir "$stale" || fail "cannot remove unsafe or stale startup staging path: $stale"
done

for stale in "$DB_DIR"/.moira-db-restore.* "$DB_DIR"/.moira-manifest-restore.*; do
  present "$stale" || continue
  [ -f "$stale" ] && [ ! -L "$stale" ] \
    || fail "unsafe stale restore path: $stale"
  remove_file "$stale" || fail "cannot remove stale restore file: $stale"
done

for slot in "$CURRENT" "$PREVIOUS_1" "$PREVIOUS_2" "$FIRST_START"; do
  validate_slot "$slot" || fail "unsafe startup recovery slot: $slot"
done

if [ -f "$CURRENT/initialization.committed" ]; then
  remove_file "$CURRENT/initialization.committed" \
    || fail "cannot clear committed initialization marker"
fi
if [ -f "$FIRST_START/first-start.committed" ]; then
  remove_slot "$FIRST_START" || fail "cannot clear committed first-start marker"
fi

restore_slot() {
  slot=$1
  backup="$slot/$DB_NAME"
  validate_slot "$slot" && [ -f "$backup" ] && [ ! -L "$backup" ] || return 1
  sqlite3 "$backup" "PRAGMA integrity_check;" | grep -qx ok || return 1
  remove_file "$backup-wal" && remove_file "$backup-shm" || return 1
  DB_RESTORE_TEMP=$(mktemp "$DB_DIR/.moira-db-restore.XXXXXX") || return 1
  [ -f "$DB_RESTORE_TEMP" ] && [ ! -L "$DB_RESTORE_TEMP" ] || return 1
  cp "$backup" "$DB_RESTORE_TEMP" || return 1
  [ -f "$DB_RESTORE_TEMP" ] && [ ! -L "$DB_RESTORE_TEMP" ] || return 1
  sqlite3 "$DB_RESTORE_TEMP" "PRAGMA integrity_check;" | grep -qx ok || {
    remove_file "$DB_RESTORE_TEMP" || true
    DB_RESTORE_TEMP=""
    return 1
  }

  remove_file "$DB-wal" && remove_file "$DB-shm" || return 1
  mv -f "$DB_RESTORE_TEMP" "$DB" || return 1
  DB_RESTORE_TEMP=""
  [ -f "$DB" ] && [ ! -L "$DB" ] || return 1

  if [ -f "$slot/prompt-manifest.absent" ]; then
    remove_file "$MANIFEST" || return 1
  else
    [ -f "$slot/prompt-manifest.json" ] && [ ! -L "$slot/prompt-manifest.json" ] || return 1
    MANIFEST_RESTORE_TEMP=$(mktemp "$DB_DIR/.moira-manifest-restore.XXXXXX") || return 1
    [ -f "$MANIFEST_RESTORE_TEMP" ] && [ ! -L "$MANIFEST_RESTORE_TEMP" ] || return 1
    cp "$slot/prompt-manifest.json" "$MANIFEST_RESTORE_TEMP" || return 1
    [ -f "$MANIFEST_RESTORE_TEMP" ] && [ ! -L "$MANIFEST_RESTORE_TEMP" ] || return 1
    mv -f "$MANIFEST_RESTORE_TEMP" "$MANIFEST" || return 1
    MANIFEST_RESTORE_TEMP=""
  fi

  sqlite3 "$DB" "PRAGMA integrity_check;" | grep -qx ok || return 1
  remove_file "$backup-wal" && remove_file "$backup-shm" || return 1
  echo "STARTUP_RESTORE_OK $DB" >&2
}

restore_first_start_state() {
  validate_slot "$FIRST_START" || return 1
  { [ -f "$FIRST_START/first-start.pending" ] \
      || [ -f "$FIRST_START/first-start.committed" ]; } \
    || return 1
  remove_file "$DB" && remove_file "$DB-wal" && remove_file "$DB-shm" || return 1
  ! present "$DB" && ! present "$DB-wal" && ! present "$DB-shm" || return 1
  if [ -f "$FIRST_START/prompt-manifest.absent" ]; then
    remove_file "$MANIFEST" || return 1
  else
    [ -f "$FIRST_START/prompt-manifest.json" ] \
      && [ ! -L "$FIRST_START/prompt-manifest.json" ] || return 1
    MANIFEST_RESTORE_TEMP=$(mktemp "$DB_DIR/.moira-manifest-restore.XXXXXX") || return 1
    [ -f "$MANIFEST_RESTORE_TEMP" ] && [ ! -L "$MANIFEST_RESTORE_TEMP" ] || return 1
    cp "$FIRST_START/prompt-manifest.json" "$MANIFEST_RESTORE_TEMP" || return 1
    mv -f "$MANIFEST_RESTORE_TEMP" "$MANIFEST" || return 1
    MANIFEST_RESTORE_TEMP=""
  fi
  remove_slot "$FIRST_START" || return 1
  rmdir "$STATE_DIR" 2>/dev/null || true
  echo "INTERRUPTED_FIRST_START_RECOVERED $DB" >&2
}

[ ! -f "$FIRST_START/first-start.pending" ] \
  || [ ! -f "$CURRENT/initialization.pending" ] \
  || fail "ambiguous interrupted startup markers"

if [ -f "$FIRST_START/first-start.pending" ]; then
  restore_first_start_state \
    || fail "interrupted first-start state could not be removed safely"
  mkdir -p "$STATE_DIR" || fail "cannot recreate startup backup directory"
fi

if [ -f "$CURRENT/initialization.pending" ]; then
  restore_slot "$CURRENT" \
    || fail "previous initialization was interrupted and its recovery backup could not be restored"
  remove_file "$CURRENT/initialization.pending" \
    || fail "cannot clear recovered initialization marker"
  echo "INTERRUPTED_STARTUP_RECOVERED $CURRENT/$DB_NAME" >&2
fi

if [ -f "$DB" ]; then
  HAD_DB=1
  NEXT=$(mktemp -d "$STATE_DIR/.next.XXXXXX") \
    || fail "cannot create startup backup staging directory"
  [ -d "$NEXT" ] && [ ! -L "$NEXT" ] || fail "unsafe startup backup staging directory"

  "$SCRIPT_DIR/sqlite-online-backup.sh" "$DB" "$NEXT/$DB_NAME" \
    || fail "refusing startup because the existing database could not be backed up"
  [ -f "$NEXT/$DB_NAME" ] && [ ! -L "$NEXT/$DB_NAME" ] \
    || fail "startup backup was not published as a regular file"

  if [ -f "$MANIFEST" ]; then
    cp "$MANIFEST" "$NEXT/prompt-manifest.json" || fail "cannot back up prompt manifest"
    [ -f "$NEXT/prompt-manifest.json" ] && [ ! -L "$NEXT/prompt-manifest.json" ] \
      || fail "prompt manifest backup is unsafe"
  else
    touch "$NEXT/prompt-manifest.absent" || fail "cannot record absent prompt manifest"
  fi

  remove_slot "$PREVIOUS_2" || fail "cannot remove oldest startup backup"
  [ ! -d "$PREVIOUS_1" ] || mv "$PREVIOUS_1" "$PREVIOUS_2" \
    || fail "cannot rotate previous startup backup"
  [ ! -d "$CURRENT" ] || mv "$CURRENT" "$PREVIOUS_1" \
    || fail "cannot rotate current startup backup"
  mv "$NEXT" "$CURRENT" || fail "cannot publish current startup backup"
  NEXT=""
  touch "$CURRENT/initialization.pending" || fail "cannot mark initialization as pending"
  echo "STARTUP_BACKUP_OK $CURRENT/$DB_NAME"
else
  [ ! -d "$FIRST_START" ] || remove_slot "$FIRST_START" \
    || fail "cannot reset first-start recovery slot"
  mkdir "$FIRST_START" || fail "cannot create first-start recovery marker"
  if [ -f "$MANIFEST" ]; then
    cp "$MANIFEST" "$FIRST_START/prompt-manifest.json" \
      || fail "cannot protect existing prompt manifest before first database start"
  else
    touch "$FIRST_START/prompt-manifest.absent" \
      || fail "cannot record absent first-start prompt manifest"
  fi
  touch "$FIRST_START/first-start.pending" \
    || fail "cannot mark first-start initialization as pending"
fi

restore_previous_state() {
  if [ "$HAD_DB" -eq 0 ]; then
    restore_first_start_state || return 1
    echo "STARTUP_RESTORE_OK removed incomplete first-start state" >&2
    return 0
  fi
  restore_slot "$CURRENT" || return 1
  remove_file "$CURRENT/initialization.pending" \
    && remove_file "$CURRENT/initialization.committed"
}

terminal_failure() {
  restored=0
  if ! restore_previous_state; then
    echo "ERROR: initialization failed and automatic state restore failed" >&2
    echo "Recovery state retained under: $STATE_DIR" >&2
  else
    restored=1
  fi
  publish_failure || true

  reconciliation_pending="$DB_DIR/.moira-reconciliation/pending"
  reconciliation_current=0
  if [ "$restored" -eq 1 ] \
    && [ -f "$RECONCILIATION_REQUIRED" ] && [ ! -L "$RECONCILIATION_REQUIRED" ] \
    && [ -d "$reconciliation_pending" ] && [ ! -L "$reconciliation_pending" ] \
    && [ -f /app/package.json ]; then
    if (cd /app && /usr/local/bin/npm run reconcile -- status) >&2; then
      reconciliation_current=1
    fi
  fi
  remove_file "$RECONCILIATION_REQUIRED" || true

  if [ "$reconciliation_current" -ne 1 ]; then
    echo "=== AGENT INSTRUCTIONS ===" >&2
    echo "This is not a recoverable workflow reconciliation conflict. Do not run reconcile choose or apply." >&2
    echo "Inspect the startup error and the retained recovery state: docker compose logs moira" >&2
    echo "Verify the live and backup databases before retrying or selecting a previous image." >&2
    echo "Do not use --force and do not blindly retry an unchanged image or configuration." >&2
    echo "=== END AGENT INSTRUCTIONS ===" >&2
  fi

  if [ "${MOIRA_STOP_CONTAINER_ON_INIT_FAILURE:-0}" = "1" ]; then
    trap - HUP INT TERM
    kill -TERM 1 2>/dev/null || true
  fi
}

handle_signal() {
  trap - HUP INT TERM
  [ -z "$CHILD_PID" ] || kill -TERM "$CHILD_PID" 2>/dev/null || true
  [ -z "$CHILD_PID" ] || wait "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""
  terminal_failure
  cleanup_staging
  trap - EXIT
  exit 1
}

trap handle_signal HUP INT TERM
MOIRA_INIT_SENTINEL_OWNER=guard "$@" &
CHILD_PID=$!
wait "$CHILD_PID"
init_rc=$?
CHILD_PID=""
trap 'cleanup_staging; exit 1' HUP INT TERM

if [ "$init_rc" -ne 0 ]; then
  terminal_failure
  trap - EXIT HUP INT TERM
  exit "$init_rc"
fi

SUCCESS_NEXT=$(mktemp "$SENTINEL_DIR/.init-success.XXXXXX") \
  || {
    terminal_failure
    trap - EXIT HUP INT TERM
    exit 1
  }

if [ "$HAD_DB" -eq 0 ]; then
  mv "$FIRST_START/first-start.pending" "$FIRST_START/first-start.committed" \
    || {
      terminal_failure
      trap - EXIT HUP INT TERM
      exit 1
    }
else
  mv "$CURRENT/initialization.pending" "$CURRENT/initialization.committed" \
    || {
      terminal_failure
      trap - EXIT HUP INT TERM
      exit 1
    }
fi

if ! mv -f "$SUCCESS_NEXT" "$INIT_SUCCESS"; then
  SUCCESS_NEXT=""
  terminal_failure
  trap - EXIT HUP INT TERM
  exit 1
fi
SUCCESS_NEXT=""

if [ "$HAD_DB" -eq 0 ]; then
  remove_slot "$FIRST_START" \
    || echo "WARNING: committed first-start marker will be cleaned on next startup" >&2
else
  remove_file "$CURRENT/initialization.committed" \
    || echo "WARNING: committed initialization marker will be cleaned on next startup" >&2
fi
rmdir "$STATE_DIR" 2>/dev/null || true

trap - EXIT HUP INT TERM
exit 0
