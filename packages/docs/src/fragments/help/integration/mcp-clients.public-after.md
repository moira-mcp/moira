### Custom Client

For custom MCP client implementations, use the MCP SDK with URL: `{MCP_URL}`

## Available Tools

The core lifecycle is `list` → `start` → repeated `step` calls, with `session` for inspecting or
resuming executions and `help` for runtime documentation. The
[generated MCP tools reference](/docs/reference/tools/) is the source for the complete current
catalog, exact input schemas, actions, and examples.

## Authentication

Moira supports two authentication methods:

### OAuth 2.1 (Default)

1. Client initiates connection to MCP endpoint 2. Server returns authentication required response
2. Client opens browser for OAuth flow 4. User authenticates with Moira 5. Client receives access
   token 6. Subsequent requests include token

:::note
OAuth token refresh is handled automatically. Catalog refresh is a separate MCP initialization
step described below. If the credential expires, re-authentication may be required.
:::

### API Tokens

For MCP clients that do not support OAuth (custom scripts, CI/CD pipelines, headless environments), use API tokens:

1. Log in to Moira web UI 2. Go to **Settings → API Tokens** 3. Click **Create Token**, enter a
   name and expiration 4. Copy the token (shown once, starts with `moira_`) 5. Configure your client
   with the token as Bearer authorization

Example configuration for a custom MCP client:

```json
{
  "mcpServers": {
    "moira": {
      "url": "YOUR_MCP_ENDPOINT",
      "headers": {
        "Authorization": "Bearer moira_your_token_here"
      }
    }
  }
}
```

:::tip
Replace `YOUR_MCP_ENDPOINT` with your Moira MCP endpoint: `{MCP_URL}`. API tokens
skip the OAuth flow entirely — use them when your client cannot open a browser for authentication.
:::

## Static Catalog Refresh

Tool descriptions and schemas are a static catalog shipped with the Moira server. A client accepts
that catalog during the MCP `initialize` handshake. This applies to both OAuth access tokens and API
tokens.

When the catalog changes, an ordinary request made with a credential that has not initialized the
current catalog returns HTTP 426 with `upgrade_required`. Reconnect or reinitialize the MCP server
with the same credential. A successful initialize refreshes the catalog for that credential; it
does not require a new API token or rotate the existing token.

:::note
Authentication and account checks run before catalog refresh. A revoked or expired credential, or
an account that cannot access MCP, still receives its normal authentication or access error.
:::

## Tool Call Examples

### List Workflows

```json
{
  "method": "tools/call",
  "params": {
    "name": "list",
    "arguments": {}
  }
}
```

### Start Workflow

```json
{
  "method": "tools/call",
  "params": {
    "name": "start",
    "arguments": {
      "workflowId": "moira/software-development-flow",
      "parentExecutionId": "none"
    }
  }
}
```

### Execute Step

```json
{
  "method": "tools/call",
  "params": {
    "name": "step",
    "arguments": {
      "processId": "abc-123",
      "input": {
        "result": "Task completed successfully",
        "details": { "files": ["main.ts", "utils.ts"] }
      }
    }
  }
}
```

## Error Handling

Common error responses:

| Error              | Cause                         | Solution                            |
| ------------------ | ----------------------------- | ----------------------------------- |
| `UNAUTHORIZED`     | Invalid/expired token         | Re-authenticate                     |
| `NOT_FOUND`        | Invalid workflow/process ID   | Verify IDs                          |
| `FORBIDDEN`        | No access to resource         | Check permissions                   |
| `upgrade_required` | MCP catalog must be refreshed | Reconnect using the same credential |
| `VALIDATION_ERROR` | Invalid input                 | Check input schema                  |

## Self-Hosted Setup

For self-hosted Moira:

1. Deploy Moira server
2. Configure MCP endpoint URL
3. Set up authentication and account access
4. Update client configuration with your endpoint

## Troubleshooting

### Connection Timeout

- Check network connectivity
- Verify endpoint URL
- Ensure SSE is not blocked by firewall

### Tools Not Appearing

- Reconnect the Moira MCP server so the client runs `initialize` again
- Keep the existing OAuth or API-token credential unless it is invalid or expired
- Verify JSON syntax in config
- Check client logs for errors

### Authentication Loop

- Clear stored tokens
- Check OAuth configuration
- Verify redirect URIs

## Related

- [Claude Code](/docs/integration/claude-code/) - Claude Code specific setup
- [Quick Start](/docs/getting-started/quickstart/) - General getting started
