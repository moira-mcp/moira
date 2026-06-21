#!/bin/bash

# Docker build and run script with worktree isolation
# Reads configuration from .env file to ensure unique names per worktree
#
# Usage: ./scripts/docker-build-and-run.sh [options]
#
# Options:
#   --remote        Remote mode: build/run Docker on PC via SSH context
#   --local         Local mode: build/run Docker on Mac
#   --rate-limit    Enable rate limiting (disabled by default for dev)
#   --dry-run       Print docker commands without executing them
#   --help          Show this help
#
# Examples:
#   ./scripts/docker-build-and-run.sh --remote         # Build/run on PC
#   ./scripts/docker-build-and-run.sh --local          # Build/run on Mac
#   ./scripts/docker-build-and-run.sh --remote --dry-run

set -e

# Enable BuildKit for faster builds and cache mounts
export DOCKER_BUILDKIT=1

# Defaults
ENABLE_RATE_LIMIT=false
REMOTE_MODE=false
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --remote)
            REMOTE_MODE=true
            shift
            ;;
        --local)
            REMOTE_MODE=false
            shift
            ;;
        --rate-limit)
            ENABLE_RATE_LIMIT=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --remote        Remote mode: build/run Docker on PC via SSH context"
            echo "  --local         Local mode: build/run Docker on Mac"
            echo "  --rate-limit    Enable rate limiting (disabled by default for dev)"
            echo "  --dry-run       Print docker commands without executing them"
            echo "  --help          Show this help"
            echo ""
            echo "npm scripts:"
            echo "  npm run docker:restart         Local mode (default)"
            echo ""
            echo "Note: self-host users do NOT need this script — use 'docker compose up -d'."
            echo "      This is a contributor dev helper. --remote is optional and reads"
            echo "      REMOTE_* settings from a local .env.remote (not shipped)."
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# --- Build docker base command (with optional context) ---
# Sets DOCKER_CMD array for use as: "${DOCKER_CMD[@]}" build ...
setup_docker_cmd() {
    if [ "$REMOTE_MODE" = "true" ]; then
        DOCKER_CMD=(docker --context "$REMOTE_DOCKER_CONTEXT")
    else
        DOCKER_CMD=(docker)
    fi
}

# --- Check SSH connectivity to remote host ---
check_remote_connectivity() {
    local host="$1"
    local context="$2"
    local ssh_user="$3"

    local ssh_target="$host"
    if [ -n "$ssh_user" ]; then
        ssh_target="${ssh_user}@${host}"
    fi

    echo "🔍 Checking connectivity to remote host $ssh_target..."

    # Check SSH reachability (timeout 5 seconds)
    if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$ssh_target" "echo ok" > /dev/null 2>&1; then
        echo ""
        echo "❌ Cannot connect to remote host!"
        echo ""
        echo "  Host:     $host"
        echo "  SSH user: ${ssh_user:-$(whoami)} (current user)"
        echo "  Context:  $context"
        echo "  SSH:      UNREACHABLE"
        echo ""
        echo "  Troubleshooting:"
        echo "    1. Check that the PC is powered on"
        echo "    2. Check Tailscale is connected: tailscale status"
        echo "    3. Test SSH manually: ssh $ssh_target 'echo ok'"
        echo "    4. Check Docker context: docker context inspect $context"
        exit 1
    fi

    echo "  SSH: OK"

    # Check Docker daemon on remote host
    if ! docker --context "$context" info > /dev/null 2>&1; then
        echo ""
        echo "❌ Docker daemon not responding on remote host!"
        echo ""
        echo "  Host:     $host"
        echo "  Context:  $context"
        echo "  SSH:      OK"
        echo "  Docker:   NOT RESPONDING"
        echo ""
        echo "  Troubleshooting:"
        echo "    1. Check Docker Desktop is running on the PC"
        echo "    2. Test manually: docker --context $context info"
        exit 1
    fi

    echo "  Docker: OK"
    echo "✅ Remote host is ready"
}

# --- Load environment configuration ---
echo "🔧 Loading environment configuration..."

# Load .env.local file
# NOTE: source executes the file as bash — .env files must contain only KEY=value assignments
if [ -f .env.local ]; then
    source .env.local
    echo "✅ Loaded .env.local"
else
    echo "❌ .env.local file not found!"
    exit 1
fi

# Load remote config if in remote mode
if [ "$REMOTE_MODE" = "true" ]; then
    if [ -f .env.remote ]; then
        source .env.remote
        echo "✅ Loaded .env.remote"
    else
        echo "❌ .env.remote file not found!"
        echo "   Create it with REMOTE_DOCKER_CONTEXT, REMOTE_HOST, and REMOTE_SSH_USER settings."
        exit 1
    fi

    # Validate remote-specific variables
    if [ -z "$REMOTE_DOCKER_CONTEXT" ]; then
        echo "❌ REMOTE_DOCKER_CONTEXT not set in .env.remote"
        exit 1
    fi
    if [ -z "$REMOTE_HOST" ]; then
        echo "❌ REMOTE_HOST not set in .env.remote"
        exit 1
    fi
    if [ -z "$REMOTE_SSH_USER" ]; then
        echo "❌ REMOTE_SSH_USER not set in .env.remote"
        exit 1
    fi
fi

# Validate required variables
required_vars=("DOCKER_IMAGE_NAME" "DOCKER_CONTAINER_NAME" "DOCKER_PORT")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Required variable $var not set in .env.local"
        exit 1
    fi
done

# Determine app host (localhost for local, remote IP for remote)
if [ "$REMOTE_MODE" = "true" ]; then
    APP_HOST="$REMOTE_HOST"
else
    APP_HOST="localhost"
fi

setup_docker_cmd

# --- Print configuration ---
echo ""
echo "📋 Configuration:"
if [ "$REMOTE_MODE" = "true" ]; then
    echo "  Mode: REMOTE 🌐"
    echo "  Docker context: $REMOTE_DOCKER_CONTEXT"
    echo "  Remote host: $REMOTE_HOST"
    if [ -n "$REMOTE_DATA_PATH" ]; then
        echo "  Volume mounts: $REMOTE_DATA_PATH -> /app/data"
    else
        echo "  Volume mounts: SKIPPED (ephemeral storage)"
    fi
else
    echo "  Mode: LOCAL"
    # Only workflows is bind-mounted locally; /app/data is ephemeral on purpose
    # (macOS bind mounts don't honor SQLite file locking → DB corruption).
    echo "  Volume mounts: workflows (bind mount); data ephemeral"
fi
echo "  Image: $DOCKER_IMAGE_NAME:latest"
echo "  Container: $DOCKER_CONTAINER_NAME"
echo "  Port: $DOCKER_PORT:80"
echo "  App URL: http://$APP_HOST:$DOCKER_PORT"
if [ "$ENABLE_RATE_LIMIT" = "true" ]; then
    echo "  Rate limiting: ENABLED"
else
    echo "  Rate limiting: disabled"
fi
if [ "$DRY_RUN" = "true" ]; then
    echo "  ⚠️  DRY RUN MODE - no commands will be executed"
fi
echo ""

# --- Remote connectivity check ---
if [ "$REMOTE_MODE" = "true" ] && [ "$DRY_RUN" != "true" ]; then
    check_remote_connectivity "$REMOTE_HOST" "$REMOTE_DOCKER_CONTEXT" "$REMOTE_SSH_USER"
    echo ""
fi

# --- SSH Tunnel Management (Remote mode only) ---
# Creates SSH tunnel so localhost:PORT on Mac forwards to PC
setup_ssh_tunnel() {
    local port="$1"
    local host="$2"
    local user="$3"

    # Kill any existing tunnel on this port
    local existing_pid=$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$existing_pid" ]; then
        echo "  Killing existing process on port $port (PID: $existing_pid)"
        kill $existing_pid 2>/dev/null || true
        sleep 1
    fi

    # Create new tunnel
    echo "  Creating SSH tunnel: localhost:$port -> $host:$port"
    ssh -f -N -L $port:localhost:$port ${user}@${host} 2>/dev/null

    # Verify tunnel is working
    sleep 1
    if lsof -ti tcp:$port -sTCP:LISTEN > /dev/null 2>&1; then
        echo "  ✅ SSH tunnel established"
        return 0
    else
        echo "  ❌ Failed to establish SSH tunnel"
        return 1
    fi
}

if [ "$REMOTE_MODE" = "true" ] && [ "$DRY_RUN" != "true" ]; then
    echo "🔗 Setting up SSH tunnel for MCP auth..."
    setup_ssh_tunnel "$DOCKER_PORT" "$REMOTE_HOST" "$REMOTE_SSH_USER"
    echo ""
fi

# --- Stop and remove existing container ---
echo "🛑 Stopping existing container..."
if [ "$DRY_RUN" = "true" ]; then
    echo "[DRY-RUN] ${DOCKER_CMD[*]} stop $DOCKER_CONTAINER_NAME"
    echo "[DRY-RUN] ${DOCKER_CMD[*]} rm $DOCKER_CONTAINER_NAME"
else
    "${DOCKER_CMD[@]}" stop "$DOCKER_CONTAINER_NAME" 2>/dev/null || echo "  Container not running"
    "${DOCKER_CMD[@]}" rm "$DOCKER_CONTAINER_NAME" 2>/dev/null || echo "  Container not found"
fi

# --- Build image ---
echo "🔨 Building Docker image: $DOCKER_IMAGE_NAME:latest"
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ "$DRY_RUN" = "true" ]; then
    echo "[DRY-RUN] ${DOCKER_CMD[*]} build -f config/Dockerfile \\"
    echo "    --build-arg ENV_FILE=.env.local \\"
    echo "    --build-arg BUILD_ID=local \\"
    echo "    --build-arg GIT_COMMIT=$GIT_COMMIT \\"
    echo "    --build-arg BUILD_TIME=$BUILD_TIME \\"
    echo "    -t $DOCKER_IMAGE_NAME:latest ."
else
    "${DOCKER_CMD[@]}" build -f config/Dockerfile \
        --build-arg ENV_FILE=.env.local \
        --build-arg BUILD_ID=local \
        --build-arg GIT_COMMIT="$GIT_COMMIT" \
        --build-arg BUILD_TIME="$BUILD_TIME" \
        -t "$DOCKER_IMAGE_NAME:latest" .
fi

# --- Run container ---
echo "🚀 Starting container: $DOCKER_CONTAINER_NAME"

# Set DISABLE_RATE_LIMIT based on flag
if [ "$ENABLE_RATE_LIMIT" = "true" ]; then
    DISABLE_RATE_LIMIT_VALUE="false"
else
    DISABLE_RATE_LIMIT_VALUE="true"
fi

# Build run command arguments
RUN_ARGS=(run --name "$DOCKER_CONTAINER_NAME" -p "$DOCKER_PORT:80")

if [ "$REMOTE_MODE" = "true" ]; then
    # Remote mode: bind mount data on PC if REMOTE_DATA_PATH is set
    if [ -n "$REMOTE_DATA_PATH" ]; then
        echo "📁 Using remote data path: $REMOTE_DATA_PATH"
        # Create directory on remote host
        ssh "${REMOTE_SSH_USER}@${REMOTE_HOST}" "mkdir -p '$REMOTE_DATA_PATH'" 2>/dev/null || true
        RUN_ARGS+=(-v "$REMOTE_DATA_PATH:/app/data")
    fi
else
    # Local mode: bind mount workflows only. Data (/app/data) is left ephemeral
    # (inside the container) on purpose: a macOS bind mount uses osxfs/gRPC-FUSE which
    # does NOT honor SQLite file locking, so concurrent writers (the app + tests that
    # seed via `docker exec sqlite3`) corrupt the DB ("database disk image is malformed").
    # Ephemeral storage uses the container's native Linux fs where locking works, matching
    # the remote setup. Inspect the local DB via: docker exec <container> sqlite3 /app/data/moira.db ...
    RUN_ARGS+=(-v "$(pwd)/workflows:/app/workflows")

    # Optional: merge additional workflow catalogs into the local-dev container.
    # EXTRA_WORKFLOWS_DIRS is a :-separated list of HOST paths, each a catalog base dir
    # that contains a flows/ subdir (e.g. a private catalog kept outside this repo).
    # Each is bind-mounted and appended to the container's WORKFLOWS_DIRS so the catalog
    # loader merges them (later entries win on (owner, slug) collisions). Paths may be
    # relative to the repo root (resolved to absolute below) or absolute.
    if [ -n "$EXTRA_WORKFLOWS_DIRS" ]; then
        CONTAINER_WORKFLOWS_DIRS="./workflows/production"
        EXTRA_IDX=0
        IFS=':' read -ra EXTRA_DIR_LIST <<< "$EXTRA_WORKFLOWS_DIRS"
        for EXTRA_DIR in "${EXTRA_DIR_LIST[@]}"; do
            [ -z "$EXTRA_DIR" ] && continue
            EXTRA_ABS=$(cd "$EXTRA_DIR" 2>/dev/null && pwd)
            if [ -z "$EXTRA_ABS" ]; then
                echo "  ⚠️  EXTRA_WORKFLOWS_DIRS entry not found, skipping: $EXTRA_DIR"
                continue
            fi
            RUN_ARGS+=(-v "$EXTRA_ABS:/app/extra-workflows-$EXTRA_IDX")
            CONTAINER_WORKFLOWS_DIRS="$CONTAINER_WORKFLOWS_DIRS:./extra-workflows-$EXTRA_IDX"
            echo "  📂 Extra workflow catalog: $EXTRA_ABS -> /app/extra-workflows-$EXTRA_IDX"
            EXTRA_IDX=$((EXTRA_IDX + 1))
        done
        if [ "$EXTRA_IDX" -gt 0 ]; then
            RUN_ARGS+=(-e "WORKFLOWS_DIRS=$CONTAINER_WORKFLOWS_DIRS")
        fi
    fi
fi

RUN_ARGS+=(-e "DISABLE_RATE_LIMIT=$DISABLE_RATE_LIMIT_VALUE")
RUN_ARGS+=(-d "$DOCKER_IMAGE_NAME:latest")

if [ "$DRY_RUN" = "true" ]; then
    echo "[DRY-RUN] ${DOCKER_CMD[*]} ${RUN_ARGS[*]}"
    echo ""
    echo "[DRY-RUN] Would wait for health check at http://$APP_HOST:$DOCKER_PORT/startup-ready"
    exit 0
fi

"${DOCKER_CMD[@]}" "${RUN_ARGS[@]}"

# --- Wait for application to start ---
echo "⏳ Waiting for application to start..."

TIMEOUT=30
ELAPSED=0
READY_URL="http://$APP_HOST:$DOCKER_PORT/startup-ready"

while [ $ELAPSED -lt $TIMEOUT ]; do
    if curl -f -s "$READY_URL" > /dev/null 2>&1; then
        echo ""
        echo "✅ Application started successfully!"
        echo "🌐 Access at: http://$APP_HOST:$DOCKER_PORT"
        echo "📊 MCP Server: http://$APP_HOST:$DOCKER_PORT/mcp"
        if [ "$REMOTE_MODE" = "true" ]; then
            echo "🔗 SSH Tunnel: localhost:$DOCKER_PORT -> $REMOTE_HOST:$DOCKER_PORT"
            echo "   MCP auth via: http://localhost:$DOCKER_PORT/mcp"
        fi

        echo "📋 Container status:"
        "${DOCKER_CMD[@]}" ps --filter "name=$DOCKER_CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        exit 0
    fi

    # Check if container is still running
    if ! "${DOCKER_CMD[@]}" ps --filter "name=$DOCKER_CONTAINER_NAME" --format "{{.Names}}" 2>/dev/null | grep -q "$DOCKER_CONTAINER_NAME"; then
        echo ""
        echo "❌ Container stopped unexpectedly!"
        echo "📋 Last logs:"
        "${DOCKER_CMD[@]}" logs --tail 50 "$DOCKER_CONTAINER_NAME"
        exit 1
    fi

    sleep 1
    ELAPSED=$((ELAPSED + 1))
    echo -n "."
done

echo ""
echo "❌ Application failed to start within ${TIMEOUT} seconds!"
echo "📋 Container logs:"
"${DOCKER_CMD[@]}" logs --tail 100 "$DOCKER_CONTAINER_NAME"
echo ""
echo "📋 Startup health check logs:"
"${DOCKER_CMD[@]}" exec "$DOCKER_CONTAINER_NAME" cat /var/log/supervisor/startup-health.log 2>/dev/null || echo "Health check log not available"
exit 1
