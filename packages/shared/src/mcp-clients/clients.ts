/**
 * MCP Clients Registry
 *
 * Single source of truth for all MCP client definitions.
 * Used by landing page, web app dashboard, and documentation.
 */

import type { McpClient, ClientCategory } from "./types.js";

export const mcpClients: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "CLI for developers",
    configPath: "~/.config/claude/mcp.json",
    configLanguage: "bash",
    setupType: "cli",
    category: "cli",
    requiresOAuth: true,
    setup: {
      primaryTitle: "Terminal",
      primaryGenerator: "claude-code-cli",
      auth: { language: "bash", title: "OAuth Flow" },
      alternative: { language: "json", generator: "mcp-json" },
      tokenAuth: {
        language: "json",
        title: "~/.config/claude/mcp.json",
        generator: "mcp-json-token",
      },
    },
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    description: "Copilot coding agent in terminal",
    configPath: "~/.copilot/mcp-config.json",
    configLanguage: "json",
    setupType: "cli",
    category: "cli",
    requiresOAuth: true,
    setup: {
      primaryTitle: "~/.copilot/mcp-config.json",
      primaryGenerator: "copilot-cli-json",
      auth: { language: "text", title: "OAuth Flow" },
      alternative: { language: "text" },
      tokenAuth: {
        language: "json",
        title: "~/.copilot/mcp-config.json",
        generator: "copilot-cli-json-token",
      },
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "AI-first code editor",
    configPath: "~/.cursor/mcp.json",
    configLanguage: "json",
    setupType: "deeplink",
    category: "ide",
    requiresOAuth: true,
    url: "https://cursor.sh",
    deeplinkGenerator: "cursor",
    setup: {
      auth: { language: "text", title: "OAuth Flow" },
      alternative: { language: "json", title: "~/.cursor/mcp.json", generator: "mcp-json" },
      tokenAuth: { language: "json", title: "~/.cursor/mcp.json", generator: "mcp-json-token" },
    },
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    description: "Desktop application",
    configLanguage: "text",
    setupType: "gui",
    category: "desktop",
    requiresOAuth: true,
    setup: {
      primaryTitle: "Settings → Connectors",
    },
  },
  {
    id: "vscode",
    name: "VS Code",
    description: "With MCP extension",
    configPath: "settings.json",
    configLanguage: "json",
    setupType: "deeplink",
    category: "ide",
    requiresOAuth: true,
    deeplinkGenerator: "vscode",
    setup: {
      auth: { language: "text", title: "OAuth Flow" },
      alternative: { language: "json", title: "settings.json", generator: "mcp-json" },
      tokenAuth: { language: "json", title: "settings.json", generator: "mcp-json-token" },
    },
  },
  {
    id: "claude-web",
    name: "Claude Web",
    description: "claude.ai browser chat (Pro/Max/Team/Enterprise)",
    configLanguage: "text",
    setupType: "gui",
    category: "web",
    requiresOAuth: true,
    url: "https://claude.ai",
    setup: {
      primaryTitle: "Settings → Connectors",
    },
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "chat.openai.com browser chat (Plus/Pro)",
    configLanguage: "text",
    setupType: "gui",
    category: "web",
    requiresOAuth: true,
    url: "https://chat.openai.com",
    setup: {
      primaryTitle: "Settings → Connectors",
    },
  },
  {
    id: "perplexity",
    name: "Perplexity",
    description: "Mac app with PerplexityXPC helper",
    configLanguage: "text",
    setupType: "gui",
    category: "desktop",
    requiresOAuth: true,
    url: "https://perplexity.ai",
    setup: {
      primaryTitle: "Settings → Connectors",
    },
  },
  {
    id: "continue",
    name: "Continue",
    description: "Open-source AI assistant for VS Code",
    configPath: "config.yaml",
    configLanguage: "yaml",
    setupType: "config",
    category: "ide",
    requiresOAuth: true,
    url: "https://continue.dev",
    setup: {
      primaryTitle: "config.yaml",
      primaryGenerator: "continue-yaml",
      tokenAuth: { language: "yaml", title: "config.yaml", generator: "continue-yaml-token" },
    },
  },
  {
    id: "zed",
    name: "Zed",
    description: "Fast code editor with AI features",
    configPath: "~/.config/zed/settings.json",
    configLanguage: "json",
    setupType: "config",
    category: "ide",
    requiresOAuth: true,
    url: "https://zed.dev",
    setup: {
      primaryTitle: "~/.config/zed/settings.json",
      primaryGenerator: "zed-json",
      tokenAuth: {
        language: "json",
        title: "~/.config/zed/settings.json",
        generator: "zed-json-token",
      },
    },
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    description: "Google AI terminal assistant",
    configPath: "~/.gemini/settings.json",
    configLanguage: "json",
    setupType: "config",
    category: "cli",
    requiresOAuth: true,
    url: "https://github.com/google-gemini/gemini-cli",
    setup: {
      primaryTitle: "~/.gemini/settings.json",
      primaryGenerator: "gemini-cli-json",
      tokenAuth: {
        language: "json",
        title: "~/.gemini/settings.json",
        generator: "gemini-cli-json-token",
      },
    },
  },
];

export function getClientById(id: string): McpClient | undefined {
  return mcpClients.find((client) => client.id === id);
}

export function getClientsByCategory(category: ClientCategory): McpClient[] {
  return mcpClients.filter((client) => client.category === category);
}

export function getClientIds(): string[] {
  return mcpClients.map((client) => client.id);
}

export const CLIENT_COUNT = mcpClients.length;
