/**
 * Prompt Context Extraction Utilities
 * Functions for extracting agent/model identifiers from MCP requests
 * Used for hierarchical prompt override resolution (Issue #398)
 */

import { eq } from "drizzle-orm";
import type { Request } from "express";
import {
  getDatabase,
  oauthAccessToken,
  oauthApplication,
  type McpPromptContext,
} from "@mcp-moira/shared";

// ============================================
// Agent Pattern Matching
// ============================================

/**
 * Agent identifier mapping from OAuth application names
 * Keys are matched case-insensitively against application name patterns
 */
export const AGENT_PATTERNS: Array<{ pattern: RegExp; agent: string }> = [
  { pattern: /^claude\s*(code|desktop)?$/i, agent: "claude" },
  { pattern: /^chatgpt$/i, agent: "chatgpt" },
  { pattern: /^openai\b/i, agent: "chatgpt" },
  { pattern: /^gemini$/i, agent: "gemini" },
  { pattern: /^google\s*ai\b/i, agent: "gemini" },
  { pattern: /^cursor$/i, agent: "cursor" },
];

/**
 * Extract agent identifier from OAuth application name
 * Returns null for unknown applications (uses default prompts)
 *
 * @param appName - OAuth application name (e.g., "Claude Code", "ChatGPT")
 * @returns Agent identifier (e.g., "claude", "chatgpt") or null
 */
export function extractAgentFromOAuthApp(appName: string | null | undefined): string | null {
  if (!appName) return null;

  const trimmedName = appName.trim();
  for (const { pattern, agent } of AGENT_PATTERNS) {
    if (pattern.test(trimmedName)) {
      return agent;
    }
  }

  return null; // Unknown app - use default prompts
}

// ============================================
// Model Header Validation
// ============================================

/**
 * Validate and sanitize model identifier from X-Model-Name header
 * Returns null for invalid or missing model identifiers
 *
 * Validation rules:
 * - Max length: 100 characters
 * - Allowed characters: alphanumeric, hyphen, underscore, dot
 * - Whitespace trimmed, lowercased
 *
 * @param modelHeader - Raw X-Model-Name header value
 * @returns Sanitized model identifier or null
 */
export function validateModelHeader(modelHeader: string | null | undefined): string | null {
  if (!modelHeader) return null;

  // Trim whitespace
  const trimmed = modelHeader.trim();

  // Check max length
  if (trimmed.length === 0 || trimmed.length > 100) return null;

  // Validate allowed characters: alphanumeric, hyphen, underscore, dot
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  if (!validPattern.test(trimmed)) return null;

  // Lowercase for consistency
  return trimmed.toLowerCase();
}

// ============================================
// OAuth Application Resolution
// ============================================

/**
 * Get OAuth application name from access token
 * Queries database to resolve clientId -> application name
 *
 * @param accessToken - Bearer token from Authorization header
 * @returns Application name or null
 */
export async function getOAuthAppNameFromToken(accessToken: string): Promise<string | null> {
  const database = getDatabase();

  // Get clientId from access token
  const [tokenData] = await database
    .select({ clientId: oauthAccessToken.clientId })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.accessToken, accessToken))
    .limit(1);

  if (!tokenData?.clientId) return null;

  // Get application name from clientId
  const [appData] = await database
    .select({ name: oauthApplication.name })
    .from(oauthApplication)
    .where(eq(oauthApplication.clientId, tokenData.clientId))
    .limit(1);

  return appData?.name || null;
}

// ============================================
// Request Context Extraction
// ============================================

/**
 * Extract prompt context (agent/model) from request
 * Used for hierarchical prompt override resolution
 *
 * @param req - Express request object
 * @returns McpPromptContext with agent and model identifiers (may be null)
 */
export async function extractPromptContext(req: Request): Promise<McpPromptContext> {
  const context: McpPromptContext = {
    agent: null,
    model: null,
  };

  // Extract model from X-Model-Name header
  const modelHeader = req.headers["x-model-name"];
  context.model = validateModelHeader(Array.isArray(modelHeader) ? modelHeader[0] : modelHeader);

  // Extract agent from OAuth application name
  const accessToken = req.headers.authorization?.replace("Bearer ", "");
  if (accessToken) {
    const appName = await getOAuthAppNameFromToken(accessToken);
    context.agent = extractAgentFromOAuthApp(appName);
  }

  return context;
}
