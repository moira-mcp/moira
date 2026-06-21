# @mcp-moira/mcp-server

MCP HTTP protocol server with 8 workflow management tools.

## Features

- **HTTP Transport**: StreamableHTTPServerTransport with JSON-RPC
- **8 MCP Tools**: Workflow management via MCP protocol
- **OAuth 2.1 Authentication**: Better Auth MCP plugin integration
- **Stateless Mode**: No session storage, per-request context
- **User Context**: AsyncLocalStorage for userId propagation
- **Error Handling**: Comprehensive error tracking and logging

## Authentication

All MCP requests require OAuth 2.1 authentication:

**HTTP 401 Response:**

```bash
curl -X POST http://localhost:${DOCKER_PORT}/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# Returns: HTTP 401 with WWW-Authenticate header
```

**OAuth Flow:**

1. Client receives 401 with resource metadata URL
2. Fetches /.well-known/oauth-protected-resource
3. Fetches /.well-known/oauth-authorization-server
4. Opens authorization_endpoint in browser
5. User authenticates via Better Auth UI
6. Client receives access token
7. Reconnects with Authorization: Bearer <token>

**MCP Inspector Configuration:**

```json
{
  "url": "http://localhost:${DOCKER_PORT}/mcp",
  "type": "http"
}
```

Inspector automatically handles OAuth flow via Dynamic Client Registration.

## Tools

- `list` - List available workflows
- `start` - Start workflow execution
- `step` - Execute workflow step
- `manage` - Create, edit, or get workflow (action: create|edit|get)
- `help` - Get documentation
- `settings` - User settings management (action: get|set|list)
- `session` - Session information (action: user|executions|execution_context|current_step)
- `token` - Generate upload/download tokens (action: upload|download)

## Usage

All development happens through Docker containers:

```bash
# From project root
npm run docker:restart  # Build and run Docker
# MCP endpoint: http://localhost:${DOCKER_PORT}/mcp
```

## API

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
