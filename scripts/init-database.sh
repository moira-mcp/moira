#!/bin/sh
# Init-database wrapper: runs all database migrations and writes a sentinel file.
# On success: writes /tmp/init-success
# On failure: writes /tmp/init-failed and exits with code 1

# Clean up stale sentinel files from previous container runs
rm -f /tmp/init-success /tmp/init-failed

# First-start secret bootstrap (self-host): generate missing secrets before
# migrations so a fresh install boots without manual .env editing.
/usr/local/bin/tsx scripts/bootstrap-secrets.ts \
  && /usr/local/bin/tsx scripts/run-migrations.ts \
  && /usr/local/bin/tsx scripts/migrate-workflows-in-docker.ts

if [ $? -eq 0 ]; then
    touch /tmp/init-success
else
    touch /tmp/init-failed
    exit 1
fi
