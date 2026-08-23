#!/bin/sh
# Init-database wrapper: runs all database migrations and writes a sentinel file.
# On success: writes /tmp/init-success
# On failure: writes /tmp/init-failed and exits with code 1

# The outer self-host startup guard owns both sentinels so it can publish a
# terminal state only after backup commit or failure restoration. Direct/SaaS
# invocations retain this script's standalone sentinel behavior.
sentinel_owner=${MOIRA_INIT_SENTINEL_OWNER:-self}
if [ "$sentinel_owner" != "guard" ]; then
    rm -f /tmp/init-success /tmp/init-failed || exit 1
fi

# First-start secret bootstrap (self-host): generate missing secrets before
# migrations so a fresh install boots without manual .env editing.
/usr/local/bin/tsx scripts/bootstrap-secrets.ts \
  && /usr/local/bin/tsx scripts/run-migrations.ts \
  && /usr/local/bin/tsx scripts/migrate-workflows-in-docker.ts
chain_rc=$?

# Defense-in-depth: a migration step can hit a fatal error yet still exit 0 — the
# shared logger runs with exitOnError:false and swallows an uncaughtException
# raised while the config singleton initializes at import time. So do NOT trust the
# exit code alone: verify the database was actually initialized (schema present and
# the bundled workflow catalog loaded) before declaring success. Without this guard
# a broken init would write /tmp/init-success and supervisor would start the
# services against an empty DB. If sqlite3 is unavailable, fall back to the exit code.
db="${DB_PATH:-./data/moira.db}"
schema_ok() {
  command -v sqlite3 >/dev/null 2>&1 || return 0
  [ "$(sqlite3 "$db" 'SELECT COUNT(*) FROM workflow;' 2>/dev/null || echo 0)" -gt 0 ]
}

if [ "$chain_rc" -eq 0 ] && schema_ok; then
    if [ "$sentinel_owner" != "guard" ]; then
        touch /tmp/init-success || exit 1
    fi
else
    echo "init-database: FAILED (exit code $chain_rc; database not initialized)" >&2
    if [ "$sentinel_owner" != "guard" ]; then
        touch /tmp/init-failed || true
    fi
    exit 1
fi
