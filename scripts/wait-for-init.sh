#!/bin/sh
# Wait for init-database to complete successfully before starting a service.
# Uses a sentinel file approach: init-database writes /tmp/init-success on success,
# or /tmp/init-failed on failure.

SENTINEL="/tmp/init-success"
FAILURE="/tmp/init-failed"
MAX_WAIT=120
WAITED=0

while [ ! -f "$SENTINEL" ] && [ ! -f "$FAILURE" ]; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo "ERROR: init-database did not complete within ${MAX_WAIT}s — refusing to start"
        exit 1
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

if [ -f "$FAILURE" ]; then
    echo "ERROR: init-database failed — refusing to start"
    exit 1
fi

echo "init-database completed successfully (waited ${WAITED}s), starting service..."
