#!/bin/sh
# One coherent SQLite online-backup primitive for self-host and Cloud callers.
set -eu

SOURCE=${1:-}
DESTINATION=${2:-}

fail() { echo "ERROR: $*" >&2; exit 1; }
[ -n "$SOURCE" ] || fail "source database path is required"
[ -n "$DESTINATION" ] || fail "destination database path is required"
[ "$SOURCE" != "$DESTINATION" ] || fail "source and destination must differ"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is required"
[ -f "$SOURCE" ] || fail "source database not found: $SOURCE"

case "$SOURCE$DESTINATION" in *"'"*|*"
"*) fail "database paths may not contain quotes or newlines" ;; esac

DEST_DIR=$(dirname "$DESTINATION")
[ -d "$DEST_DIR" ] || fail "destination directory not found: $DEST_DIR"
[ -w "$DEST_DIR" ] || fail "destination directory is not writable: $DEST_DIR"

SOURCE_KB=$(
  {
    du -k "$SOURCE"
    [ ! -f "$SOURCE-wal" ] || du -k "$SOURCE-wal"
  } | awk '{total += $1} END {print total}'
)
AVAILABLE_KB=$(df -Pk "$DEST_DIR" | awk 'NR==2 {print $4}')
[ "$AVAILABLE_KB" -gt "$SOURCE_KB" ] || fail "insufficient free space for backup"

TEMP="${DESTINATION}.tmp.$$"
cleanup() { rm -f "$TEMP" "$TEMP-wal" "$TEMP-shm"; }
trap cleanup EXIT HUP INT TERM

sqlite3 "$SOURCE" ".backup '$TEMP'" || fail "SQLite online backup failed"
RESULT=$(sqlite3 "$TEMP" "PRAGMA integrity_check;")
[ "$RESULT" = "ok" ] || fail "backup integrity_check failed: $RESULT"
mv -f "$TEMP" "$DESTINATION"
echo "BACKUP_OK $DESTINATION"
