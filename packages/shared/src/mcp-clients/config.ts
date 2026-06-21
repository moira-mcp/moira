/**
 * MCP Configuration Generators
 *
 * Generates MCP config snippets and deeplinks for various clients.
 * Used by landing page QuickStart and web app QuickStartCard.
 */

import type { ConfigGeneratorId, DeeplinkGeneratorId, TokenConfigGeneratorId } from "./types.js";

/**
 * Generate standard MCP JSON config with HTTP transport.
 * Works for Cursor (~/.cursor/mcp.json), Claude Code (~/.config/claude/mcp.json),
 * VS Code (.vscode/mcp.json), and other clients that accept JSON config.
 */
export function generateMcpConfig(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        moira: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Generate Claude Code CLI command with native HTTP transport
 */
export function generateClaudeCodeCommand(mcpUrl: string): string {
  return `claude mcp add --transport http moira ${mcpUrl}`;
}

/**
 * Generate Cursor deeplink URL
 * Format: cursor://anysphere.cursor-deeplink/mcp/install?name=NAME&config=BASE64_CONFIG
 */
export function generateCursorDeeplink(mcpUrl: string): string {
  const config = JSON.stringify({ url: mcpUrl });
  const base64Config = btoa(String.fromCharCode(...new TextEncoder().encode(config)));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=moira&config=${encodeURIComponent(base64Config)}`;
}

/**
 * Generate VS Code deeplink URL
 * Format: vscode:mcp/install?CONFIG_JSON
 */
export function generateVSCodeDeeplink(mcpUrl: string): string {
  const config = JSON.stringify({
    name: "moira",
    type: "http",
    url: mcpUrl,
  });
  return `vscode:mcp/install?${encodeURIComponent(config)}`;
}

/**
 * Generate GitHub Copilot CLI MCP config.
 * Goes in ~/.copilot/mcp-config.json (user-level) or .copilot/mcp-config.json (project-level).
 */
export function generateCopilotCliConfig(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        moira: {
          type: "http",
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Generate Continue config (YAML format) with HTTP transport
 */
export function generateContinueConfig(mcpUrl: string): string {
  return `mcpServers:
  - name: moira
    url: ${mcpUrl}`;
}

/**
 * Generate Zed editor context_servers config.
 * Goes in ~/.config/zed/settings.json (user-level) or .zed/settings.json (project-level).
 */
export function generateZedConfig(mcpUrl: string): string {
  return JSON.stringify(
    {
      context_servers: {
        moira: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Generate Gemini CLI MCP config.
 * Goes in ~/.gemini/settings.json (user-level) or .gemini/settings.json (project-level).
 */
export function generateGeminiCliConfig(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        moira: {
          httpUrl: mcpUrl,
        },
      },
    },
    null,
    2,
  );
}

/** Resolve a ConfigGeneratorId to the actual generator function */
export const configGenerators: Record<ConfigGeneratorId, (mcpUrl: string) => string> = {
  "mcp-json": generateMcpConfig,
  "claude-code-cli": generateClaudeCodeCommand,
  "copilot-cli-json": generateCopilotCliConfig,
  "continue-yaml": generateContinueConfig,
  "zed-json": generateZedConfig,
  "gemini-cli-json": generateGeminiCliConfig,
};

/** Resolve a DeeplinkGeneratorId to the actual generator function */
export const deeplinkGenerators: Record<DeeplinkGeneratorId, (mcpUrl: string) => string> = {
  cursor: generateCursorDeeplink,
  vscode: generateVSCodeDeeplink,
};

// --- Token Auth Config Generators ---
// Generate config snippets that use API Token (Bearer header) instead of OAuth.
// Token placeholder uses "moira_YOUR_TOKEN" so users know to replace it.

const TOKEN_PLACEHOLDER = "moira_YOUR_TOKEN";

/**
 * Generate standard MCP JSON config with Bearer token auth.
 * Works for Cursor, Claude Code, VS Code, and other JSON-config clients.
 */
export function generateMcpConfigWithToken(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        moira: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Generate Copilot CLI JSON config with Bearer token auth.
 */
export function generateCopilotCliConfigWithToken(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        moira: {
          type: "http",
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Generate Continue YAML config with Bearer token auth.
 */
export function generateContinueConfigWithToken(mcpUrl: string): string {
  return `mcpServers:
  - name: moira
    url: ${mcpUrl}
    headers:
      Authorization: "Bearer ${TOKEN_PLACEHOLDER}"`;
}

/**
 * Generate Zed context_servers config with Bearer token auth.
 */
export function generateZedConfigWithToken(mcpUrl: string): string {
  return JSON.stringify(
    {
      context_servers: {
        moira: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Generate Gemini CLI config with Bearer token auth.
 */
export function generateGeminiCliConfigWithToken(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        moira: {
          httpUrl: mcpUrl,
          headers: {
            Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          },
        },
      },
    },
    null,
    2,
  );
}

/** Resolve a TokenConfigGeneratorId to the actual generator function */
export const tokenConfigGenerators: Record<TokenConfigGeneratorId, (mcpUrl: string) => string> = {
  "mcp-json-token": generateMcpConfigWithToken,
  "copilot-cli-json-token": generateCopilotCliConfigWithToken,
  "continue-yaml-token": generateContinueConfigWithToken,
  "zed-json-token": generateZedConfigWithToken,
  "gemini-cli-json-token": generateGeminiCliConfigWithToken,
};
