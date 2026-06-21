#!/bin/sh

# Comprehensive health check for Docker container startup
# Checks all critical services: DB migrations, MCP server, Backend API

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "${YELLOW}🏥 Starting comprehensive health check...${NC}"

# Check 1: Database migrations completed
echo "📊 Checking database migrations..."
if [ ! -f /app/data/moira.db ]; then
    echo "${RED}❌ Database file not found!${NC}"
    exit 1
fi
echo "${GREEN}✅ Database exists${NC}"

# Check 2: MCP Server responding
echo "🔧 Checking MCP Server (port 3000)..."
MAX_RETRIES=10
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -f -s http://localhost:3000/health > /dev/null 2>&1; then
        echo "${GREEN}✅ MCP Server healthy${NC}"
        break
    fi
    RETRY=$((RETRY + 1))
    if [ $RETRY -eq $MAX_RETRIES ]; then
        echo "${RED}❌ MCP Server not responding after ${MAX_RETRIES} attempts${NC}"
        exit 1
    fi
    sleep 1
done

# Check 3: Backend API responding
echo "🌐 Checking Backend API (port 3001)..."
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    # Backend health endpoint may not exist, check if port is listening
    if nc -z localhost 3001 2>/dev/null; then
        echo "${GREEN}✅ Backend API listening${NC}"
        break
    fi
    RETRY=$((RETRY + 1))
    if [ $RETRY -eq $MAX_RETRIES ]; then
        echo "${RED}❌ Backend API not listening after ${MAX_RETRIES} attempts${NC}"
        exit 1
    fi
    sleep 1
done

# Check 4: Nginx responding
echo "📦 Checking Nginx (port 80)..."
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -f -s http://localhost:80/nginx-health > /dev/null 2>&1; then
        echo "${GREEN}✅ Nginx healthy${NC}"
        break
    fi
    RETRY=$((RETRY + 1))
    if [ $RETRY -eq $MAX_RETRIES ]; then
        echo "${RED}❌ Nginx not responding after ${MAX_RETRIES} attempts${NC}"
        exit 1
    fi
    sleep 1
done

echo "${GREEN}🎉 All services healthy - application ready!${NC}"
exit 0
