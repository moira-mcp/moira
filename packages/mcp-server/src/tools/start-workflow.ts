/**
 * Start workflow function for direct import (no spawn)
 * Pure library function - no CLI behavior
 *
 * Architecture: "Throw Early, Catch Late, Log Once at Boundary"
 * - This is the MCP BOUNDARY - single place for logging MCP tool errors
 * - MCPEngine throws errors, this handler catches, logs, and formats response
 */

import { MCPEngine } from "../core/mcp-engine.js";
import { startRequestSchema } from "./tool-schemas.js";
import type { z } from "zod";
import { ToolResult } from "./interfaces/tool-interface.js";
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
import {
  checkTrustedLockDeliveryConfiguration,
  getActiveCommunicationChannelRegistry,
  probeCommunicationChannelConfiguration,
  workflowGraphDigest,
} from "@mcp-moira/workflow-engine";
import type {
  CommunicationChannelRegistry,
  DatabaseRepository,
  IDataRepository,
} from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "StartWorkflow" });

const MAX_NOTE_LENGTH = 500;

type StartWorkflowParams = z.infer<typeof startRequestSchema>;

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

export function workflowHasUserNotificationNodes(nodes: Array<{ type: string }>): boolean {
  return nodes.some((node) => node.type === "user-notification");
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

export function formatCommunicationPreflightResponse(workflowIdentifier: string): string {
  return (
    `Your next task: Configure at least one communication channel before starting workflow "${workflowIdentifier}". ` +
    `Open Settings > Notifications and complete an available channel. Telegram can also be configured through moira/telegram-setup. ` +
    `To continue without optional ordinary notifications, prepare a new attempt with start({ action: "prepare", workflowId: "${workflowIdentifier}", skipNotificationCheck: true, parentExecutionId: "none" }), then execute the returned Start attempt ID.\n\n` +
    `Success criteria: At least one channel is ready for the authenticated user, or the workflow is restarted with skipNotificationCheck: true.\n\n` +
    `No specific input format required. Send any data that fulfills the success criteria.`
  );
}

export async function hasConfiguredCommunicationChannel(
  registry: CommunicationChannelRegistry,
  repository: IDataRepository,
  userId: string,
  channelId?: string,
): Promise<boolean> {
  const selected = channelId ? registry.get(channelId) : undefined;
  const adapters = channelId ? (selected ? [selected] : []) : registry.list();
  const configuration = { get: <T>(key: string) => repository.getSetting<T>(userId, key) };
  const checks = await Promise.all(
    adapters.map(
      async (adapter) =>
        (await probeCommunicationChannelConfiguration(adapter, configuration)) === "configured",
    ),
  );
  return checks.some(Boolean);
}

export function resolveSkipNotificationCheck(params: {
  skipNotificationCheck?: boolean;
  skipTelegramCheck?: boolean;
}): boolean {
  if (
    params.skipNotificationCheck !== undefined &&
    params.skipTelegramCheck !== undefined &&
    params.skipNotificationCheck !== params.skipTelegramCheck
  ) {
    throw new Error("skipNotificationCheck and skipTelegramCheck must not disagree");
  }
  return params.skipNotificationCheck ?? params.skipTelegramCheck ?? false;
}

export function formatLockTelegramPreflightResponse(
  workflowIdentifier: string,
  reason: "missing" | "invalid",
): string {
  const configurationState = reason === "missing" ? "not configured" : "invalid";
  return (
    `Your next task: Configure Telegram before starting workflow "${workflowIdentifier}". ` +
    `This workflow contains lock nodes whose PIN delivery is mandatory, and the current Telegram configuration is ${configurationState}. ` +
    `Run moira/telegram-setup or configure a valid bot token and chat ID. skipNotificationCheck and its deprecated skipTelegramCheck alias cannot bypass trusted lock PIN delivery.\n\n` +
    `Success criteria: Telegram is configured for the authenticated user and the workflow can deliver lock PINs to that user's chat.\n\n` +
    `No specific input format required. Send any data that fulfills the success criteria.`
  );
}

export async function startWorkflow(rawParams: unknown): Promise<ToolResult<string>> {
  // Internal callers predating the public two-phase schema still use the exported library
  // function. Keep them on the same safe protocol by composing prepare and execute; MCP clients
  // cannot use this shape because the registered public schema requires action.
  if (
    rawParams &&
    typeof rawParams === "object" &&
    !("action" in rawParams) &&
    "workflowId" in rawParams
  ) {
    const legacy = rawParams as {
      workflowId: string;
      note?: string;
      parentExecutionId?: string;
      skipNotificationCheck?: boolean;
      skipTelegramCheck?: boolean;
    };
    const prepared = await startWorkflow({
      action: "prepare",
      workflowId: legacy.workflowId,
      note: legacy.note,
      parentExecutionId: legacy.parentExecutionId ?? "none",
      skipNotificationCheck: legacy.skipNotificationCheck,
      skipTelegramCheck: legacy.skipTelegramCheck,
    });
    if (!prepared.success || !prepared.data) return prepared;
    const startAttemptId = prepared.data.match(/Start attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    if (!startAttemptId) return prepared;
    return startWorkflow({ action: "execute", startAttemptId });
  }
  const params: StartWorkflowParams = startRequestSchema.parse(rawParams);
  let userId: string | undefined;

  try {
    userId = getUserContext().userId;
    const engine = MCPEngine.getInstance();

    if (params.action === "prepare") {
      if (
        params.parentExecutionId !== "none" &&
        !isExecutionParentReference(params.parentExecutionId)
      ) {
        throw new Error(ERRORS.parent_execution_id_invalid_format);
      }
      const data = await engine.prepareWorkflowStart(params.workflowId, {
        note: sanitizeNote(params.note) ?? null,
        parentExecutionId: params.parentExecutionId === "none" ? null : params.parentExecutionId,
        skipNotificationCheck: resolveSkipNotificationCheck(params),
      });
      return { success: true, data };
    }

    const prepared = await engine.getPreparedWorkflowStart(params.startAttemptId);
    if (prepared.attempt.state === "completed" && prepared.attempt.response !== null) {
      return { success: true, data: await engine.replayPreparedWorkflowStart(prepared.attempt) };
    }
    if (prepared.attempt.state === "outcome_unknown") {
      return { success: true, data: await engine.replayPreparedWorkflowStart(prepared.attempt) };
    }
    const resolved = await engine.repository.resolveWorkflow(prepared.attempt.workflowId, userId);
    const reject = async (reason: string): Promise<ToolResult<string>> => ({
      success: true,
      data: await engine.rejectPreparedWorkflowStart(
        params.startAttemptId,
        `START_PRECONDITION_CHANGED: ${reason} Prepare a new start attempt.`,
      ),
    });
    if (
      !resolved ||
      resolved.workflow.metadata.version !== prepared.attempt.workflowVersion ||
      workflowGraphDigest(resolved.workflow) !== prepared.attempt.workflowDigest
    ) {
      return reject("The workflow is unavailable or its version changed.");
    }
    if (prepared.payload.parentExecutionId) {
      try {
        await validateParentExecutionId(prepared.payload.parentExecutionId, userId);
      } catch {
        return reject("The parent process is unavailable, foreign, or no longer running.");
      }
    }
    if (workflowHasLockNodes(resolved.workflow.nodes)) {
      const trustedConfiguration = await checkTrustedLockDeliveryConfiguration(
        engine.repository,
        userId,
      );
      if (!trustedConfiguration.configured) {
        return reject(
          formatLockTelegramPreflightResponse(
            prepared.attempt.workflowId,
            trustedConfiguration.reason,
          ),
        );
      }
    }
    if (!prepared.payload.skipNotificationCheck) {
      if (
        workflowHasTelegramNodes(resolved.workflow.nodes) &&
        !(await hasConfiguredCommunicationChannel(
          getActiveCommunicationChannelRegistry(),
          engine.repository,
          userId,
          "telegram",
        ))
      ) {
        return reject(formatTelegramPreflightResponse(prepared.attempt.workflowId));
      }
      if (
        workflowHasUserNotificationNodes(resolved.workflow.nodes) &&
        !(await hasConfiguredCommunicationChannel(
          getActiveCommunicationChannelRegistry(),
          engine.repository,
          userId,
        ))
      ) {
        return reject(formatCommunicationPreflightResponse(prepared.attempt.workflowId));
      }
    }

    const formattedText = await engine.executePreparedWorkflowStart(
      params.startAttemptId,
      resolved.workflow,
      { workflowIdentifier: prepared.attempt.workflowId, slug: resolved.slug },
    );

    return { success: true, data: formattedText };
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to start workflow", appError, {
      workflowId: params.action === "prepare" ? params.workflowId : "prepared-start",
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Log failed start attempts to audit trail
    // This covers: validation errors, workflow not found, access denied, etc.
    if (userId) {
      await logStartAttempt(
        userId,
        params.action === "prepare" ? params.workflowId : "prepared-start",
        error as Error,
        params.action === "prepare" ? params.note : undefined,
        params.action === "prepare" ? params.parentExecutionId : undefined,
      );
      if (params.action === "execute") {
        const candidate = appError.context?.attemptOutcome;
        const outcome =
          candidate === "processing" ||
          candidate === "outcome_unknown" ||
          candidate === "conflicting_replay" ||
          candidate === "safe_replay" ||
          candidate === "original"
            ? candidate
            : "stale_rejection";
        await MCPEngine.getInstance().recordRejectedStartAttempt(
          outcome,
          appError.context?.attemptMetricRecorded !== true,
        );
      }
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
