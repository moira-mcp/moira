/**
 * MCP Client Types
 */

export type SetupType = "config" | "cli" | "gui" | "deeplink";
export type ClientCategory = "web" | "desktop" | "ide" | "cli";
export type ConfigLanguage = "json" | "yaml" | "text" | "bash";

/** Identifies which config generator function to use */
export type ConfigGeneratorId =
  | "mcp-json"
  | "claude-code-cli"
  | "copilot-cli-json"
  | "continue-yaml"
  | "zed-json"
  | "gemini-cli-json";

/** Identifies which deeplink generator function to use */
export type DeeplinkGeneratorId = "cursor" | "vscode";

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
  | "copilot-cli-json-token"
  | "continue-yaml-token"
  | "zed-json-token"
  | "gemini-cli-json-token";

/**
 * Setup panel configuration for dynamic rendering.
 * Combined with setupType, this fully describes how to render the client's tab panel.
 */
export interface ClientSetup {
  /** Primary code block title */
  primaryTitle?: string;
  /** Generator for primary code content. If undefined, content comes from i18n */
  primaryGenerator?: ConfigGeneratorId;
  /** Auth section — present for cli and deeplink clients */
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
  /** Setup type determines panel template */
  setupType: SetupType;
  /** Category for grouping */
  category: ClientCategory;
  /** Whether OAuth is required */
  requiresOAuth: boolean;
  /** URL for more info (optional) */
  url?: string;
  /** Deeplink generator for this client */
  deeplinkGenerator?: DeeplinkGeneratorId;
  /** Setup panel configuration for dynamic rendering */
  setup: ClientSetup;
}
