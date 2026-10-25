/** Client metadata and native formats shared by help, dashboard, docs and landing. */
import type { McpClient, ClientCategory } from "./types.js";

export const mcpClients: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Claude terminal agent",
    configPath: ".mcp.json",
    configLanguage: "bash",
    setupType: "cli",
    category: "cli",
    url: "https://code.claude.com/docs/en/mcp",
    setup: {
      primaryTitle: "Terminal",
      primaryGenerator: "claude-code-cli",
      auth: { language: "bash", title: "Terminal" },
      alternative: { language: "json", title: ".mcp.json", generator: "claude-code-json" },
      tokenAuth: { language: "json", title: ".mcp.json", generator: "claude-code-json-token" },
    },
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    description: "Copilot terminal agent",
    configPath: "~/.copilot/mcp-config.json",
    configLanguage: "bash",
    setupType: "cli",
    category: "cli",
    url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
    setup: {
      primaryTitle: "Terminal",
      primaryGenerator: "copilot-cli-command",
      auth: { language: "text", title: "Copilot CLI" },
      alternative: {
        language: "json",
        title: "~/.copilot/mcp-config.json",
        generator: "copilot-cli-json",
      },
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
    description: "AI code editor",
    configPath: "~/.cursor/mcp.json",
    configLanguage: "json",
    setupType: "deeplink",
    category: "ide",
    url: "https://prod.cursor.com/help/customization/mcp",
    deeplinkGenerator: "cursor",
    setup: {
      alternative: { language: "json", title: "~/.cursor/mcp.json", generator: "mcp-json" },
      tokenAuth: { language: "json", title: "~/.cursor/mcp.json", generator: "mcp-json-token" },
    },
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    description: "Claude desktop remote connector",
    configLanguage: "text",
    setupType: "gui",
    category: "desktop",
    url: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    setup: {},
  },
  {
    id: "vscode",
    name: "VS Code",
    description: "VS Code native MCP integration",
    configPath: ".vscode/mcp.json",
    configLanguage: "json",
    setupType: "deeplink",
    category: "ide",
    url: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
    deeplinkGenerator: "vscode",
    setup: {
      alternative: { language: "json", title: ".vscode/mcp.json", generator: "vscode-json" },
      tokenAuth: { language: "json", title: ".vscode/mcp.json", generator: "vscode-json-token" },
    },
  },
  {
    id: "claude-web",
    name: "Claude Web",
    description: "Claude browser remote connector",
    configLanguage: "text",
    setupType: "gui",
    category: "web",
    url: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    setup: {},
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "ChatGPT custom MCP plugin",
    configLanguage: "text",
    setupType: "gui",
    category: "web",
    url: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
    deeplinkGenerator: "chatgpt",
    setup: {},
  },
  {
    id: "perplexity",
    name: "Perplexity",
    description: "Perplexity remote connector",
    configLanguage: "text",
    setupType: "gui",
    category: "web",
    url: "https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors",
    setup: {},
  },
  {
    id: "continue",
    name: "Continue",
    description: "Continue Agent MCP configuration",
    configPath: "~/.continue/config.yaml",
    configLanguage: "yaml",
    setupType: "config",
    category: "ide",
    url: "https://docs.continue.dev/customize/deep-dives/mcp",
    setup: {
      primaryTitle: "~/.continue/config.yaml",
      primaryGenerator: "continue-yaml-token",
    },
  },
  {
    id: "zed",
    name: "Zed",
    description: "Zed Agent remote MCP server",
    configPath: "~/.config/zed/settings.json",
    configLanguage: "json",
    setupType: "config",
    category: "ide",
    url: "https://zed.dev/docs/ai/mcp",
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
    description: "Gemini terminal agent",
    configPath: "~/.gemini/settings.json",
    configLanguage: "bash",
    setupType: "cli",
    category: "cli",
    url: "https://geminicli.com/docs/tools/mcp-server/",
    setup: {
      primaryTitle: "Terminal",
      primaryGenerator: "gemini-cli-command",
      auth: { language: "text", title: "Gemini CLI" },
      alternative: {
        language: "json",
        title: "~/.gemini/settings.json",
        generator: "gemini-cli-json",
      },
      tokenAuth: {
        language: "json",
        title: "~/.gemini/settings.json",
        generator: "gemini-cli-json-token",
      },
    },
  },
  {
    id: "codex",
    name: "Codex",
    description: "Codex CLI, desktop app and IDE extension",
    configPath: "~/.codex/config.toml",
    configLanguage: "bash",
    setupType: "cli",
    category: "cli",
    url: "https://learn.chatgpt.com/docs/extend/mcp",
    setup: {
      primaryTitle: "Terminal",
      primaryGenerator: "codex-cli",
      auth: { language: "bash", title: "Terminal" },
      alternative: { language: "toml", title: "~/.codex/config.toml", generator: "codex-toml" },
      tokenAuth: { language: "toml", title: "~/.codex/config.toml", generator: "codex-toml-token" },
    },
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    description: "Kimi Code remote MCP and hosted plugin",
    configPath: "~/.kimi-code/mcp.json",
    configLanguage: "json",
    setupType: "config",
    category: "cli",
    url: "https://moonshotai.github.io/kimi-code/en/customization/mcp.html",
    setup: {
      primaryTitle: "~/.kimi-code/mcp.json",
      primaryGenerator: "mcp-json",
      auth: { language: "text", title: "Kimi Code" },
      alternative: { language: "text", title: "Kimi Code", generator: "kimi-hosted-plugin" },
      tokenAuth: { language: "json", title: "~/.kimi-code/mcp.json", generator: "mcp-json-token" },
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
