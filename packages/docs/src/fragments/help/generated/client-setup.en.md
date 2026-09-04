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
    url: {MCP_URL}
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
