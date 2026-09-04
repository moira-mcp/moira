Moira works with any client that supports the Model Context Protocol (MCP). This guide covers setup for commonly used MCP clients.

## MCP Protocol Overview

Moira exposes tools through MCP Streamable HTTP:

- **Endpoint**: `{MCP_URL}`
- **Transport**: Streamable HTTP; successful responses may use SSE streaming
- **Authentication**: OAuth 2.1 or API Token

## Client Configuration

### Claude Code

**Recommended: Use CLI command**

**Terminal**

```bash
claude mcp add --transport http moira {MCP_URL}
```

Then authenticate:

**OAuth Flow**

```bash
# After adding, authenticate within claude
/mcp
# → Select "moira"
# → Click "Authenticate"
# → Browser opens for OAuth
```

#### Alternative: Manual JSON config

```json
# Alternative: Manual JSON config
# ~/.config/claude/mcp.json
{
  "mcpServers": {
    "moira": {
      "type": "http",
      "url": "{MCP_URL}"
    }
  }
}

# Then: /mcp → Authenticate
```

#### Authentication without OAuth

For CI/CD, Docker, or environments without a browser — use an API token instead of OAuth.

1. Log in to Moira web UI → Settings → API Tokens
2. Create a token (starts with moira_)
3. Replace moira_YOUR_TOKEN below with your token

**~/.config/claude/mcp.json**

```json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Copilot CLI

**Recommended: Config file**

**~/.copilot/mcp-config.json**

```json
# ~/.copilot/mcp-config.json
{
  "mcpServers": {
    "moira": {
      "type": "http",
      "url": "{MCP_URL}"
    }
  }
}
```

Then authenticate:

**OAuth Flow**

```text
# After saving the config:
# 1. Start a Copilot CLI session
# 2. Type /mcp
# 3. Select "moira" → Authenticate
# → Browser opens for OAuth
```

#### Alternative: Interactive setup

```text
# In Copilot CLI:
/mcp
# → Click "Add server"
# → Enter server URL
# → Complete OAuth

# Project-level config:
# .copilot/mcp-config.json (same format)
```

#### Authentication without OAuth

For CI/CD, Docker, or environments without a browser — use an API token instead of OAuth.

1. Log in to Moira web UI → Settings → API Tokens
2. Create a token (starts with moira_)
3. Replace moira_YOUR_TOKEN below with your token

**~/.copilot/mcp-config.json**

```json
{
  "mcpServers": {
    "moira": {
      "type": "http",
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Cursor

**Recommended: One-click install**

[Add to Cursor]({{MCP_DEEPLINK:cursor}})

Then authenticate:

**OAuth Flow**

```text
# After clicking the button:
# 1. Cursor opens with install prompt
# 2. Click "Install" to add moira MCP server
# 3. Settings → MCP Servers → Find "moira"
# 4. Click "Authenticate" → Browser opens for OAuth
```

#### Alternative: Manual JSON config

**~/.cursor/mcp.json**

```json
# ~/.cursor/mcp.json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}"
    }
  }
}
```

#### Authentication without OAuth

For CI/CD, Docker, or environments without a browser — use an API token instead of OAuth.

1. Log in to Moira web UI → Settings → API Tokens
2. Create a token (starts with moira_)
3. Replace moira_YOUR_TOKEN below with your token

**~/.cursor/mcp.json**

```json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Claude Desktop

Desktop app: GUI method

**Settings → Connectors**

```text
# In Claude Desktop app:

# 1. Open Settings (⌘+,)
# 2. Go to "Connectors" tab
# 3. Click "Add custom connector"
# 4. Enter:
#    Server URL: {MCP_URL}
# 5. Click "Connect"
# 6. Browser opens → OAuth → Done

# No file editing
```

### VS Code

**Recommended: One-click install**

[Add to VS Code]({{MCP_DEEPLINK:vscode}})

Then authenticate:

**OAuth Flow**

```text
# After clicking the button:
# 1. VS Code opens with install prompt
# 2. Click "Install" to add moira MCP server
# 3. Settings → MCP Servers → Find "moira"
# 4. Click "Authenticate" → Browser opens for OAuth
```

#### Alternative: Manual configuration

**settings.json**

```json
# Install MCP extension:
# ext install mcp-connector

# Then in settings.json:
{
  "mcp.servers": {
    "moira": {
      "url": "{MCP_URL}",
      "transport": "http"
    }
  }
}

# Or: Command Palette → "MCP: Add Server"
```

#### Authentication without OAuth

For CI/CD, Docker, or environments without a browser — use an API token instead of OAuth.

1. Log in to Moira web UI → Settings → API Tokens
2. Create a token (starts with moira_)
3. Replace moira_YOUR_TOKEN below with your token

**settings.json**

```json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Claude Web

claude.ai - Browser chat (most popular)

**Settings → Connectors**

```text
# On claude.ai (Pro/Max/Team/Enterprise):

# 1. Go to Settings → Connectors
# 2. Click "Add custom connector"
# 3. Enter:
#    Server URL: {MCP_URL}
# 4. Click "Connect"
# 5. Complete OAuth authentication in browser
# 6. Tools appear in chat

# Requires paid plan
```

### ChatGPT

chat.openai.com - Browser chat

**Settings → Connectors**

```text
# On chat.openai.com (Plus/Pro required):

# 1. Profile → Settings
# 2. Go to "Connectors" or "Integrations"
# 3. Click "Add connector"
# 4. Enter:
#    Name: MCP Moira
#    URL: {MCP_URL}
# 5. Complete OAuth authentication
# 6. Tools available in chat

# Free tier doesn't support MCP
```

### Perplexity

Mac app: With helper

**Settings → Connectors**

```text
# Perplexity Mac App:

# 1. Install PerplexityXPC helper first:
#    Settings → Connectors → Install Helper
# 2. Click "Add Connector"
# 3. Enter:
#    Server Name: moira
#    Command: npx
#    Args: -y mcp-remote {MCP_URL}
# 4. Complete OAuth authentication
# 5. Ask Perplexity to use MCP Moira tools

# Paid plan recommended
```

### Continue

VS Code extension: Open-source AI assistant

**config.yaml**

```yaml
# Continue extension in VS Code:

# 1. Install Continue extension
# 2. Open config: Ctrl+Shift+P → "Continue: Open config"
# 3. Add to config.yaml:
#
# mcp:
#   servers:
#     moira:
#       url: {MCP_URL}
#       transport: http
#
# 4. Restart VS Code
# 5. Authenticate when prompted
```

#### Authentication without OAuth

For CI/CD, Docker, or environments without a browser — use an API token instead of OAuth.

1. Log in to Moira web UI → Settings → API Tokens
2. Create a token (starts with moira_)
3. Replace moira_YOUR_TOKEN below with your token

**config.yaml**

```yaml
mcpServers:
  - name: moira
    url: "{MCP_URL}"
    headers:
      Authorization: "Bearer moira_YOUR_TOKEN"
```

### Zed

Fast code editor with AI features

**~/.config/zed/settings.json**

```json
# Zed editor:

# 1. Open Settings (⌘+,)
# 2. Add to settings.json under context_servers:
#
# "context_servers": {
#   "moira": {
#     "url": "{MCP_URL}"
#   }
# }
#
# 3. Restart Zed
# 4. Authenticate when prompted
```

#### Authentication without OAuth

For CI/CD, Docker, or environments without a browser — use an API token instead of OAuth.

1. Log in to Moira web UI → Settings → API Tokens
2. Create a token (starts with moira_)
3. Replace moira_YOUR_TOKEN below with your token

**~/.config/zed/settings.json**

```json
{
  "context_servers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Gemini CLI

Google AI terminal assistant

**~/.gemini/settings.json**

```json
# Gemini CLI:

# 1. Edit ~/.gemini/settings.json:
#
# "mcpServers": {
#   "moira": {
#     "httpUrl": "{MCP_URL}"
#   }
# }
#
# 2. Run: gemini auth
# 3. Complete OAuth flow
```

#### Authentication without OAuth

For CI/CD, Docker, or environments without a browser — use an API token instead of OAuth.

1. Log in to Moira web UI → Settings → API Tokens
2. Create a token (starts with moira_)
3. Replace moira_YOUR_TOKEN below with your token

**~/.gemini/settings.json**

```json
{
  "mcpServers": {
    "moira": {
      "httpUrl": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

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
