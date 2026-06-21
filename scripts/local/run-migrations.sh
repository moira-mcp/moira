#!/bin/bash
# Run migrations with environment variables from .env.local

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load environment variables from .env.local
if [ -f "$PROJECT_ROOT/.env.local" ]; then
    export $(grep -E '^(MOIRA_HOST|BETTER_AUTH_SECRET|TELEGRAM_ENCRYPTION_KEY|DB_PATH|ADMIN_EMAIL|ADMIN_PASSWORD)=' "$PROJECT_ROOT/.env.local" | xargs)
else
    echo "Error: .env.local not found at $PROJECT_ROOT/.env.local"
    exit 1
fi

cd "$PROJECT_ROOT"
npx tsx scripts/run-migrations.ts
npx tsx scripts/migrate-workflows-in-docker.ts
