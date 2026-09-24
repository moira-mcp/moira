/**
 * Centralized English messages for MCP tools
 * All user-facing strings in one place for consistency and future i18n
 *
 * Tool descriptions belong to the typed static registry. This module owns
 * operational result/error messages only.
 */

import {
  DomainError,
  isDomainError,
  isNotFoundError,
  isConflictError,
  isValidationError,
  getHost,
} from "@mcp-moira/shared";

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
  materialize_unavailable:
    "No materialize delivery is available. This action serves your own execution only while it " +
    "is paused on a materialize node and that node's five-minute window is still open.",

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
  workflow_revision_conflict: (expected: number, current: number) =>
    `Workflow revision conflict: expected ${expected}, stored ${current}. Read the workflow again and re-apply the changes`,

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
    `3. Configure your bot token and chat ID in Settings > Notifications\n\n` +
    `You can prepare the guided setup workflow with: start({ action: "prepare", workflowId: "moira/telegram-setup", parentExecutionId: "none", skipNotificationCheck: true }), then execute its returned Start attempt ID.\n\n` +
    `Or prepare this workflow without optional Telegram checks, then execute its returned Start attempt ID:\n` +
    `start({ action: "prepare", workflowId: "${workflowId}", skipNotificationCheck: true, parentExecutionId: "none" })`,

  preflight_completion_condition:
    "Configure Telegram integration via Settings > Notifications or the telegram-setup workflow, then start this workflow again. Or use skipNotificationCheck: true to proceed without Telegram notifications.",

  /** Handler error messages - shown to agents during workflow execution via messageQueue */
  handler_not_configured:
    'Telegram notifications are not configured. Set up in Settings > Notifications or prepare the guided setup workflow with start({ action: "prepare", workflowId: "moira/telegram-setup", parentExecutionId: "none", skipNotificationCheck: true }), then execute the returned Start attempt ID.',
  handler_chat_not_found:
    "Chat not found. You need to send any message to your bot first, then try again.",
  handler_invalid_token:
    "Bot token is invalid or expired. Get a new token from @BotFather and update it in Settings > Notifications.",
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
 * Agent instructions embedded in error messages to make the safe recovery boundary explicit.
 * An agent is told to stop only where resolving the condition needs a person: a permission, a
 * reconnection, a workflow the user must choose instead of, or an effect that may already have
 * happened. Every condition the agent can resolve on its own says how to resolve it.
 */
export const AGENT_INSTRUCTIONS = {
  stale_attempt: `
AGENT INSTRUCTIONS:
1. This stale attempt was rejected before workflow handler work
2. Call session({ action: 'current_step', executionId: '<Process ID>' }) automatically
3. Retry the intended step once with the Step attempt ID returned by current_step
Do NOT reuse the stale attempt ID. No user guidance is required for this recovery.`,

  processing_attempt: `
AGENT INSTRUCTIONS:
1. This exact workflow mutation still has a live owner
2. Retry with the same Process ID, attempt ID, and input
3. Reuse the stored result returned when the owner completes
Do NOT create a replacement attempt or change the input. No user guidance is required for this recovery.`,

  conflicting_attempt: `
AGENT INSTRUCTIONS:
1. This submission was rejected before workflow handler work because the attempt ID is already bound to different input
2. Call session({ action: 'current_step', executionId: '<Process ID>' }) automatically
3. Discard the rejected presentation and continue from the returned directive and input schema
Do NOT reuse the conflicting attempt ID or blindly apply its input to the current presentation. No user guidance is required unless the current directive requires a user decision.`,

  invalid_step_attempt: `
AGENT INSTRUCTIONS:
1. This step attempt was rejected before workflow handler work because it is unavailable
2. Call session({ action: 'current_step', executionId: '<Process ID>' }) automatically
3. Discard the unavailable presentation and continue from the returned directive and input schema
Do NOT reuse the unavailable attempt ID or blindly apply its input to the current presentation. No user guidance is required unless the current directive requires a user decision.`,

  recovery_refused: `
AGENT INSTRUCTIONS:
1. This run was NOT changed
2. Call session({ action: 'diagnose', executionId: '<Process ID>' }) and read the blocking causes
3. Call session({ action: 'recover', executionId: '<Process ID>', nodeId: '<node to resume from>', variableValues: { ... } }) again with what the refusal says is missing — unless the refusal says this run is already over, in which case there is nothing to retry
Recovery only touches a run that is trying to continue and cannot. A run the diagnosis reports continuable is refused on purpose: continue it with session current_step and step instead. A completed or cancelled run is refused too and stays finished: start a new run rather than retrying. Otherwise the refusal changed nothing, so retrying it costs nothing; ask the user only for a value you cannot determine yourself.`,

  // Optimistic concurrency: the call was rejected before any write because the state it was based
  // on changed; re-reading that state and retrying resolves it.
  stale_state: `
AGENT INSTRUCTIONS:
1. Nothing was changed: the state this call was based on changed after you read it
2. Re-read that state for its current revisions: session({ action: 'reminders' | 'variables' | 'execution_context', executionId: '<Process ID>' }), or the workflow itself for a workflow revision
3. Re-apply the intended change to the state you just read and retry with its current revisions
No user guidance is required unless the re-read state shows a conflicting change that needs a user decision.`,

  outcome_unknown: `
AGENT INSTRUCTIONS:
1. STOP before retrying this workflow mutation because its effects may already have occurred
2. Inspect the execution with session({ action: 'current_step', executionId: '<Process ID>' }) and session({ action: 'execution_context', executionId: '<Process ID>' })
3. Continue only from the observed current state; ask the user when resolving it requires a decision
Do NOT retry the mutation automatically. Do NOT treat a missing response as proof that no effect occurred.`,

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
1. Use session({ action: 'executions' }) to list your executions and their state
2. If the execution you meant is listed, continue it from session({ action: 'current_step', executionId: '<Process ID>' })
3. If it has ended or expired and the task still needs the workflow, start a new run with start()
Do NOT guess execution IDs. Tell the user only if an execution they gave you cannot be found or restarted.`,

  // Validation failed - agent should check schema and fix input
  validation_failed: `
AGENT INSTRUCTIONS:
1. Review what the call expects: for a workflow step, the inputSchema of the current directive (session({ action: 'current_step', executionId: '<Process ID>' }) returns it again); for any other tool, its parameters and the error details above
2. Correct your input so it matches the required structure exactly
3. Retry with the corrected input
Ask the user only when a required value is a fact or decision only the user can provide. Do NOT skip validation or submit placeholder values.`,

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

  // Any error no other category recognises
  unclassified: `
AGENT INSTRUCTIONS:
1. Read the error message above: it usually names what went wrong and what to do next
2. Diagnose with the available tools: help() for usage, session({ action: 'diagnose' | 'current_step' | 'execution_context', executionId: '<Process ID>' }) for a run, list() for workflows
3. Fix what lies within your task and authority, then retry the call
Ask the user only for a decision, permission, credential or fact you cannot obtain yourself, and then include the full error details. Do NOT repeat an unchanged failing call.`,
} as const;

/**
 * Error categories that map to specific agent instructions
 */
export type ErrorCategory =
  | "recovery_refused"
  | "stale_attempt"
  | "processing_attempt"
  | "conflicting_attempt"
  | "invalid_step_attempt"
  | "stale_state"
  | "outcome_unknown"
  | "workflow_not_found"
  | "process_not_found"
  | "validation_failed"
  | "auth_required"
  | "connection_error"
  | "access_denied"
  | "unclassified";

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
 * Agent instructions select the safe automatic or user-bound recovery for each error.
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

  if (
    lowerMessage.includes("attempt_outcome_unknown") ||
    // Raised after the step's handlers ran: the attempt is recorded as outcome-unknown.
    lowerMessage.includes("retry from current state")
  ) {
    agentCategory = "outcome_unknown";
  } else if (lowerMessage.includes("attempt_processing")) {
    agentCategory = "processing_attempt";
  } else if (lowerMessage.includes("attempt_conflict")) {
    agentCategory = "conflicting_attempt";
  } else if (
    lowerMessage.includes("attempt_invalid_or_expired") &&
    lowerMessage.includes("current_step")
  ) {
    agentCategory = "invalid_step_attempt";
  } else if (lowerMessage.includes("attempt_stale")) {
    agentCategory = "stale_attempt";
  } else if (
    // Matched before the not-found rules: these messages name an execution or a workflow too.
    /\breload\b/.test(lowerMessage) ||
    lowerMessage.includes("revision conflict") ||
    lowerMessage.includes(" is stale")
  ) {
    agentCategory = "stale_state";
  } else if (lowerMessage.includes("workflow") && lowerMessage.includes("not found")) {
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
    agentCategory = "unclassified";
  }

  return formatError(message, helpCategory, agentCategory);
}

/**
 * Present materialized files as one text block each, headed by the file's path.
 *
 * A JSON envelope would escape every body, which is precisely what makes a guide unreadable to the
 * agent this delivery exists for, so the bodies are carried verbatim and the path attribution
 * rides in a header line.
 */
export function formatMaterializeDelivery(
  files: Array<{ path: string; content: string }>,
): Array<{ type: "text"; text: string }> {
  const inventory = files.map((file) => `- ${JSON.stringify(file.path)}`).join("\n");
  return [
    {
      type: "text",
      text:
        `Materialized ${files.length} ${files.length === 1 ? "file" : "files"} into this response ` +
        `instead of onto a filesystem. Read every file below that a later directive requires, ` +
        `then complete the step normally.\n\nFiles:\n${inventory}`,
    },
    ...files.map((file) => ({
      type: "text" as const,
      text: `===== FILE: ${file.path} =====\n${file.content}`,
    })),
  ];
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

  return formatError(`${message}\n\nError code: ${domainError.code}`, undefined, "unclassified");
}
