/**
 * MCP Client Types
 */

export type SetupType = "config" | "cli" | "gui" | "deeplink";
export type ClientCategory = "web" | "desktop" | "ide" | "cli";
export type ConfigLanguage = "json" | "yaml" | "toml" | "text" | "bash";

/** Identifies which config generator function to use */
export type ConfigGeneratorId =
  | "mcp-json"
  | "claude-code-json"
  | "claude-code-cli"
  | "copilot-cli-command"
  | "copilot-cli-json"
  | "vscode-json"
  | "continue-yaml"
  | "continue-yaml-token"
  | "zed-json"
  | "gemini-cli-json"
  | "gemini-cli-command"
  | "codex-cli"
  | "codex-toml"
  | "kimi-hosted-plugin";

/** Identifies which deeplink generator function to use */
export type DeeplinkGeneratorId = "cursor" | "vscode" | "chatgpt";

/** Auth section in setup panel */
export interface SetupAuth {
  /** Code block language */
  language: ConfigLanguage;
  /** Code block title */
  title: string;
}

/** Alternative config section (collapsible) */
export interface SetupAlternative {
  /** Code block language */
  language: ConfigLanguage;
  /** Code block title (e.g., file path) */
  title?: string;
  /** Generator for alternative content */
  generator?: ConfigGeneratorId;
}

/** Token auth config section (collapsible) — shows how to use API Token instead of OAuth */
export interface SetupTokenAuth {
  /** Code block language for the token config example */
  language: ConfigLanguage;
  /** Code block title (e.g., file path) */
  title?: string;
  /** Generator for token auth config content */
  generator: TokenConfigGeneratorId;
}

/** Identifies which token config generator function to use */
export type TokenConfigGeneratorId =
  | "mcp-json-token"
  | "claude-code-json-token"
  | "vscode-json-token"
  | "copilot-cli-json-token"
  | "continue-yaml-token"
  | "zed-json-token"
  | "gemini-cli-json-token"
  | "codex-toml-token";

/**
 * Setup panel configuration for dynamic rendering.
 * The shared presentation builder resolves this data for every rendering surface.
 */
export interface ClientSetup {
  /** Primary code block title */
  primaryTitle?: string;
  /** Generator for primary code content; GUI clients display the configured URL. */
  primaryGenerator?: ConfigGeneratorId;
  /** Optional authentication command, in addition to the common explanation. */
  auth?: SetupAuth;
  /** Collapsible alternative config section */
  alternative?: SetupAlternative;
  /** Collapsible token auth section — shows API Token config as alternative to OAuth */
  tokenAuth?: SetupTokenAuth;
}

export interface McpClient {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Configuration file path or location */
  configPath?: string;
  /** Config language for primary code block */
  configLanguage: ConfigLanguage;
  /** Client setup category; rendering uses the resolved presentation fields. */
  setupType: SetupType;
  /** Category for grouping */
  category: ClientCategory;
  /** Official client MCP documentation. */
  url: string;
  /** Deeplink generator for this client */
  deeplinkGenerator?: DeeplinkGeneratorId;
  /** Setup panel configuration for dynamic rendering */
  setup: ClientSetup;
}
