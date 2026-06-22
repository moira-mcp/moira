# ===================================
# Core stage - shared between all
# ===================================
FROM node:20-alpine AS core

WORKDIR /app

# Port configuration
ENV MCP_PORT=3000
ENV WEB_BACKEND_PORT=3001
ENV WEB_FRONTEND_PORT=3002

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    nginx \
    supervisor \
    netcat-openbsd \
    sqlite

# Install Node.js global tools
RUN npm install -g tsx serve

# ===================================
# Base stage - dependencies
# ===================================
FROM core AS base

# Copy package files for dependency resolution
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages/workflow-engine/package.json ./packages/workflow-engine/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/web-backend/package.json ./packages/web-backend/
COPY packages/web-frontend/package.json ./packages/web-frontend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/docs/package.json ./packages/docs/

# Install dependencies with BuildKit cache mount
RUN --mount=type=cache,target=/root/.npm \
    npm install

# Copy library packages (needed by all)
COPY packages/shared/ ./packages/shared/
COPY packages/workflow-engine/ ./packages/workflow-engine/

# ===================================
# Build stage with environments
# ===================================
FROM base AS base-env

# Copy only the specific env file needed for build
ARG ENV_FILE=.env.local
COPY ${ENV_FILE} .env
RUN echo "✅ Using env file: ${ENV_FILE}"

# ===================================
# Frontend build stage
# ===================================
FROM base-env AS frontend-build

# BUILD_ID used to separate cache between different build contexts (local/staging/prod)
ARG BUILD_ID=default
# Web UI base path: "/" (default, self-host) or "/app" (our hosted deploy).
# webpack reads APP_BASE_PATH via DefinePlugin to derive route prefix + publicPath.
ARG APP_BASE_PATH=/
ENV APP_BASE_PATH=${APP_BASE_PATH}
COPY packages/web-frontend/ ./packages/web-frontend/
RUN --mount=type=cache,id=webpack-${BUILD_ID},target=/app/packages/web-frontend/node_modules/.cache/webpack \
    npx tsc --noEmit --project packages/web-frontend/tsconfig.json && \
    cd packages/web-frontend && npx webpack --mode production

# ===================================
# Docs build stage (Starlight static site → served at /docs)
# ===================================
FROM base-env AS docs-build

ARG BUILD_ID=default
# astro.config reads MOIRA_HOST / STATIC_ARTIFACTS_DOMAIN from .env (copied in
# base-env) to resolve the MCP/static URLs baked into doc pages.
COPY packages/docs/ ./packages/docs/
RUN --mount=type=cache,id=astro-docs-${BUILD_ID},target=/app/packages/docs/node_modules/.astro \
    cp .env ./packages/docs/.env && cd packages/docs && npx astro build

# ===================================
# Backend build stage
# ===================================
FROM base AS backend-build

COPY packages/mcp-server/ ./packages/mcp-server/
RUN npx tsc --noEmit --project packages/mcp-server/tsconfig.json

COPY packages/web-backend/ ./packages/web-backend/
RUN npx tsc --noEmit --project packages/web-backend/tsconfig.json

# ===================================
# Final stage
# ===================================
FROM core

# MCP Registry: proves this image belongs to the published server entry.
LABEL io.modelcontextprotocol.server.name="io.github.moira-mcp/moira"

# Copy from base stage
COPY --from=base /app/package*.json ./
COPY --from=base /app/tsconfig*.json ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/shared ./packages/shared
COPY --from=base /app/packages/workflow-engine ./packages/workflow-engine

# Copy backend packages from backend-build stage
COPY --from=backend-build /app/packages/mcp-server ./packages/mcp-server
COPY --from=backend-build /app/packages/web-backend ./packages/web-backend

# Copy frontend builds from build stages
COPY --from=frontend-build /app/packages/web-frontend/dist ./packages/web-frontend/dist

# Copy prompt files for migration
COPY config/prompts/ ./config/prompts/

# Copy only the specific env file needed (no secrets leakage)
ARG ENV_FILE=.env.local
COPY ${ENV_FILE} .env
RUN echo "✅ Using env file: ${ENV_FILE}"

# Web UI base path for the backend at runtime (server.ts OAuth redirect, email
# callback URLs). Must match the value used to build the frontend above.
ARG APP_BASE_PATH=/
ENV APP_BASE_PATH=${APP_BASE_PATH}

# Build metadata - written to file for runtime inspection
ARG BUILD_ID=default
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
RUN echo "commit: ${GIT_COMMIT}" > /app/BUILD_INFO && \
    echo "build_time: ${BUILD_TIME}" >> /app/BUILD_INFO && \
    echo "build_id: ${BUILD_ID}" >> /app/BUILD_INFO && \
    echo "env_file: ${ENV_FILE}" >> /app/BUILD_INFO

# Copy migration scripts and workflows
COPY scripts/ ./scripts/
COPY drizzle.config.ts ./
COPY workflows/ ./workflows/

# Make health check scripts executable
RUN chmod +x ./scripts/health-check.sh ./scripts/startup-ready.sh ./scripts/wait-for-init.sh ./scripts/init-database.sh

# Setup nginx for static files. Web UI dist destination depends on APP_BASE_PATH:
#   "/"    (self-host) → /var/www/html/      (Web UI at root, no brand landing)
#   "/app" (our deploy) → /var/www/html/app/ (Web UI under /app; landing baked at
#           root by the infra Dockerfile.infra, not here)
RUN mkdir -p /var/www/html /app/source-maps && \
    if [ "${APP_BASE_PATH}" = "/" ]; then WEBUI_DEST=/var/www/html; else WEBUI_DEST=/var/www/html/app; fi && \
    mkdir -p "${WEBUI_DEST}" && \
    # Copy frontend dist (Web UI) excluding .map files to the web root (or /app)
    find packages/web-frontend/dist -type f ! -name '*.map' -exec cp {} "${WEBUI_DEST}/" \; && \
    # Copy .map files to private source-maps directory for error analysis
    find packages/web-frontend/dist -name '*.map' -exec cp {} /app/source-maps/ \;

# Copy favicon files for nginx serving
COPY config/favicon/ /var/www/html/favicon/

# Copy the built Starlight docs site into the web root. The docs build already
# emits the `/docs/` (and `/ru/docs/`) URL structure (Starlight nested folder
# pattern), so its dist contains a `docs/` dir served by nginx at /docs.
COPY --from=docs-build /app/packages/docs/dist/ /var/www/html/

# Copy MDX docs for get_help MCP tool (raw source — get_help reads MDX via fs, no astro build needed)
# Note: docs are nested in src/content/docs/docs/ due to Starlight nested folder pattern for /docs/ URL prefix
COPY packages/docs/src/content/docs/docs ./docs
ENV DOCS_DIR=/app/docs

# Create required directories
RUN mkdir -p \
    data \
    .graph-storage/executions \
    /var/log/supervisor \
    /var/log/app \
    /etc/supervisor/conf.d \
    /run/nginx

# Copy configuration files.
# nginx: ship both mode configs, select one by APP_BASE_PATH (COPY can't pick a
# source from an ARG reliably, so COPY both then cp the chosen one).
#   "/"    → nginx-root.conf (Web UI at /, no landing)
#   "/app" → nginx-app.conf  (Web UI under /app, landing at /)
COPY config/nginx-root.conf /etc/nginx/conf-variants/nginx-root.conf
COPY config/nginx-app.conf /etc/nginx/conf-variants/nginx-app.conf
RUN if [ "${APP_BASE_PATH}" = "/" ]; then \
        cp /etc/nginx/conf-variants/nginx-root.conf /etc/nginx/http.d/default.conf; \
    else \
        cp /etc/nginx/conf-variants/nginx-app.conf /etc/nginx/http.d/default.conf; \
    fi
COPY config/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose nginx unified port and internal metrics port
EXPOSE 80 9090

# Health check: use internal metrics server for reliable health checking
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:9090/health || exit 1

# Start supervisor directly
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
