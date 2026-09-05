---
title: MCP Clients Integration
description: Connect Moira with various MCP-compatible AI clients
---

Moira works with any client that supports the Model Context Protocol (MCP). This guide covers setup for commonly used MCP clients.

## MCP Protocol Overview

Moira exposes tools through MCP Streamable HTTP:

- **Endpoint**: `{MCP_URL}`
- **Transport**: Streamable HTTP; successful responses may use SSE streaming
- **Authentication**: OAuth 2.1 or API Token

## Client Configuration
