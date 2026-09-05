/**
 * Start workflow function for direct import (no spawn)
 * Pure library function - no CLI behavior
 *
 * Architecture: "Throw Early, Catch Late, Log Once at Boundary"
 * - This is the MCP BOUNDARY - single place for logging MCP tool errors
 * - MCPEngine throws errors, this handler catches, logs, and formats response
 */

import { MCPEngine } from "../core/mcp-engine.js";
import { ToolResult, WorkflowSpecificParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import {
  formatError,
  formatErrorWithAgentInstructions,
  formatDomainError,
  ERRORS,
  TELEGRAM,
} from "../messages/index.js";
import {
  createLogger,
  NotFoundError,
  isOperationalError,
  normalizeError,
  logAuditEventDirect,
  AuditAction,
  isExecutionParentReference,
} from "@mcp-moira/shared";
import { checkTrustedLockDeliveryConfiguration } from "@mcp-moira/workflow-engine";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "StartWorkflow" });

const MAX_NOTE_LENGTH = 500;

interface StartWorkflowParams extends WorkflowSpecificParams {
  workflowId: string;
  note?: string;
  parentExecutionId: string; // Required: "none" for standalone, UUID for child workflows
  skipTelegramCheck?: boolean; // Skip pre-flight Telegram configuration check
}

/**
 * Validate and sanitize note parameter
 * - Trims whitespace
 * - Truncates to MAX_NOTE_LENGTH if needed
 * - Returns undefined if empty
 */
function sanitizeNote(note?: string): string | undefined {
  if (!note) return undefined;
  const trimmed = note.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_NOTE_LENGTH);
}

/**
 * Validate parentExecutionId parameter
 * - "none" is accepted for standalone workflows
 * - Valid UUID must reference existing execution
 * - Returns undefined for "none", throws on invalid
 */
async function validateParentExecutionId(
  parentExecutionId: string,
  userId: string,
): Promise<string | undefined> {
  // "none" means standalone workflow - no parent
  if (parentExecutionId === "none") {
    return undefined;
  }

  // Validate UUID format
  if (!isExecutionParentReference(parentExecutionId)) {
    throw new Error(ERRORS.parent_execution_id_invalid_format);
  }

  // Check execution exists
  const engine = MCPEngine.getInstance();
  const execution = await engine.repository.getExecution(parentExecutionId);
  if (!execution) {
    throw new Error(ERRORS.parent_execution_not_found(parentExecutionId));
  }
  if (execution.userId !== userId) {
    throw new Error("Parent execution must belong to the authenticated user");
  }
  if (execution.status !== "running") {
    throw new Error("Parent execution must be running");
  }

  return parentExecutionId;
}

/**
 * Log failed start attempt to audit trail
 * Covers all error types: validation, not found, access denied, etc.
 */
async function logStartAttempt(
  userId: string,
  workflowId: string,
  error: Error,
  note?: string,
  parentExecutionId?: string,
): Promise<void> {
  try {
    // Determine error code based on error type
    let errorCode = "UNKNOWN_ERROR";
    if (error instanceof NotFoundError || error.message.includes("not found")) {
      errorCode = "NOT_FOUND";
    } else if (
      error.message.includes("parentExecutionId") ||
      error.message.includes("Invalid format")
    ) {
      errorCode = "VALIDATION_ERROR";
    } else if (error.message.includes("Access denied") || error.message.includes("Forbidden")) {
      errorCode = "ACCESS_DENIED";
    }

    const engine = MCPEngine.getInstance();
    await logAuditEventDirect(engine.repository as DatabaseRepository, {
      userId,
      action: AuditAction.WORKFLOW_START_ATTEMPT,
      resource: "workflow",
      resourceId: workflowId,
      metadata: {
        workflowId,
        note,
        parentExecutionId,
        errorMessage: error.message,
        errorCode,
      },
    });
  } catch (auditError) {
    logger.warn("Failed to log start attempt to audit trail", {
      error: String(auditError),
    });
  }
}

/**
 * Check if a workflow contains telegram-notification nodes
 */
export function workflowHasTelegramNodes(nodes: Array<{ type: string }>): boolean {
  return nodes.some((node) => node.type === "telegram-notification");
}

export function workflowHasLockNodes(nodes: Array<{ type: string }>): boolean {
  return nodes.some((node) => node.type === "lock");
}

/**
 * Format synthetic pre-flight response for workflows with unconfigured Telegram.
 * Mimics the real directive format but no execution is created in DB.
 */
export function formatTelegramPreflightResponse(workflowIdentifier: string): string {
  return (
    `Your next task: ${TELEGRAM.preflight_directive(workflowIdentifier)}\n\n` +
    `Success criteria: ${TELEGRAM.preflight_completion_condition}\n\n` +
    `No specific input format required. Send any data that fulfills the success criteria.`
  );
}

export function formatLockTelegramPreflightResponse(
  workflowIdentifier: string,
  reason: "missing" | "invalid",
): string {
  const configurationState = reason === "missing" ? "not configured" : "invalid";
  return (
    `Your next task: Configure Telegram before starting workflow "${workflowIdentifier}". ` +
    `This workflow contains lock nodes whose PIN delivery is mandatory, and the current Telegram configuration is ${configurationState}. ` +
    `Run moira/telegram-setup or configure a valid bot token and chat ID. skipTelegramCheck cannot bypass trusted lock PIN delivery.\n\n` +
    `Success criteria: Telegram is configured for the authenticated user and the workflow can deliver lock PINs to that user's chat.\n\n` +
    `No specific input format required. Send any data that fulfills the success criteria.`
  );
}

export async function startWorkflow(params: StartWorkflowParams): Promise<ToolResult<string>> {
  let userId: string | undefined;

  try {
    // Get authenticated user context
    const context = getUserContext();
    userId = context.userId;

    // Validate parentExecutionId (required field)
    const validatedParentId = await validateParentExecutionId(params.parentExecutionId, userId);

    // Sanitize note
    const sanitizedNote = sanitizeNote(params.note);

    const engine = MCPEngine.getInstance();

    // Resolve once so lock delivery can remain mandatory even when ordinary
    // notification pre-flight is explicitly skipped.
    const resolved = await engine.repository.resolveWorkflow(params.workflowId, userId);
    if (resolved) {
      if (workflowHasLockNodes(resolved.workflow.nodes)) {
        const trustedConfiguration = await checkTrustedLockDeliveryConfiguration(
          engine.repository,
          userId,
        );
        if (!trustedConfiguration.configured) {
          logger.info("Trusted lock delivery pre-flight check failed", {
            workflowId: params.workflowId,
            userId,
            reason: trustedConfiguration.reason,
          });
          return {
            success: true,
            data: formatLockTelegramPreflightResponse(
              params.workflowId,
              trustedConfiguration.reason,
            ),
          };
        }
      } else if (!params.skipTelegramCheck && workflowHasTelegramNodes(resolved.workflow.nodes)) {
        const botToken = await engine.repository.getSetting<string>(userId, "telegram.bot_token");
        const chatId = await engine.repository.getSetting<string>(userId, "telegram.chat_id");

        if (!botToken || !chatId) {
          logger.info("Telegram pre-flight check: not configured", {
            workflowId: params.workflowId,
            userId,
            hasBotToken: !!botToken,
            hasChatId: !!chatId,
          });
          return {
            success: true,
            data: formatTelegramPreflightResponse(params.workflowId),
          };
        }
      }
    }

    // Use singleton MCPEngine for shared state management
    // Note: MCPEngine.startWorkflow handles its own WORKFLOW_START_ATTEMPT logging for errors
    const formattedText = await engine.startWorkflow(
      params.workflowId,
      sanitizedNote,
      validatedParentId,
    );

    return { success: true, data: formattedText };
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to start workflow", appError, {
      workflowId: params.workflowId,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Log failed start attempts to audit trail
    // This covers: validation errors, workflow not found, access denied, etc.
    if (userId) {
      await logStartAttempt(
        userId,
        params.workflowId,
        error as Error,
        params.note,
        params.parentExecutionId,
      );
    }

    // Add contextual hints and AGENT INSTRUCTIONS based on error type
    let enhancedError: string;

    if (appError instanceof NotFoundError) {
      // Check if it's workflow not found or parent execution not found
      if (appError.message.includes("Parent execution")) {
        enhancedError = formatError(
          appError.message,
          "process_troubleshooting",
          "process_not_found",
        );
      } else {
        enhancedError = formatError(
          appError.message,
          "workflow_troubleshooting",
          "workflow_not_found",
        );
      }
    } else if (
      appError.message.includes("already running") ||
      appError.message.includes("in progress")
    ) {
      enhancedError = `${appError.message}\n\nHint: Use session({ action: 'executions' }) to see active executions`;
      enhancedError = formatErrorWithAgentInstructions(enhancedError);
    } else {
      // Use domain error formatting which handles slug/handle errors with proper codes
      enhancedError = formatDomainError(error);
    }

    return {
      success: false,
      error: enhancedError,
    };
  }
}
