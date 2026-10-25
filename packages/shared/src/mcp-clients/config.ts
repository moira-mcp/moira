/** Native client configuration and install links. This module is browser-safe. */
import type { ConfigGeneratorId, DeeplinkGeneratorId, TokenConfigGeneratorId } from "./types.js";

const TOKEN_PLACEHOLDER = "moira_YOUR_TOKEN";
const tokenHeaders = () => ({ Authorization: `Bearer ${TOKEN_PLACEHOLDER}` });
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const mcpJson = (entry: Record<string, unknown>): string => json({ mcpServers: { moira: entry } });
const quoteShellArgument = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Cursor and Kimi accept URL-only remote entries. */
export function generateMcpConfig(mcpUrl: string): string {
  return mcpJson({ url: mcpUrl });
}

/** Claude Code requires the explicit transport in its project .mcp.json. */
export function generateClaudeCodeConfig(mcpUrl: string): string {
  return mcpJson({ type: "http", url: mcpUrl });
}

export function generateClaudeCodeCommand(mcpUrl: string): string {
  return `claude mcp add --transport http moira ${quoteShellArgument(mcpUrl)}`;
}

export function generateCopilotCliCommand(mcpUrl: string): string {
  return `copilot mcp add --transport http moira ${quoteShellArgument(mcpUrl)}`;
}

export function generateGeminiCliCommand(mcpUrl: string): string {
  return `gemini mcp add --transport http moira ${quoteShellArgument(mcpUrl)}`;
}

export function generateCodexCommand(mcpUrl: string): string {
  return `codex mcp add moira --url ${quoteShellArgument(mcpUrl)}`;
}

export function generateCodexConfig(mcpUrl: string): string {
  return `[mcp_servers.moira]\nurl = ${JSON.stringify(mcpUrl)}`;
}

export function generateCodexConfigWithToken(mcpUrl: string): string {
  return `${generateCodexConfig(mcpUrl)}\nbearer_token_env_var = "MOIRA_API_TOKEN"`;
}

export function generateCursorDeeplink(mcpUrl: string): string {
  const config = JSON.stringify({ url: mcpUrl });
  const base64Config = btoa(String.fromCharCode(...new TextEncoder().encode(config)));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=moira&config=${encodeURIComponent(base64Config)}`;
}

export function generateVSCodeDeeplink(mcpUrl: string): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "moira", type: "http", url: mcpUrl }))}`;
}

/** User ~/.copilot/mcp-config.json; portable project .mcp.json or .github/mcp.json. */
export function generateCopilotCliConfig(mcpUrl: string): string {
  return mcpJson({ type: "http", url: mcpUrl, tools: ["*"] });
}

export function generateVSCodeConfig(mcpUrl: string): string {
  return json({ servers: { moira: { type: "http", url: mcpUrl } } });
}

/** Fragment to merge into the active Continue YAML configuration. */
export function generateContinueConfig(mcpUrl: string): string {
  return `mcpServers:\n  - name: moira\n    type: streamable-http\n    url: ${JSON.stringify(mcpUrl)}`;
}

export function generateZedConfig(mcpUrl: string): string {
  return json({ context_servers: { moira: { url: mcpUrl } } });
}

/** Gemini's httpUrl is Streamable HTTP; url selects legacy SSE. */
export function generateGeminiCliConfig(mcpUrl: string): string {
  return mcpJson({ httpUrl: mcpUrl });
}

export function generateMcpConfigWithToken(mcpUrl: string): string {
  return mcpJson({ url: mcpUrl, headers: tokenHeaders() });
}

export function generateClaudeCodeConfigWithToken(mcpUrl: string): string {
  return mcpJson({ type: "http", url: mcpUrl, headers: tokenHeaders() });
}

export function generateVSCodeConfigWithToken(mcpUrl: string): string {
  return json({ servers: { moira: { type: "http", url: mcpUrl, headers: tokenHeaders() } } });
}

export function generateCopilotCliConfigWithToken(mcpUrl: string): string {
  return mcpJson({ type: "http", url: mcpUrl, tools: ["*"], headers: tokenHeaders() });
}

export function generateContinueConfigWithToken(mcpUrl: string): string {
  return `${generateContinueConfig(mcpUrl)}\n    requestOptions:\n      headers:\n        Authorization: "Bearer ${TOKEN_PLACEHOLDER}"`;
}

export function generateZedConfigWithToken(mcpUrl: string): string {
  return json({ context_servers: { moira: { url: mcpUrl, headers: tokenHeaders() } } });
}

export function generateGeminiCliConfigWithToken(mcpUrl: string): string {
  return mcpJson({ httpUrl: mcpUrl, headers: tokenHeaders() });
}

export const configGenerators: Record<ConfigGeneratorId, (mcpUrl: string) => string> = {
  "mcp-json": generateMcpConfig,
  "claude-code-json": generateClaudeCodeConfig,
  "claude-code-cli": generateClaudeCodeCommand,
  "copilot-cli-command": generateCopilotCliCommand,
  "copilot-cli-json": generateCopilotCliConfig,
  "vscode-json": generateVSCodeConfig,
  "continue-yaml": generateContinueConfig,
  "continue-yaml-token": generateContinueConfigWithToken,
  "zed-json": generateZedConfig,
  "gemini-cli-json": generateGeminiCliConfig,
  "gemini-cli-command": generateGeminiCliCommand,
  "codex-cli": generateCodexCommand,
  "codex-toml": generateCodexConfig,
  "kimi-hosted-plugin": () =>
    "/plugins install https://github.com/moira-mcp/moira/tree/master\n/reload",
};

export const deeplinkGenerators: Record<DeeplinkGeneratorId, (mcpUrl: string) => string> = {
  cursor: generateCursorDeeplink,
  vscode: generateVSCodeDeeplink,
  chatgpt: () => "https://chatgpt.com/plugins",
};

export const tokenConfigGenerators: Record<TokenConfigGeneratorId, (mcpUrl: string) => string> = {
  "mcp-json-token": generateMcpConfigWithToken,
  "claude-code-json-token": generateClaudeCodeConfigWithToken,
  "vscode-json-token": generateVSCodeConfigWithToken,
  "copilot-cli-json-token": generateCopilotCliConfigWithToken,
  "continue-yaml-token": generateContinueConfigWithToken,
  "zed-json-token": generateZedConfigWithToken,
  "gemini-cli-json-token": generateGeminiCliConfigWithToken,
  "codex-toml-token": generateCodexConfigWithToken,
};
