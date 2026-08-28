#!/bin/sh
# Establish a fresh startup generation before Supervisor can spawn any waiter.
set -eu

sentinel_dir=${MOIRA_INIT_SENTINEL_DIR:-/tmp}
[ -d "$sentinel_dir" ] && [ ! -L "$sentinel_dir" ] || {
  echo "ERROR: initialization sentinel directory is unavailable or unsafe: $sentinel_dir" >&2
  exit 1
}

rm -f -- "$sentinel_dir/init-success" "$sentinel_dir/init-failed" \
  "$sentinel_dir/workflow-reconciliation-required"
[ ! -e "$sentinel_dir/init-success" ] && [ ! -L "$sentinel_dir/init-success" ]
[ ! -e "$sentinel_dir/init-failed" ] && [ ! -L "$sentinel_dir/init-failed" ]

exec "$@"
