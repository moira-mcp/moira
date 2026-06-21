# MCP Inspector

Visual testing tool for MCP servers running in Docker.

## Quick Start

```bash
docker compose -f docker-compose.inspector.yml --env-file .env.inspector up -d
```

Access: http://localhost:6274

## Configuration

File: `.env.inspector`

```bash
DANGEROUSLY_OMIT_AUTH=true  # No authentication required
HOST=0.0.0.0                # Accessible from network
```

## Connecting to MCP Moira

1. Start MCP Inspector: `docker compose -f docker-compose.inspector.yml up -d`
2. Start MCP Moira Docker: `npm run docker:restart`
3. Open http://localhost:6274
4. Connect to: `http://localhost:${DOCKER_PORT}/mcp`

## Commands

```bash
docker compose -f docker-compose.inspector.yml --env-file .env.inspector up -d    # Start
docker compose -f docker-compose.inspector.yml down                                # Stop
docker compose -f docker-compose.inspector.yml logs -f                             # Logs
```

## Ports

- 6274: Web UI
- 6277: MCP Proxy

## Security Warning

`DANGEROUSLY_OMIT_AUTH=true` disables authentication. Use only in trusted local network (CVE-2025-49596).

## Testing Workflow

1. Verify connectivity (Resources/Prompts/Tools tabs)
2. Test tool schemas with sample inputs
3. Monitor server messages in Notifications pane
4. Test edge cases and error handling

## Docker Configuration

File: `docker-compose.inspector.yml`

Uses official image: `ghcr.io/modelcontextprotocol/inspector:latest`
