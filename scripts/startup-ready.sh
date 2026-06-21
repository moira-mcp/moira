#!/bin/sh

# Startup readiness check - returns success only if app-ready flag exists
if [ -f /tmp/app-ready ]; then
    echo "ready"
    exit 0
else
    exit 1
fi
