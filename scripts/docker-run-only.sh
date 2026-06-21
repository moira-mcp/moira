#!/bin/bash

# Docker run script with worktree isolation (uses existing mcp-moira:latest image)
# Reads configuration from .env file to ensure unique names per worktree

set -e

echo "🔧 Loading environment configuration..."

# Load .env file
if [ -f .env ]; then
    source .env
    echo "✅ Loaded .env file"
else
    echo "❌ .env file not found!"
    exit 1
fi

# Validate required variables
required_vars=("DOCKER_CONTAINER_NAME" "DOCKER_PORT")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Required variable $var not set in .env"
        exit 1
    fi
done

echo "📋 Configuration:"
echo "  Image: mcp-moira:latest (shared)"
echo "  Container: $DOCKER_CONTAINER_NAME"
echo "  Port: $DOCKER_PORT:80"

# Stop and remove existing container
echo "🛑 Stopping existing container..."
docker stop "$DOCKER_CONTAINER_NAME" 2>/dev/null || echo "  Container not running"
docker rm "$DOCKER_CONTAINER_NAME" 2>/dev/null || echo "  Container not found"

# Run new container
echo "🚀 Starting container: $DOCKER_CONTAINER_NAME"
docker run \
    --name "$DOCKER_CONTAINER_NAME" \
    -p "$DOCKER_PORT:80" \
    -v "$(pwd)/workflows:/app/workflows" \
    -d \
    mcp-moira:latest

echo "✅ Container started successfully!"
echo "🌐 Access at: http://localhost:$DOCKER_PORT"
echo "📊 MCP Server: http://localhost:$DOCKER_PORT/mcp"

# Show container status
echo "📋 Container status:"
docker ps --filter "name=$DOCKER_CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"