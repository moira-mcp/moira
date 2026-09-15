#!/usr/bin/env bash
# Reproduce CI's "Docker Build & API Tests" job locally, in the environment CI uses.
#
# CI copies .env.ci over the runner's .env.local, so everything it runs there is in saas mode on
# the ports .env.ci names. A contributor's .env.local is their own working environment and is not
# overwritten here; the CI environment is selected explicitly instead, which is why the results of
# this script are comparable with CI's and the results of `npm run test:api` are not.
#
# Usage: npm run verify:docker
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env.ci ]; then
  echo "❌ .env.ci not found — it is the environment CI builds and tests in" >&2
  exit 1
fi

# The values are assigned rather than executed: .env.ci holds values with spaces, and sourcing such
# a file runs the second word as a command. They are exported because the test process reads them
# the way CI's does — CI copies this same file over the runner's .env and .env.local.
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key=${line%%=*}
  case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
  export "$key=${line#*=}"
done < .env.ci

IMAGE="${DOCKER_IMAGE_NAME:-mcp-moira-ci}"
PRIMARY="${DOCKER_CONTAINER_NAME:-mcp-moira-ci}"
PRIMARY_PORT="${DOCKER_PORT:-3030}"
SELF_HOST="${PRIMARY}-self-host"
SELF_HOST_PORT=3031

cleanup() {
  docker rm -f "$PRIMARY" "$SELF_HOST" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "🧹 Removing containers left by an earlier run"
cleanup

echo "🔨 Building the image CI builds, from the environment CI uses"
./scripts/docker-build-and-run.sh --local --env-file .env.ci

echo "🔁 Self-host reconciliation lifecycle"
MOIRA_TEST_IMAGE="$IMAGE:latest" npm run test:docker-reconciliation

echo "🌐 API and MCP tool suites against the primary container (saas, port $PRIMARY_PORT)"
npm run test:api:ci-saas
npm run test:mcp-tools:ci-saas

echo "🏠 Self-host container on port $SELF_HOST_PORT for the two self-host-only API files"
# Start from an empty database every time. CI always has one; a contributor's machine keeps this
# directory between runs, and a database left by an earlier checkout carries that checkout's applied
# migrations — so a renumbered or amended migration is re-applied against a schema that already has
# it, the container starts degraded, and the suite fails with errors that have nothing to do with
# the change under test.
rm -rf data-self-host
mkdir -p data-self-host
docker run --name "$SELF_HOST" -p "$SELF_HOST_PORT:80" --env-file .env.ci \
  -v "$(pwd)/workflows:/app/workflows" -v "$(pwd)/data-self-host:/app/data" \
  -e DEPLOYMENT_MODE=self-host -e MOIRA_HOST="localhost:$SELF_HOST_PORT" \
  -e STATIC_ARTIFACTS_DOMAIN="static.localhost:$SELF_HOST_PORT" \
  -e MCP_PORT=3000 -e WEB_BACKEND_PORT=3001 -e WEB_FRONTEND_PORT=3002 \
  -e EMAIL_PROVIDER=none -e BREVO_API_KEY= -e EMAIL_TEST_RECIPIENTS=false \
  -e DISABLE_RATE_LIMIT=true -d "$IMAGE:latest" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$SELF_HOST_PORT/startup-ready" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://localhost:$SELF_HOST_PORT/startup-ready" >/dev/null ||
  { echo "❌ self-host container did not become ready" >&2; exit 1; }

npm run test:api:ci -- --file tests/api/auth/self-host-auth.test.ts
npm run test:api:ci -- --file tests/api/capability-boundary-api.test.ts

echo "✅ The Docker half of the CI gate passed locally, in CI's environment"
