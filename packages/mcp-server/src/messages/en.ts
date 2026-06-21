/**
 * Centralized English messages for MCP tools
 * All user-facing strings in one place for consistency and future i18n
 *
 * ARCHITECTURE:
 * - Tool descriptions are loaded from DB via McpTextService at server startup
 * - If DB value is missing, returns empty string (no fallback to hardcoded)
 * - System prompt is appended to help tool description from DB
 * - loadToolDescriptions() must be called before tools are registered
 */

import {
  getMcpTextService,
  type McpToolName,
  type McpPromptContext,
  DomainError,
  isDomainError,
  isNotFoundError,
  isConflictError,
  isValidationError,
  getHost,
} from "@mcp-moira/shared";

// ============================================
// Tool Descriptions (loaded from DB)
// ============================================

// System prompt is delivered via TWO mechanisms for maximum compatibility:
// 1. MCP `instructions` field in server.ts (proper MCP way)
// 2. Appended to help tool description below (fallback for clients ignoring instructions)
const SYSTEM_PROMPT_HEADER = `

---
SYSTEM INSTRUCTIONS (fallback for MCP clients without instructions field support):
`;

/**
 * Load tool descriptions from database with optional agent/model context
 * Called on each MCP client connection to get fresh descriptions
 * No caching - always reads from DB to support dynamic updates via AdminSettings UI
 *
 * Resolution order (first non-null wins):
 * 1. Model-level override: mcp.agent.{agent}.model.{model}.toolDescription.{tool}
 * 2. Agent-level override: mcp.agent.{agent}.toolDescription.{tool}
 * 3. Default: mcp.toolDescription.{tool}
 *
 * @param context - Optional agent/model identifiers for hierarchical override resolution
 */
export async function loadToolDescriptions(
  context?: McpPromptContext,
): Promise<Record<McpToolName, string>> {
  const mcpTextService = getMcpTextService();

  // Load all tool descriptions with override resolution if context provided
  const descriptions = context
    ? await mcpTextService.getAllToolDescriptionsWithOverride(context)
    : await mcpTextService.getAllToolDescriptions();

  // Load system prompt and append to help description (fallback delivery mechanism)
  const systemPrompt = context
    ? await mcpTextService.getSystemPromptWithOverride(context)
    : await mcpTextService.getSystemPrompt();

  if (descriptions.help && systemPrompt) {
    descriptions.help = descriptions.help + SYSTEM_PROMPT_HEADER + systemPrompt + "\n---";
  }

  return descriptions;
}

// ============================================
// Error Messages
// ============================================

export const ERRORS = {
  // Generic errors
  unknown_error: "Unknown error occurred",
  tool_not_found: (toolName: string) => `Tool '${toolName}' not found in registry`,
  unknown_action: (action: string) => `Unknown action: ${action}`,
  unknown_action_with_valid: (action: string, validActions: string) =>
    `Unknown action: ${action}. Valid actions: ${validActions}`,

  // Workflow errors
  workflow_not_found: (id: string) => `Workflow '${id}' not found`,
  workflow_not_found_or_denied: (id: string) => `Workflow '${id}' not found or access denied`,
  workflow_id_required: "Workflow ID is required",
  workflow_id_required_for_action: (action: string) => `Workflow ID required for ${action} action`,
  workflow_object_required: "Workflow object required for create action",
  workflow_metadata_required: "Workflow metadata required (name, version, description)",
  workflow_already_exists: (id: string) =>
    `Workflow '${id}' already exists. Use overwrite: true to replace it.`,
  workflow_validation_failed: (errors: string) => `Workflow validation failed: ${errors}`,
  modified_workflow_validation_failed: (errors: string) =>
    `Modified workflow validation failed: ${errors}`,

  // Process/Execution errors
  process_not_found: "Process not found or expired",
  process_id_required: "Process ID is required",
  execution_not_found: (id: string) => `Execution '${id}' not found`,
  execution_id_required: (action: string) => `executionId is required for ${action} action`,
  execution_access_denied: "Access denied: execution belongs to another user",
  execution_not_waiting: (status: string) =>
    `Execution is not waiting for input (current state: ${status})`,

  // Parent execution errors
  parent_execution_id_invalid_format:
    'parentExecutionId must be a valid UUID or "none" for standalone workflows',
  parent_execution_not_found: (id: string) =>
    `Parent execution '${id}' not found. Use "none" if this is a standalone workflow.`,

  // Node errors
  node_not_found: (id: string) => `Node '${id}' not found for update`,
  node_id_exists: (id: string) => `Node ID '${id}' already exists in workflow`,

  // Edit errors
  changes_required: "Changes object required with at least one modification",

  // Validation errors
  validation_failed: "Validation failed",
  invalid_input: "Invalid input data",
  missing_required_field: (field: string) => `Missing required field: ${field}`,
  invalid_action: (action: string) => `Invalid action: ${action}`,

  // Auth errors
  auth_required: "Authentication required",
  access_denied: "Access denied",
  access_denied_to_execution: "Access denied to this execution",
  account_blocked: (reason?: string) =>
    reason ? `Account is blocked: ${reason}` : "Account is blocked",
  invalid_token: "Invalid or expired token",
  user_not_found: (id: string) => `User ${id} not found in database`,

  // Settings errors
  setting_key_required: "Setting key required for set action",
  setting_not_found: (key: string) => `Setting definition not found: ${key}`,
  setting_read_only: (key: string) => `Setting '${key}' is read-only`,
  admin_only_setting: (key: string) => `Setting '${key}' is admin-only`,

  // Execution state errors
  // Issue #386: "waiting" merged into "running"
  cannot_edit_execution: (status: string) =>
    `Cannot edit execution in state '${status}'. Only 'running' executions can be edited.`,

  // Help/Documentation errors
  documentation_file_not_found: (file: string, docsDir: string) =>
    `Documentation file not found: ${file}\n\nMake sure DOCS_DIR is configured correctly. Current: ${docsDir}`,
  unknown_help_topic: (topic: string) => `Unknown topic: ${topic}`,

  // File/Token errors
  token_expired: "Token has expired",
  token_invalid: "Invalid token",
  upload_failed: "Upload failed",
  download_failed: "Download failed",
  workflow_id_required_for_download: "workflowId required for download action",
} as const;

// ============================================
// Telegram Pre-flight Messages
// ============================================

export const TELEGRAM = {
  /** Synthetic directive returned when workflow has telegram nodes but user hasn't configured Telegram */
  preflight_directive: (workflowId: string) =>
    `This workflow contains Telegram notification nodes, but your Telegram integration is not configured.\n\n` +
    `To receive Telegram notifications from this workflow, you need to:\n` +
    `1. Create a Telegram bot via @BotFather\n` +
    `2. Send any message to your bot (so it can message you back)\n` +
    `3. Configure your bot token and chat ID in Settings → Telegram\n\n` +
    `You can use the guided setup workflow: start({ workflowId: "moira/telegram-setup", parentExecutionId: "none" })\n\n` +
    `Or skip this check and start the workflow without Telegram notifications:\n` +
    `start({ workflowId: "${workflowId}", skipTelegramCheck: true, parentExecutionId: "none" })`,

  preflight_completion_condition:
    "Configure Telegram integration via Settings or the telegram-setup workflow, then start this workflow again. Or use skipTelegramCheck: true to proceed without Telegram notifications.",

  /** Handler error messages - shown to agents during workflow execution via messageQueue */
  handler_not_configured:
    'Telegram notifications are not configured. Set up in Settings → Telegram or use the guided setup workflow: start({ workflowId: "moira/telegram-setup", parentExecutionId: "none" })',
  handler_chat_not_found:
    "Chat not found. You need to send any message to your bot first, then try again.",
  handler_invalid_token:
    "Bot token is invalid or expired. Get a new token from @BotFather and update it in Settings → Telegram.",
  handler_network_error:
    "Network error connecting to Telegram API. Check internet connection and try again.",
  handler_rate_limited: "Telegram API rate limit reached. Please wait a moment and try again.",
  handler_timeout: "Telegram API request timed out. Please try again.",
  handler_message_too_long: "Message exceeds 4096 character limit. Shorten the message template.",
} as const;

// ============================================
// Success Messages
// ============================================

export const SUCCESS = {
  workflow_started: (processId: string) => `Workflow started with process ID: ${processId}`,
  workflow_created: (id: string) => `Workflow '${id}' created successfully`,
  workflow_updated: (id: string) => `Workflow '${id}' updated successfully`,
  workflow_deleted: (id: string) => `Workflow '${id}' deleted successfully`,

  setting_updated: (key: string) => `Setting '${key}' updated successfully`,
  setting_deleted: (key: string) => `Setting '${key}' deleted successfully`,

  token_created: "Token created successfully",
  context_updated: (executionId: string) => `Execution context updated for '${executionId}'`,
} as const;

// ============================================
// Validation Help Messages
// ============================================

export const VALIDATION_HELP = {
  // General validation errors
  general: [
    "Check field names match schema exactly (case sensitive)",
    "Verify required fields are provided",
    "Check data types (string vs number vs boolean)",
    "Use the inputSchema from directive response as reference",
  ],
  // JSON parsing errors
  json_format: [
    "Check for missing quotes around string values",
    "Remove trailing commas after last array/object item",
    "Ensure all brackets are properly matched: { } [ ]",
    "Use JSON validator (jsonlint.com) to check syntax",
  ],
  // Workflow not found errors
  workflow_troubleshooting: [
    "Verify workflow ID is correct",
    "Use list() to see available workflows",
    "Check if workflow was created successfully",
  ],
  // Process/execution not found errors
  process_troubleshooting: [
    "Verify process ID is correct",
    "Use session({ action: 'executions' }) to list active executions",
    "Check if workflow execution is still active",
  ],
  // Authentication errors (401/403)
  auth_troubleshooting: [
    "Re-authorize MCP server in client settings",
    "Token may have expired - re-authenticate",
    `Check account status at ${getHost()}`,
  ],
  // Connection/server errors
  connection_troubleshooting: [
    `Check MCP server status at ${getHost()}`,
    "Verify network connectivity",
    "Try reconnecting MCP server in client settings",
  ],
  // Tool signature changed (after server update)
  tool_update_troubleshooting: [
    "MCP server may have been updated",
    "Reconnect MCP server to get latest tool definitions",
    `Check ${getHost()} for release notes`,
  ],
  // Settings permission errors
  settings_troubleshooting: [
    "Only user settings can be modified",
    "Admin-only settings require admin privileges",
    "Use settings({ action: 'list' }) to see available settings",
  ],
  // Help topic not found
  help_troubleshooting: [
    "Use help() without arguments to see all available topics",
    "Check topic name spelling",
    "Try using topic aliases: overview, intro, pattern",
  ],
} as const;

// ============================================
// Agent Instructions for Error Recovery
// ============================================

/**
 * Agent instructions embedded in error messages to ensure agents STOP and WAIT
 * when encountering errors instead of continuing independently.
 */
export const AGENT_INSTRUCTIONS = {
  // Workflow not found - agent should verify ID and use list()
  workflow_not_found: `
AGENT INSTRUCTIONS:
1. Verify the workflow ID is correct (check spelling, case sensitivity)
2. Use list() to see all available workflows
3. If workflow truly doesn't exist - STOP and report to user
Do NOT continue independently. Do NOT guess alternative workflows.`,

  // Process/execution not found or expired
  process_not_found: `
AGENT INSTRUCTIONS:
1. Use session({ action: 'executions' }) to list your active executions
2. If the execution expired, you may need to restart the workflow with start()
3. If unable to recover - STOP and report to user with the error details
Do NOT continue independently. Do NOT ignore this error.`,

  // Validation failed - agent should check schema and fix input
  validation_failed: `
AGENT INSTRUCTIONS:
1. Review the inputSchema from the previous directive response
2. Check that your input matches the required structure exactly
3. Fix the validation error and retry with corrected input
4. If unclear how to fix - STOP and ask user for guidance
Do NOT continue independently. Do NOT skip validation.`,

  // Authentication required - agent should reconnect
  auth_required: `
AGENT INSTRUCTIONS:
1. Your MCP session may have expired
2. Reconnect to MCP server in client settings
3. If reconnection fails - STOP and report to user
Do NOT continue independently. Do NOT ignore authentication errors.`,

  // Connection/server error - agent should retry then stop
  connection_error: `
AGENT INSTRUCTIONS:
1. This may be a temporary server issue - wait a few seconds and retry
2. If error persists after 2-3 retries - STOP and report to user
3. Check MCP server status if needed
Do NOT continue independently after repeated failures.`,

  // Access denied - agent must stop
  access_denied: `
AGENT INSTRUCTIONS:
1. You don't have permission for this operation
2. STOP immediately and report this to user
3. User may need to adjust permissions or use different credentials
Do NOT continue independently. Do NOT attempt workarounds.`,

  // Generic unrecoverable error
  unrecoverable: `
AGENT INSTRUCTIONS:
1. This error cannot be automatically recovered
2. STOP and report the full error details to user
3. WAIT for user guidance before proceeding
Do NOT continue independently. Do NOT ignore this error.`,
} as const;

/**
 * Error categories that map to specific agent instructions
 */
export type ErrorCategory =
  | "workflow_not_found"
  | "process_not_found"
  | "validation_failed"
  | "auth_required"
  | "connection_error"
  | "access_denied"
  | "unrecoverable";

// ============================================
// UI Labels and Prompts
// ============================================

export const LABELS = {
  no_result: "No result",
  no_workflows: "No workflows available",
  no_executions: "No active executions",
  no_settings: "No settings defined",

  upload_instructions: "Upload Instructions",
  download_instructions: "Download Instructions",

  token: "Token",
  expires: "Expires",
  upload_url: "Upload URL",
  download_url: "Download URL",
  method: "Method",
  content_type: "Content-Type",
  field_name: "Field name",
  file_format: "File format",
  visibility_field: "Visibility field",
  example: "Example",
} as const;

// ============================================
// Format helpers
// ============================================

/**
 * Format error with troubleshooting help AND agent instructions
 * Agent instructions ensure agents STOP and WAIT for user on errors
 */
export function formatError(
  message: string,
  helpCategory?: keyof typeof VALIDATION_HELP,
  agentCategory?: ErrorCategory,
): string {
  let result = message;

  // Add troubleshooting help if category provided
  if (helpCategory) {
    const helpItems = VALIDATION_HELP[helpCategory];
    const helpText = helpItems.map((item) => `• ${item}`).join("\n");
    result += `\n\nTroubleshooting:\n${helpText}`;
  }

  // Add agent instructions if category provided
  if (agentCategory) {
    result += AGENT_INSTRUCTIONS[agentCategory];
  }

  return result;
}

/**
 * Format error with automatic agent instruction detection
 * Detects error category from message content and adds appropriate instructions
 */
export function formatErrorWithAgentInstructions(message: string): string {
  // Detect error category from message content
  const lowerMessage = message.toLowerCase();

  let helpCategory: keyof typeof VALIDATION_HELP | undefined;
  let agentCategory: ErrorCategory | undefined;

  if (lowerMessage.includes("workflow") && lowerMessage.includes("not found")) {
    helpCategory = "workflow_troubleshooting";
    agentCategory = "workflow_not_found";
  } else if (
    lowerMessage.includes("process") &&
    (lowerMessage.includes("not found") || lowerMessage.includes("expired"))
  ) {
    helpCategory = "process_troubleshooting";
    agentCategory = "process_not_found";
  } else if (
    lowerMessage.includes("execution") &&
    (lowerMessage.includes("not found") || lowerMessage.includes("expired"))
  ) {
    helpCategory = "process_troubleshooting";
    agentCategory = "process_not_found";
  } else if (
    lowerMessage.includes("validation") ||
    lowerMessage.includes("invalid input") ||
    lowerMessage.includes("schema")
  ) {
    helpCategory = "general";
    agentCategory = "validation_failed";
  } else if (lowerMessage.includes("json") || lowerMessage.includes("parse")) {
    helpCategory = "json_format";
    agentCategory = "validation_failed";
  } else if (
    lowerMessage.includes("authentication") ||
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("auth required")
  ) {
    helpCategory = "auth_troubleshooting";
    agentCategory = "auth_required";
  } else if (
    lowerMessage.includes("access denied") ||
    lowerMessage.includes("forbidden") ||
    lowerMessage.includes("permission")
  ) {
    agentCategory = "access_denied";
  } else if (
    lowerMessage.includes("connection") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("network")
  ) {
    helpCategory = "connection_troubleshooting";
    agentCategory = "connection_error";
  } else {
    // Default to unrecoverable for unknown errors
    agentCategory = "unrecoverable";
  }

  return formatError(message, helpCategory, agentCategory);
}

/**
 * Format upload token response
 */
export function formatUploadToken(data: {
  token: string;
  expiresAt: string;
  uploadUrl: string;
  uploadInstructions?: {
    method: string;
    contentType: string;
    fieldName: string;
    fileFormat: string;
    visibilityField?: string;
    example: string;
  };
}): string {
  const lines = [
    "Upload token created:",
    `${LABELS.token}: ${data.token}`,
    `${LABELS.expires}: ${data.expiresAt}`,
    `${LABELS.upload_url}: ${data.uploadUrl}`,
  ];

  if (data.uploadInstructions) {
    const inst = data.uploadInstructions;
    lines.push(
      "",
      `${LABELS.upload_instructions}:`,
      `- ${LABELS.method}: ${inst.method}`,
      `- ${LABELS.content_type}: ${inst.contentType}`,
      `- ${LABELS.field_name}: ${inst.fieldName}`,
      `- ${LABELS.file_format}: ${inst.fileFormat}`,
    );
    if (inst.visibilityField) {
      lines.push(`- ${LABELS.visibility_field}: ${inst.visibilityField}`);
    }
    lines.push(`- ${LABELS.example}: ${inst.example}`);
  }

  return lines.join("\n");
}

/**
 * Format download token response
 */
export function formatDownloadToken(data: {
  token: string;
  expiresAt: string;
  downloadUrl: string;
}): string {
  return [
    "Download token created:",
    `${LABELS.token}: ${data.token}`,
    `${LABELS.expires}: ${data.expiresAt}`,
    `${LABELS.download_url}: ${data.downloadUrl}`,
  ].join("\n");
}

// ============================================
// Domain Error Formatting
// ============================================

/**
 * Format domain error with appropriate error code and agent instructions
 * Maps domain errors to MCP-friendly error responses with recovery guidance
 *
 * Error code mapping:
 * - 404 (Not Found) -> workflow_not_found or process_not_found
 * - 409 (Conflict) -> validation_failed (slug/handle conflict)
 * - 400 (Bad Request) -> validation_failed
 * - 403 (Forbidden) -> access_denied
 */
export function formatDomainError(error: unknown): string {
  if (!isDomainError(error)) {
    // Not a domain error, use auto-detection
    const message = error instanceof Error ? error.message : String(error);
    return formatErrorWithAgentInstructions(message);
  }

  const domainError = error as DomainError;
  const message = domainError.message;

  // Map domain error types to agent instruction categories
  if (isNotFoundError(error)) {
    // 404 errors - workflow or user not found
    if (message.toLowerCase().includes("workflow")) {
      return formatError(message, "workflow_troubleshooting", "workflow_not_found");
    } else {
      return formatError(message, "process_troubleshooting", "process_not_found");
    }
  }

  if (isConflictError(error)) {
    // 409 errors - slug or handle conflict
    return formatError(
      `${message}\n\nError code: ${domainError.code}`,
      "general",
      "validation_failed",
    );
  }

  if (isValidationError(error)) {
    // 400 errors - invalid slug or handle format
    return formatError(
      `${message}\n\nError code: ${domainError.code}`,
      "general",
      "validation_failed",
    );
  }

  // Access denied (403)
  if (domainError.httpStatus === 403) {
    return formatError(message, undefined, "access_denied");
  }

  // Default to unrecoverable for other domain errors
  return formatError(`${message}\n\nError code: ${domainError.code}`, undefined, "unrecoverable");
}
